#!/usr/bin/env python3
"""
Build/update a Qualtrics survey with a chat UI question.

ROBUST VERSION:
- Looks up surveys by ID (not name) for efficiency
- Adds request timeouts, retries with backoff for transient Qualtrics/API failures
- Greatly improves error logging (Qualtrics requestId/errorCode, rate-limit headers, body snippets)
- Emits GitHub Actions step summary + optional annotations (when running in Actions)
"""

from __future__ import annotations

import os
import sys
import logging
import json
import re
import time
import random
import uuid
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

# =========================
# LOGGING SETUP
# =========================

RUN_ID = os.environ.get("RUN_ID") or uuid.uuid4().hex[:8]

class _RunIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.run_id = RUN_ID
        return True

log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=log_level,
    format="%(asctime)s [%(levelname)s] [run=%(run_id)s] %(message)s",
    datefmt="%H:%M:%S",
)
for _h in logging.getLogger().handlers:
    _h.addFilter(_RunIdFilter())
logger = logging.getLogger(__name__)

# =========================
# GITHUB ACTIONS HELPERS
# =========================

def _in_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS", "").lower() == "true"

def _append_step_summary(markdown: str) -> None:
    """Append markdown to the GitHub Actions step summary, if available."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(markdown.rstrip() + "\n")
    except Exception:
        logger.debug("Failed writing to GITHUB_STEP_SUMMARY", exc_info=True)

def _gh_annotate(level: str, title: str, message: str) -> None:
    """
    Emit GitHub Actions workflow command annotations.
    level: error|warning|notice
    """
    if not _in_github_actions():
        return
    safe = message.replace("\r", " ").replace("\n", " ")
    print(f"::{level} title={title}::{safe}")

# =========================
# SMALL UTILS
# =========================

def _truncate(s: str, limit: int = 2000) -> str:
    if s is None:
        return ""
    s = str(s)
    if len(s) <= limit:
        return s
    return s[:limit] + f"...(truncated, {len(s)} chars)"

def _sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]

# =========================
# CONFIGURATION
# =========================

def normalize_question_token(question_name: str) -> str:
    token = re.sub(r"\W+", "_", question_name).strip("_")
    return token or "chat_ui"

def get_config() -> Dict[str, Any]:
    script_dir = Path(__file__).parent
    question_name = os.environ.get("QUESTION_NAME", "chat_ui")
    question_token = normalize_question_token(question_name)

    config = {
        "data_center": os.environ.get("QUALTRICS_DATA_CENTER", "yul1"),
        "api_token": os.environ.get("QUALTRICS_API_TOKEN", ""),
        "survey_id": os.environ.get("SURVEY_ID", ""),
        "question_name": question_name,
        "question_token": question_token,
        "proxy_url": os.environ.get("PROXY_URL", ""),
        "html_path": script_dir / "view.html",
        "css_path": script_dir / "styling.css",
        "js_path": script_dir / "questions.js",
        "data_export_tag": question_name,

        # Robustness knobs (env overridable)
        "timeout_connect": float(os.environ.get("QUALTRICS_TIMEOUT_CONNECT", "10")),
        "timeout_read": float(os.environ.get("QUALTRICS_TIMEOUT_READ", "60")),
        "max_attempts": int(os.environ.get("QUALTRICS_MAX_ATTEMPTS", "5")),
    }

    safe_config = config.copy()
    safe_config["api_token"] = "********" if config["api_token"] else "(missing)"
    safe_config["proxy_url"] = "(set)" if config["proxy_url"] else "(missing)"
    logger.info("Loaded Configuration:\n%s", json.dumps(safe_config, indent=2, default=str))

    _append_step_summary(
        "### Qualtrics Survey Builder\n"
        f"- Run ID: `{RUN_ID}`\n"
        f"- Survey ID: `{config['survey_id']}`\n"
        f"- Question name: `{config['question_name']}`\n"
        f"- Log level: `{log_level}`\n"
    )
    return config

def get_shared_fields() -> Dict[str, str]:
    fields = {"proxy_url": os.environ.get("PROXY_URL", "")}
    logger.info("Shared fields loaded. Proxy URL present: %s", bool(fields["proxy_url"]))
    return fields

def get_question_fields(question_token: str) -> Dict[str, str]:
    prefix = f"{question_token}_"
    fields = {
        f"{prefix}model": os.environ.get("MODEL", "gpt-4o"),
        f"{prefix}prompt": os.environ.get("PROMPT", "You are a helpful assistant"),
        f"{prefix}temperature": os.environ.get("TEMPERATURE", "1"),
        f"{prefix}max_tokens": os.environ.get("MAX_TOKENS", "1000"),
        f"{prefix}max_chats": os.environ.get("MAX_CHATS", "99"),
        f"{prefix}delay_per_word": os.environ.get("DELAY_PER_WORD", "0.1"),
        f"{prefix}chat_history": "",
        f"{prefix}chat_question_id": "",
    }
    logger.info("Question fields loaded for token '%s' (prefix: '%s').", question_token, prefix)
    verbose_field_logs = os.environ.get("VERBOSE_FIELD_LOGS", "false").lower() == "true"
    if logger.isEnabledFor(logging.DEBUG) and verbose_field_logs:
        logger.debug("Question field details:\n%s", json.dumps(fields, indent=2))
    return fields

# =========================
# INPUT VALIDATION
# =========================

def validate_inputs(config: Dict[str, Any], question_data: Dict[str, str], shared_data: Dict[str, str]) -> None:
    errors: List[str] = []
    prefix = config["question_token"] + "_"

    survey_id = config.get("survey_id", "").strip()
    if not survey_id:
        errors.append("survey_id must be a non-empty string (set SURVEY_ID env var)")
    elif not re.fullmatch(r"SV_[a-zA-Z0-9]{10,20}", survey_id):
        errors.append(
            f"survey_id looks malformed (got {survey_id!r}). "
            "Expected format: 'SV_' followed by 10-20 alphanumeric characters "
            "(e.g. 'SV_5AvE1COjfK7FrHT'). "
            "Copy the Survey ID from Qualtrics → Survey → Settings → Survey ID."
        )

    if not config.get("question_name", "").strip():
        errors.append("question_name must be a non-empty string")

    if not question_data.get(f"{prefix}prompt", "").strip():
        errors.append("prompt must be a non-empty string")
    if not question_data.get(f"{prefix}model", "").strip():
        errors.append("model must be a non-empty string")
    if not shared_data.get("proxy_url", "").strip():
        errors.append("proxy_url must be a non-empty string")

    temp_raw = question_data.get(f"{prefix}temperature", "")
    try:
        t = float(temp_raw)
        if not (0.0 <= t <= 2.0):
            errors.append(f"temperature must be between 0.0 and 2.0, got {t}")
    except (ValueError, TypeError):
        errors.append(f"temperature must be a valid number, got {temp_raw!r}")

    mt_raw = question_data.get(f"{prefix}max_tokens", "")
    try:
        mt = int(mt_raw)
        if mt <= 0:
            errors.append(f"max_tokens must be a positive integer, got {mt}")
    except (ValueError, TypeError):
        errors.append(f"max_tokens must be a valid integer, got {mt_raw!r}")

    mc_raw = question_data.get(f"{prefix}max_chats", "")
    try:
        mc = int(mc_raw)
        if mc <= 0:
            errors.append(f"max_chats must be a positive integer, got {mc}")
    except (ValueError, TypeError):
        errors.append(f"max_chats must be a valid integer, got {mc_raw!r}")

    dpw_raw = question_data.get(f"{prefix}delay_per_word", "")
    try:
        dpw = float(dpw_raw)
        if dpw < 0:
            errors.append(f"delay_per_word must be non-negative, got {dpw}")
    except (ValueError, TypeError):
        errors.append(f"delay_per_word must be a valid number, got {dpw_raw!r}")

    if errors:
        for e in errors:
            logger.error("Validation error: %s", e)
        raise ValueError("Input validation failed:\n  " + "\n  ".join(errors))

    logger.info("All inputs validated successfully.")

# =========================
# EMBEDDED DATA HELPERS
# =========================

def generate_embedded_data_fields(defaults: Dict[str, Any]) -> List[Dict[str, str]]:
    fields = []
    for key, value in sorted(defaults.items()):
        val_str = str(value) if value is not None else ""
        fields.append({"key": key, "value": val_str, "type": "text"})
    return fields

def validate_embedded_field_keys(fields: List[Dict[str, str]]) -> None:
    logger.info("Validating embedded data keys...")
    seen = set()
    for f in fields:
        key = f.get("key", "")
        if not key or " " in key:
            logger.error("Invalid key found: '%s'", key)
            raise ValueError(f"Invalid embedded field key: {key!r}")
        if key in seen:
            logger.error("Duplicate key found: '%s'", key)
            raise ValueError(f"Duplicate embedded field key: {key}")
        seen.add(key)
    logger.info("Validation successful.")

# =========================
# FILE HELPERS
# =========================

def read_text_file(path: Path) -> str:
    logger.debug("Reading file: %s", path)
    if not path.exists():
        logger.critical("File not found: %s", path.resolve())
        raise FileNotFoundError(f"Missing required file: {path.resolve()}")
    text = path.read_text(encoding="utf-8")
    logger.debug("Read %s bytes from %s", len(text.encode("utf-8")), path.name)
    return text

def build_question_html(html_path: Path, css_path: Path, js_path: Path, question_name: str, question_token: str) -> str:
    logger.info("Compiling HTML/CSS/JS assets for question '%s' (token '%s')...", question_name, question_token)
    html = read_text_file(html_path)
    css = read_text_file(css_path)
    js = read_text_file(js_path)

    html = html.replace("__QN__", f"{question_token}_").replace("__QNSAFE__", question_token)
    css = css.replace("__QNSAFE__", question_token)
    js = js.replace("__QN__", f"{question_token}_").replace("__QNSAFE__", question_token).replace("__QUESTION_NAME__", question_name)

    logger.info("Assets templated. (HTML sha=%s, CSS sha=%s, JS sha=%s)", _sha256(html), _sha256(css), _sha256(js))
    return f"<style>\n{css}\n</style>\n\n{html}\n\n<script>\n{js}\n</script>\n"

# =========================
# QUALTRICS CLIENT + ERRORS
# =========================

class QualtricsAPIError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        method: str,
        url: str,
        status_code: Optional[int] = None,
        request_id: Optional[str] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        http_status: Optional[str] = None,
        response_snippet: Optional[str] = None,
        attempt: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.method = method
        self.url = url
        self.status_code = status_code
        self.request_id = request_id
        self.error_code = error_code
        self.error_message = error_message
        self.http_status = http_status
        self.response_snippet = response_snippet
        self.attempt = attempt
        self.max_attempts = max_attempts

    def to_markdown(self) -> str:
        lines = [
            "### Qualtrics API Error",
            f"- Method: `{self.method}`",
            f"- URL: `{self.url}`",
        ]
        if self.status_code is not None:
            lines.append(f"- HTTP status: `{self.status_code}`")
        if self.http_status:
            lines.append(f"- Qualtrics httpStatus: `{self.http_status}`")
        if self.error_code:
            lines.append(f"- errorCode: `{self.error_code}`")
        if self.request_id:
            lines.append(f"- requestId: `{self.request_id}`")
        if self.error_message:
            lines.append(f"- errorMessage: `{self.error_message}`")
        if self.attempt and self.max_attempts:
            lines.append(f"- attempt: `{self.attempt}/{self.max_attempts}`")
        if self.response_snippet:
            lines.append(
                "\n<details><summary>Response snippet</summary>\n\n```json\n"
                + self.response_snippet
                + "\n```\n</details>"
            )
        return "\n".join(lines) + "\n"

@dataclass(frozen=True)
class QualtricsClient:
    base_url: str
    api_token: str
    timeout: Tuple[float, float]
    max_attempts: int

    def __post_init__(self):
        sess = requests.Session()
        sess.headers.update({
            "X-API-TOKEN": self.api_token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"qualtrics-survey-builder/{RUN_ID}",
        })
        object.__setattr__(self, "session", sess)

    def _extract_meta(self, resp: requests.Response) -> Dict[str, Any]:
        try:
            payload = resp.json()
            meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
            return meta if isinstance(meta, dict) else {}
        except Exception:
            return {}

    def _log_rate_limit_headers(self, resp: requests.Response) -> None:
        keys = [
            "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset",
            "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
            "Retry-After",
        ]
        present = {k: resp.headers.get(k) for k in keys if resp.headers.get(k) is not None}
        if present:
            logger.debug("Rate/Retry headers: %s", present)

    def _sleep_backoff(self, attempt: int, retry_after: Optional[str]) -> float:
        if retry_after and retry_after.isdigit():
            return float(retry_after)
        base = float(os.environ.get("QUALTRICS_RETRY_BACKOFF_BASE", "1.0"))
        cap = float(os.environ.get("QUALTRICS_RETRY_BACKOFF_CAP", "30.0"))
        jitter = random.random()
        return min(cap, base * (2 ** (attempt - 1)) + jitter)

    def _req(self, method: str, path_or_url: str, **kwargs) -> requests.Response:
        method_u = method.upper()
        idempotent = method_u in {"GET", "HEAD", "OPTIONS", "PUT", "DELETE"}

        url = path_or_url
        if not (url.startswith("http://") or url.startswith("https://")):
            url = f"{self.base_url}{path_or_url}"

        timeout = kwargs.pop("timeout", self.timeout)
        max_attempts = int(kwargs.pop("max_attempts", self.max_attempts))

        if logger.isEnabledFor(logging.DEBUG):
            if "json" in kwargs and isinstance(kwargs["json"], dict):
                logger.debug("API PAYLOAD keys: %s", list(kwargs["json"].keys()))

        for attempt in range(1, max_attempts + 1):
            t0 = time.monotonic()
            logger.debug("API REQUEST: %s %s (attempt %d/%d)", method_u, url, attempt, max_attempts)

            try:
                resp = self.session.request(method_u, url, timeout=timeout, **kwargs)
            except (requests.Timeout, requests.ConnectionError) as e:
                dt = time.monotonic() - t0
                logger.warning("Network error after %.1fs: %s (%s)", dt, type(e).__name__, str(e))
                if idempotent and attempt < max_attempts:
                    sleep_s = self._sleep_backoff(attempt, None)
                    logger.warning("Retrying in %.1fs...", sleep_s)
                    time.sleep(sleep_s)
                    continue
                raise QualtricsAPIError(
                    f"Network error calling Qualtrics: {type(e).__name__}",
                    method=method_u,
                    url=url,
                    attempt=attempt,
                    max_attempts=max_attempts,
                ) from e

            dt = time.monotonic() - t0
            logger.debug("API RESPONSE: %s %s (%.1fs)", resp.status_code, resp.reason, dt)
            self._log_rate_limit_headers(resp)

            if idempotent and resp.status_code in {429, 500, 502, 503, 504} and attempt < max_attempts:
                meta = self._extract_meta(resp)
                rid = meta.get("requestId")
                err = meta.get("error") or {}
                err_code = err.get("errorCode") if isinstance(err, dict) else None
                err_msg = err.get("errorMessage") if isinstance(err, dict) else None
                logger.warning(
                    "Transient Qualtrics error %s for %s %s (requestId=%s errorCode=%s).",
                    resp.status_code, method_u, url, rid, err_code
                )
                if err_msg:
                    logger.warning("Qualtrics message: %s", err_msg)
                sleep_s = self._sleep_backoff(attempt, resp.headers.get("Retry-After"))
                logger.warning("Retrying in %.1fs (attempt %d/%d)...", sleep_s, attempt, max_attempts)
                time.sleep(sleep_s)
                continue

            if not resp.ok:
                meta = self._extract_meta(resp)
                rid = meta.get("requestId")
                http_status = meta.get("httpStatus")
                err = meta.get("error") or {}
                err_code = err.get("errorCode") if isinstance(err, dict) else None
                err_msg = err.get("errorMessage") if isinstance(err, dict) else None

                logger.error("Qualtrics HTTP error: %s %s -> %s %s", method_u, url, resp.status_code, resp.reason)
                if rid or err_code or err_msg:
                    logger.error("Qualtrics meta: requestId=%s httpStatus=%s errorCode=%s", rid, http_status, err_code)
                    if err_msg:
                        logger.error("Qualtrics errorMessage: %s", err_msg)

                snippet = _truncate(resp.text, 3000)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("Response body (truncated): %s", snippet)

                raise QualtricsAPIError(
                    f"Qualtrics API request failed: {resp.status_code} {resp.reason}",
                    method=method_u,
                    url=url,
                    status_code=resp.status_code,
                    request_id=rid,
                    error_code=err_code,
                    error_message=err_msg,
                    http_status=http_status,
                    response_snippet=snippet,
                    attempt=attempt,
                    max_attempts=max_attempts,
                )

            return resp

        raise QualtricsAPIError(
            "Qualtrics request failed after retries.",
            method=method_u,
            url=url,
            attempt=max_attempts,
            max_attempts=max_attempts,
        )

    # ---- Survey operations ----

    def get_survey_definition(self, survey_id: str) -> Dict[str, Any]:
        return self._req("GET", f"/survey-definitions/{survey_id}").json()["result"]

    def verify_survey_exists(self, survey_id: str) -> Dict[str, Any]:
        """Single API call to confirm the survey exists. Raises a clear error if not."""
        try:
            definition = self.get_survey_definition(survey_id)
            logger.info("Survey %s verified (name: '%s').", survey_id, definition.get("SurveyName", "?"))
            return definition
        except QualtricsAPIError as e:
            if e.status_code == 403:
                raise QualtricsAPIError(
                    f"Access denied for survey '{survey_id}' (403 Forbidden). "
                    f"Please verify: "
                    f"(1) the SURVEY_ID matches the one in Qualtrics → Survey → Settings, "
                    f"(2) the API token owner has collaborator access to this survey, "
                    f"(3) the DATA_CENTER ('{self.base_url.split('//')[1].split('.')[0]}') "
                    f"matches your Qualtrics account region.",
                    method=e.method,
                    url=e.url,
                    status_code=e.status_code,
                    request_id=e.request_id,
                    error_code=e.error_code,
                    error_message=e.error_message,
                    http_status=e.http_status,
                    response_snippet=e.response_snippet,
                ) from e
            if e.status_code in (404, 400):
                raise QualtricsAPIError(
                    f"Survey '{survey_id}' not found. Verify the SURVEY_ID input is correct "
                    f"and that the API token has access to this survey.",
                    method=e.method,
                    url=e.url,
                    status_code=e.status_code,
                    request_id=e.request_id,
                    error_code=e.error_code,
                    error_message=e.error_message,
                    http_status=e.http_status,
                    response_snippet=e.response_snippet,
                ) from e
            raise

    # ---- Question operations ----

    def get_question(self, survey_id: str, question_id: str) -> Dict[str, Any]:
        return self._req("GET", f"/survey-definitions/{survey_id}/questions/{question_id}").json()["result"]

    def find_question_ids_by_tag(self, survey_id: str, tag: str) -> List[str]:
        definition = self.get_survey_definition(survey_id)
        questions = definition.get("Questions", {})
        if isinstance(questions, list):
            questions = {}
        found: List[str] = []
        for qid, q in (questions or {}).items():
            if isinstance(q, dict) and q.get("DataExportTag") == tag:
                found.append(qid)
        return found

    def find_question_id_by_tag(self, survey_id: str, tag: str) -> Optional[str]:
        ids = self.find_question_ids_by_tag(survey_id, tag)
        if not ids:
            return None
        if len(ids) > 1:
            raise RuntimeError(
                f"Multiple questions in survey {survey_id} share DataExportTag '{tag}': {ids}. "
                "Please use a unique QUESTION_NAME (or unique tag)."
            )
        return ids[0]

    def update_question_text(self, survey_id: str, question_id: str, new_text: str) -> None:
        logger.info("Updating text for question %s...", question_id)
        q = self.get_question(survey_id, question_id)
        q["QuestionText"] = new_text
        self._req("PUT", f"/survey-definitions/{survey_id}/questions/{question_id}", json=q)
        logger.info("Question %s updated.", question_id)

    def create_descriptive_question(
        self,
        survey_id: str,
        question_text: str,
        tag: str,
        block_id: Optional[str] = None,
    ) -> str:
        logger.info(
            "Creating new descriptive question with tag '%s'%s...",
            tag,
            f" in block {block_id}" if block_id else "",
        )
        payload = {
            "QuestionText": question_text,
            "DataExportTag": tag,
            "QuestionType": "DB",
            "Selector": "TB",
            "SubSelector": "TX",
            "Configuration": {"QuestionDescriptionOption": "UseText"},
        }
        # Some surveys (e.g. those created from imports/templates) lack a
        # default block, in which case Qualtrics rejects POST /questions
        # without an explicit blockId with ESRV119 "Invalid Block ID".
        params = {"blockId": block_id} if block_id else None
        resp = self._req(
            "POST",
            f"/survey-definitions/{survey_id}/questions",
            json=payload,
            params=params,
        ).json()
        qid = resp["result"]["QuestionID"]
        logger.info("Created question %s", qid)
        return qid

    # ---- Flow operations ----

    def get_flow(self, survey_id: str) -> Dict[str, Any]:
        return self._req("GET", f"/survey-definitions/{survey_id}/flow").json()["result"]

    def update_flow(self, survey_id: str, flow: Dict[str, Any]) -> None:
        logger.info("Pushing updated Survey Flow to Qualtrics...")
        self._req("PUT", f"/survey-definitions/{survey_id}/flow", json=flow)
        logger.info("Flow update successful.")

    # ---- Block operations ----

    def get_blocks(self, survey_id: str) -> Dict[str, Any]:
        definition = self.get_survey_definition(survey_id)
        blocks = definition.get("Blocks", {})
        if isinstance(blocks, list):
            blocks = {}
        return blocks

    def create_block(self, survey_id: str, description: str) -> str:
        logger.info("Creating new block '%s'...", description)
        payload = {"Type": "Standard", "Description": description}
        resp = self._req("POST", f"/survey-definitions/{survey_id}/blocks", json=payload).json()
        block_id = resp["result"]["BlockID"]
        logger.info("Created block %s", block_id)
        return block_id

    def update_block(self, survey_id: str, block_id: str, payload: Dict[str, Any]) -> None:
        logger.info("Updating block %s...", block_id)
        self._req("PUT", f"/survey-definitions/{survey_id}/blocks/{block_id}", json=payload)
        logger.info("Block %s updated.", block_id)

# =========================
# HIGH-LEVEL WORKFLOW
# =========================

def ensure_survey(client: QualtricsClient, config: Dict[str, Any]) -> str:
    survey_id = config["survey_id"]
    definition = client.verify_survey_exists(survey_id)
    survey_name = definition.get("SurveyName", "?")
    _append_step_summary(f"- Verified survey: `{survey_name}` (SurveyID: `{survey_id}`)\n")
    return survey_id

CHATBOT_BLOCK_DESCRIPTION = "AI Chatbot"

def _find_or_create_chatbot_block(client: QualtricsClient, survey_id: str) -> Tuple[str, bool]:
    """Find the 'AI Chatbot' block, creating it if missing.

    Returns (block_id, created_new). Used to ensure a valid blockId exists
    before POST /questions, since surveys without a default block reject
    blockless question creation with ESRV119 ("Invalid Block ID").
    """
    all_blocks = client.get_blocks(survey_id)
    for bid, bdata in all_blocks.items():
        if (bdata.get("Description") or "") == CHATBOT_BLOCK_DESCRIPTION:
            logger.info("Found existing '%s' block: %s", CHATBOT_BLOCK_DESCRIPTION, bid)
            return bid, False
    logger.info("No '%s' block found — creating one.", CHATBOT_BLOCK_DESCRIPTION)
    block_id = client.create_block(survey_id, CHATBOT_BLOCK_DESCRIPTION)
    return block_id, True

def ensure_chat_question(client: QualtricsClient, survey_id: str, config: Dict[str, Any]) -> Tuple[str, bool]:
    tag = config["data_export_tag"]
    question_name = config["question_name"]
    question_token = config["question_token"]

    desired_text = build_question_html(
        html_path=config["html_path"],
        css_path=config["css_path"],
        js_path=config["js_path"],
        question_name=question_name,
        question_token=question_token,
    )

    existing_qid = client.find_question_id_by_tag(survey_id, tag)
    if existing_qid:
        q = client.get_question(survey_id, existing_qid)
        current_text = q.get("QuestionText", "") or ""

        if current_text != desired_text:
            logger.warning(
                "Question %s content mismatch (current len=%d sha=%s; desired len=%d sha=%s). Updating...",
                existing_qid, len(current_text), _sha256(current_text), len(desired_text), _sha256(desired_text)
            )
            client.update_question_text(survey_id, existing_qid, desired_text)
        else:
            logger.info("Question %s is up to date. (len=%d sha=%s)", existing_qid, len(current_text), _sha256(current_text))
        return existing_qid, False

    # Ensure the chatbot block exists *before* creating the question, so we can
    # pass an explicit blockId. Without this, surveys lacking a default block
    # (e.g. imported/templated ones) reject POST /questions with ESRV119.
    block_id, _ = _find_or_create_chatbot_block(client, survey_id)
    new_qid = client.create_descriptive_question(survey_id, desired_text, tag, block_id=block_id)
    return new_qid, True

def _next_flow_id(flow_elements: List[Dict]) -> str:
    existing = set()
    for el in flow_elements:
        fid = el.get("FlowID", "")
        if isinstance(fid, str) and fid.startswith("FL_"):
            try:
                existing.add(int(fid.split("_")[1]))
            except (ValueError, IndexError):
                pass
    next_num = max(existing, default=0) + 1
    return f"FL_{next_num}"

def ensure_question_block(
    client: QualtricsClient,
    survey_id: str,
    question_qid: str,
    question_name: str,
) -> str:
    chatbot_block_id, _ = _find_or_create_chatbot_block(client, survey_id)
    # Re-fetch blocks since the helper may have just created one.
    all_blocks = client.get_blocks(survey_id)

    for bid, bdata in all_blocks.items():
        if bid == chatbot_block_id:
            continue
        elements = bdata.get("BlockElements", []) or []
        original_len = len(elements)
        elements = [el for el in elements if not (el.get("Type") == "Question" and el.get("QuestionID") == question_qid)]
        if len(elements) != original_len:
            logger.info("Removing question %s from block %s (moving to '%s' block).", question_qid, bid, CHATBOT_BLOCK_DESCRIPTION)
            bdata["BlockElements"] = elements
            client.update_block(survey_id, bid, bdata)

    target_block = all_blocks.get(chatbot_block_id, {}) or {}
    target_elements = target_block.get("BlockElements", []) or []

    already_present = any(
        el.get("Type") == "Question" and el.get("QuestionID") == question_qid
        for el in target_elements
    )

    if already_present:
        logger.info("Question %s already in '%s' block %s — no changes needed.", question_qid, CHATBOT_BLOCK_DESCRIPTION, chatbot_block_id)
    else:
        logger.info("Adding question %s ('%s') to '%s' block %s.", question_qid, question_name, CHATBOT_BLOCK_DESCRIPTION, chatbot_block_id)
        target_elements.append({"Type": "Question", "QuestionID": question_qid})
        target_block["BlockElements"] = target_elements
        target_block.setdefault("Type", "Standard")
        target_block.setdefault("Description", CHATBOT_BLOCK_DESCRIPTION)
        target_block.setdefault("ID", chatbot_block_id)
        client.update_block(survey_id, chatbot_block_id, target_block)

    flow = client.get_flow(survey_id)
    flow_elements = flow.get("Flow", []) or []
    block_in_flow = any(
        el.get("Type") == "Standard" and el.get("ID") == chatbot_block_id
        for el in flow_elements
    )
    if not block_in_flow:
        new_flow_element = {
            "Type": "Standard",
            "ID": chatbot_block_id,
            "FlowID": _next_flow_id(flow_elements),
            "Autofill": [],
        }
        insert_pos = 1 if flow_elements else 0
        flow_elements.insert(insert_pos, new_flow_element)
        flow["Flow"] = flow_elements
        client.update_flow(survey_id, flow)
        logger.info("Added block %s to survey flow at position %d.", chatbot_block_id, insert_pos)
    else:
        logger.info("Block %s already present in survey flow — no flow update needed.", chatbot_block_id)

    return chatbot_block_id

def _upsert_embed_block(block: Dict[str, Any], data: Dict[str, str]) -> None:
    current = block.get("EmbeddedData", []) or []
    remaining = set(data.keys())

    for field_obj in current:
        key = field_obj.get("Field")
        if key in data:
            new_value = str(data[key])
            old_value = field_obj.get("Value")
            if old_value != new_value:
                logger.info("Updating embedded '%s': %s -> %s", key, _truncate(str(old_value), 60), _truncate(new_value, 60))
            field_obj["Value"] = new_value
            field_obj["Type"] = "Custom"
            field_obj.setdefault("Description", key)
            remaining.discard(key)

    if remaining:
        logger.info("Adding new embedded fields: %s", sorted(remaining))
        for key in sorted(remaining):
            current.append({"Description": key, "Field": key, "Value": str(data[key]), "Type": "Custom"})

    block["EmbeddedData"] = current

def ensure_embedded_data(
    client: QualtricsClient,
    survey_id: str,
    shared_data: Dict[str, str],
    question_data: Dict[str, str],
) -> None:
    all_data = {**shared_data, **question_data}
    logger.info("Ensuring %d embedded data fields in a single block at flow position 0...", len(all_data))

    flow = client.get_flow(survey_id)
    flow_elements = flow.get("Flow", []) or []

    embed_block = None
    embed_index = None
    for i, el in enumerate(flow_elements):
        if el.get("Type") == "EmbeddedData":
            embed_block = el
            embed_index = i
            break

    if not embed_block:
        logger.info("Creating new Embedded Data block at position 0.")
        embed_block = {
            "Type": "EmbeddedData",
            "FlowID": _next_flow_id(flow_elements),
            "Description": "Chatbot Parameters",
            "EmbeddedData": [],
        }
        flow_elements.insert(0, embed_block)
    else:
        if embed_index is not None and embed_index != 0:
            logger.info("Moving existing Embedded Data block from index %d to position 0.", embed_index)
            flow_elements.pop(embed_index)
            flow_elements.insert(0, embed_block)
        else:
            logger.info("Found existing Embedded Data block at position 0.")

    _upsert_embed_block(embed_block, all_data)

    flow["Flow"] = flow_elements
    client.update_flow(survey_id, flow)
    logger.info("Embedded data block updated successfully.")

# =========================
# MAIN
# =========================

def main() -> int:
    logger.info("==========================================")
    logger.info("       QUALTRICS SURVEY BUILDER           ")
    logger.info("==========================================")

    config = get_config()
    question_name = config["question_name"]
    question_token = config["question_token"]
    shared_data = get_shared_fields()
    question_data = get_question_fields(question_token)

    if not config["api_token"]:
        logger.critical("QUALTRICS_API_TOKEN is missing!")
        _gh_annotate("error", "Qualtrics token missing", "QUALTRICS_API_TOKEN is missing.")
        _append_step_summary("- ❌ QUALTRICS_API_TOKEN is missing\n")
        return 1

    validate_inputs(config, question_data, shared_data)

    all_fields = generate_embedded_data_fields({**shared_data, **question_data})
    validate_embedded_field_keys(all_fields)

    base_url = f"https://{config['data_center']}.qualtrics.com/API/v3"
    client = QualtricsClient(
        base_url=base_url,
        api_token=config["api_token"],
        timeout=(config["timeout_connect"], config["timeout_read"]),
        max_attempts=config["max_attempts"],
    )

    try:
        logger.info("--- Step 1: Verify Survey ID ---")
        survey_id = ensure_survey(client, config)

        logger.info("--- Step 2: Chat UI Question '%s' ---", question_name)
        question_qid, _is_new = ensure_chat_question(client, survey_id, config)

        logger.info("--- Step 2.5: AI Chatbot Block for '%s' ---", question_name)
        ensure_question_block(client, survey_id, question_qid, question_name)

        logger.info("--- Step 3: Embedded Data for '%s' ---", question_name)
        ensure_embedded_data(client, survey_id, shared_data=shared_data, question_data=question_data)

        logger.info("==========================================")
        logger.info("SUCCESS! Survey %s is ready.", survey_id)
        logger.info("  Question: '%s' (QID: %s)", question_name, question_qid)
        logger.info("==========================================")

        _append_step_summary(
            "- ✅ Build completed\n"
            f"- SurveyID: `{survey_id}`\n"
            f"- Question: `{question_name}` (QID: `{question_qid}`)\n"
        )
        return 0

    except QualtricsAPIError as e:
        logger.exception("QualtricsAPIError encountered.")
        _append_step_summary("## ❌ Build failed\n" + e.to_markdown())
        _gh_annotate(
            "error",
            "Qualtrics API error",
            f"{e} (status={e.status_code} requestId={e.request_id} errorCode={e.error_code})",
        )
        return 1

    except Exception as e:
        logger.exception("An unexpected error occurred during execution:")
        _append_step_summary(f"## ❌ Build failed\n- Unexpected error: `{type(e).__name__}`: {_truncate(str(e), 200)}\n")
        _gh_annotate("error", "Build failed", f"{type(e).__name__}: {str(e)}")
        return 1

if __name__ == "__main__":
    sys.exit(main())