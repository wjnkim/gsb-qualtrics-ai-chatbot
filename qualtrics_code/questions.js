Qualtrics.SurveyEngine.addOnload(function () {
  // runs when the page loads (before addOnReady)

  /*********************************************************
   * PRE-PAINT NEXT-BUTTON HIDE (optional)
   *
   * When this question is configured to gate the Next button
   * (__QN__hide_next_until_ping === "true"), hide it here — before the
   * page is fully painted — so the button never flashes on screen.
   * addOnReady (below) wires up the logic that reveals it again.
   *
   * We hide with a CSS rule scoped to a class on <html> (an element
   * Qualtrics never re-renders, so the rule survives the new
   * experience's single-page transitions) and use `visibility` so the
   * surrounding nav layout does not shift when the button reappears.
   *********************************************************/
  try {
    var cfg = document.getElementById("safe-hide-next-until-ping-__QNSAFE__");
    if (cfg && (cfg.value || "").trim().toLowerCase() === "true") {
      var cls = "qc-hide-next-__QNSAFE__";
      if (!document.getElementById("qc-hide-style-__QNSAFE__")) {
        var css =
          "html." + cls + " #NextButton," +
          "html." + cls + " #Buttons #NextButton," +   /* classic: <input id="NextButton"> */
          "html." + cls + " #next-button," +
          "html." + cls + " #navigation #next-button" + /* new experience: <button id="next-button"> */
          "{visibility:hidden !important;}";
        var style = document.createElement("style");
        style.id = "qc-hide-style-__QNSAFE__";
        style.appendChild(document.createTextNode(css));
        (document.head || document.documentElement).appendChild(style);
      }
      document.documentElement.classList.add(cls);
    }
  } catch (e) {}
});

Qualtrics.SurveyEngine.addOnReady(function () {

  /*********************************************************
   * QUESTION CONTEXT
   * __QN__ is replaced at build time with {question_name}_
   * __QNSAFE__ is replaced with a DOM-safe question token
   * __QUESTION_NAME__ is replaced with the literal question name
   *********************************************************/
  var qthis = this;                 // question instance — needed inside async
                                    // callbacks, where `this` is NOT the question
  var QUESTION_ID = this.questionId;
  var QUESTION_NAME = "__QUESTION_NAME__";

  /*********************************************************
   * EMBEDDED DATA WRITER (robust across BOTH experiences)
   *
   * The two Qualtrics survey-taking engines persist embedded data
   * from question JS differently, and there is no single call that
   * works in both:
   *   - NEW experience: setEmbeddedData() is a deprecated no-op.
   *     setJSEmbeddedData("X", v) persists ONLY to a Survey Flow
   *     field declared as "__js_X" (recorded column "__js_X").
   *   - CLASSIC experience: setEmbeddedData("X", v) persists to a
   *     plainly-named flow field "X" (recorded column "X").
   *
   * So we write through BOTH APIs with the SAME un-prefixed key.
   * build_survey.py declares BOTH "__js_X" and "X" in the flow, so
   * whichever engine is active records the value (the other column
   * stays blank). When reading data, coalesce "__js_X" and "X".
   * The classic call is skipped in the new experience, where it is
   * a no-op that only logs a console error.
   *********************************************************/
  function setSurveyEmbeddedData(key, value) {
    var SE = Qualtrics.SurveyEngine;
    // New experience: persists to the "__js_"-prefixed flow field.
    if (typeof SE.setJSEmbeddedData === "function") {
      try { SE.setJSEmbeddedData(key, value); } catch (e) {}
    }
    // Classic experience: persists to the plainly-named flow field.
    // Skip when it's the new-experience deprecated no-op stub.
    if (typeof SE.setEmbeddedData === "function" &&
        SE.setEmbeddedData.toString().indexOf("deprecated") === -1) {
      try { SE.setEmbeddedData(key, value); } catch (e) {}
    }
  }

  setSurveyEmbeddedData("__QN__chat_question_id", QUESTION_ID);

  /*********************************************************
   * CONFIG + STATE
   *********************************************************/
  var conversationHistory1 = [];

  var MAX_CHATS = parseInt(document.getElementById("safe-max-chats-__QNSAFE__").value, 10);
  if (isNaN(MAX_CHATS) || MAX_CHATS <= 0) MAX_CHATS = 10;

  // Proxy URL from embedded data (shared, not namespaced)
  var PROXY_URL = (document.getElementById("safe-proxy-url-__QNSAFE__").value || "").trim();
  if (!PROXY_URL) PROXY_URL = "https://stanford-proxy-v2-ybc5jm5e6q-uw.a.run.app";

  // Per-word delay (in seconds) before showing bot response (0 = instant)
  // Total delay = wordCount * DELAY_PER_WORD, capped at MAX_DELAY_SECONDS
  var DELAY_PER_WORD = parseFloat(document.getElementById("safe-delay-per-word-__QNSAFE__").value);
  if (isNaN(DELAY_PER_WORD) || DELAY_PER_WORD < 0) DELAY_PER_WORD = 0;
  var MAX_DELAY_SECONDS = 10;

  /*********************************************************
   * TRANSCRIPT STORAGE (chunked + resumable)
   *
   * The transcript is written to embedded data on every turn. A single
   * Qualtrics embedded-data field has a length cap (~20k chars) and a long or
   * verbose interview can exceed it (which silently truncates the value into
   * unparseable JSON), so we split the serialized transcript across N declared
   * "part" fields. Part 1 keeps the historical column name "<q>_chat_history"
   * (so short interviews export exactly as before); parts 2..N are
   * "<q>_chat_history_<i>". build_survey.py declares the parts and pipes them
   * back in via hidden textareas so we can resume on load — see readBridge.
   *********************************************************/
  function readBridge(id) {
    var el = document.getElementById(id);
    return el ? (el.value || "") : "";
  }

  var HISTORY_PARTS_MAX = parseInt(readBridge("safe-history-parts-max-__QNSAFE__"), 10);
  if (isNaN(HISTORY_PARTS_MAX) || HISTORY_PARTS_MAX < 1) HISTORY_PARTS_MAX = 8;
  var HISTORY_CHUNK = 15000;   // chars per part field (kept under the ~20k cap)
  var storedLen = 0;           // # messages currently persisted (for the shrink guard)

  /*********************************************************
   * NEXT-BUTTON GATE (optional)
   *
   * When __QN__hide_next_until_ping === "true", the survey's built-in
   * Next button starts hidden and is revealed only when the chatbot
   * signals the interview is over. The signal ("ping") is a sentinel
   * token the model is instructed to emit at the very end of its final
   * message (build_survey.py appends that instruction to the system
   * prompt automatically when this option is on). We strip the token
   * from the visible message + saved transcript, then reveal the button.
   *
   * Reliability (verified against Qualtrics docs + community):
   *  - qthis.hideNextButton()/showNextButton() are the official methods
   *    and work in BOTH the new and classic experiences (they abstract
   *    the button markup, which differs between engines). Primary path.
   *  - Fallback: toggle a class on <html> (never re-rendered) driving a
   *    CSS `visibility` rule (not display, so layout is stable). This
   *    survives the new experience's page transitions.
   *  - A reveal is ALWAYS guaranteed eventually — on ping, on reaching
   *    MAX_CHATS, and via a fixed failsafe timer that fires a set number of
   *    minutes after load — so a respondent can never get permanently stuck.
   *********************************************************/
  var HIDE_NEXT = (document.getElementById("safe-hide-next-until-ping-__QNSAFE__").value || "")
    .trim().toLowerCase() === "true";

  // Failsafe timer: reveal the Next button this many minutes after the chat
  // loads (default 5), regardless of activity. It is a fixed countdown started
  // once on load and never reset, so set it comfortably above your longest
  // expected interview or it may reveal the button mid-conversation. A value of
  // 0 disables the failsafe (not recommended: ping + MAX_CHATS would then be the
  // only ways to reveal the button).
  var SHOW_NEXT_AFTER_MIN = parseFloat(
    document.getElementById("safe-show-next-after-minutes-__QNSAFE__").value
  );
  if (isNaN(SHOW_NEXT_AFTER_MIN) || SHOW_NEXT_AFTER_MIN < 0) SHOW_NEXT_AFTER_MIN = 5;
  var SHOW_NEXT_AFTER_MS = SHOW_NEXT_AFTER_MIN * 60 * 1000;

  // Sentinel the model emits when the interview is complete. MUST stay in sync
  // with PING_TOKEN in build_survey.py. Matched tolerantly (case + inner
  // whitespace) and stripped before display/save.
  // Token: [[END_INTERVIEW]]
  var HIDE_CLASS = "qc-hide-next-__QNSAFE__";
  var TROUBLE_CLASS = "qc-trouble-next-__QNSAFE__";
  var nextRevealed = false;
  var troubleApplied = false;
  var failsafeTimer = null;
  var failsafeStarted = false;
  var leakGuardTimer = null;

  // Whether the interview was already completed on a PRIOR visit to this page
  // (ping or turn cap). If so we must NOT re-hide the Next button on return,
  // or a respondent who is already done would be trapped again.
  var alreadyComplete =
    ((readBridge("safe-complete-js-__QNSAFE__") ||
      readBridge("safe-complete-__QNSAFE__") || "").trim().toLowerCase() === "true");

  function injectHideStyle() {
    if (document.getElementById("qc-hide-style-__QNSAFE__")) return;
    var css =
      "html." + HIDE_CLASS + " #NextButton," +
      "html." + HIDE_CLASS + " #Buttons #NextButton," +
      "html." + HIDE_CLASS + " #next-button," +
      "html." + HIDE_CLASS + " #navigation #next-button" +
      "{visibility:hidden !important;}";
    var style = document.createElement("style");
    style.id = "qc-hide-style-__QNSAFE__";
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  /*********************************************************
   * TIMEOUT ("HAVING TROUBLE") NEXT BUTTON (optional)
   *
   * There are two very different reasons a gated Next button can
   * appear, and a respondent should be able to tell them apart:
   *
   *   1. The chatbot signalled the interview is over (the ping), or the
   *      turn cap was reached. That is the normal exit, so the button
   *      keeps the survey's default look: "you're done, continue".
   *   2. The failsafe timer elapsed while the chat was still running.
   *      That is an escape hatch for someone stuck with a broken or
   *      unresponsive chatbot, so the button is shown in a warning
   *      colour with explicit "only click this if something is wrong"
   *      wording — nobody should mistake it for the normal way out.
   *
   * If the interview later finishes properly (ping or turn cap) after
   * the timer already fired, the button reverts to the default look.
   *
   * All of the timeout styling hangs off ONE class on <html> (the one
   * element Qualtrics never re-renders), exactly like the hide gate, so
   * it can be dropped in a single statement when we leave the page.
   * That matters: in the new experience #next-button is SHARED across
   * pages, so a restyle left behind would follow the respondent.
   *
   * Set timeout_next_style to "default" to switch this off and get the
   * previous behaviour (the timer reveals the ordinary Next button).
   *********************************************************/
  var TROUBLE_STYLE = (readBridge("safe-timeout-next-style-__QNSAFE__") || "trouble")
    .trim().toLowerCase();
  var TROUBLE_ENABLED = TROUBLE_STYLE !== "default" && TROUBLE_STYLE !== "false";

  // auto | en | fr | es | multi  (auto = read the language out of the chat)
  var TROUBLE_LANG = (readBridge("safe-timeout-next-lang-__QNSAFE__") || "auto")
    .trim().toLowerCase();
  if (["auto", "en", "fr", "es", "multi"].indexOf(TROUBLE_LANG) === -1) TROUBLE_LANG = "auto";

  var TROUBLE_COLOR = (readBridge("safe-timeout-next-color-__QNSAFE__") || "").trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(TROUBLE_COLOR)) TROUBLE_COLOR = "#C0392B";

  var TROUBLE_LANG_ORDER = ["en", "fr", "es"];
  var TROUBLE_LABELS = {
    en: "Click here if you are having trouble with the chatbot",
    fr: "Cliquez ici si vous rencontrez des difficultés avec le chatbot",
    es: "Haga clic aquí si tiene problemas con el chatbot"
  };

  // Optional researcher-supplied wording (timeout_next_label). Either one
  // string used for every language, or per-language overrides written as
  // "en=... | fr=... | es=...". Languages left out fall back to the built-in
  // wording above.
  var TROUBLE_LABEL_OVERRIDE = (function () {
    var raw = (readBridge("safe-timeout-next-label-__QNSAFE__") || "").trim();
    if (!raw) return null;
    if (!/(^|\|)\s*(en|fr|es)\s*=/i.test(raw)) return { all: raw };
    var out = {};
    raw.split("|").forEach(function (part) {
      var m = part.match(/^\s*(en|fr|es)\s*=\s*([\s\S]*)$/i);
      if (m && m[2].trim()) out[m[1].toLowerCase()] = m[2].trim();
    });
    return out;
  })();

  /*********************************************************
   * CHAT LANGUAGE SNIFFER (en / fr / es)
   *
   * Some prompts open by asking the participant which language they want
   * to continue in, so the language of the interview is only known at run
   * time. Rather than ask the model for it (another marker to emit,
   * another thing it can get wrong, another token to strip out of the
   * transcript) we read it off the text the bot has actually been writing.
   *
   * Method: count function words that only ONE of the three languages
   * uses, over the bot's most recent turns, plus a small bonus for letters
   * only one language has (n-tilde and inverted marks -> Spanish,
   * c-cedilla and grave/circumflex vowels -> French). The opening turn is
   * skipped whenever there is anything after it, because that first
   * message is usually the multilingual "which language?" menu.
   *
   * A clear winner is required (enough hits AND a margin over the runner
   * up). When there isn't one, detectChatLanguage() returns "" and the
   * caller labels the button in all three languages rather than guessing.
   *********************************************************/
  function wordSet(s) {
    var o = {};
    s.split(" ").forEach(function (w) { if (w) o[w] = 1; });
    return o;
  }

  // Deliberately excludes words shared by two of the three languages
  // ("que", "la", "de", "bien", "no", ...): they add noise but no signal.
  var LANG_WORDS = {
    en: wordSet("the and you your are that this with have what how why would could about please thank hello just from they been which when there because tell more think really something anything"),
    fr: wordSet("vous votre nous une des les pour avec dans qui pas plus cette comment pourquoi merci bonjour très aussi être avez êtes alors donc quel quelle peut est sont je j'ai c'est ne du au aux ça oui fait"),
    es: wordSet("usted ustedes para con los las una por como cómo porque gracias hola muy también pero está están tiene puede sus del esta este cuál qué sobre hacer más sí eso ese algo cuando siempre entonces")
  };
  var LANG_CHARS = { en: null, fr: /[çœèêëîïôûù]/g, es: /[ñ¿¡]/g };

  function scoreLanguage(text) {
    var norm = String(text || "").toLowerCase().replace(/[’´`]/g, "'");
    var tokens = norm.match(/[a-z\u00c0-\u024f]+(?:'[a-z\u00c0-\u024f]+)?/g) || [];
    if (tokens.length < 8) return "";   // not enough text to say anything

    var counts = { en: 0, fr: 0, es: 0 };
    for (var i = 0; i < tokens.length; i++) {
      for (var j = 0; j < TROUBLE_LANG_ORDER.length; j++) {
        if (LANG_WORDS[TROUBLE_LANG_ORDER[j]][tokens[i]]) counts[TROUBLE_LANG_ORDER[j]]++;
      }
    }

    var best = "", bestScore = 0, runnerUp = 0;
    for (var k = 0; k < TROUBLE_LANG_ORDER.length; k++) {
      var lang = TROUBLE_LANG_ORDER[k];
      var hits = LANG_CHARS[lang] ? (norm.match(LANG_CHARS[lang]) || []).length : 0;
      var score = counts[lang] / tokens.length + Math.min(hits, 5) * 0.01;
      if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = lang; }
      else if (score > runnerUp) { runnerUp = score; }
    }

    if (bestScore < 0.06) return "";              // too few hits to trust
    if (bestScore < runnerUp * 1.5) return "";    // no clear winner
    return best;
  }

  function detectChatLanguage() {
    var bot = conversationHistory1.filter(function (m) {
      return m && m.role === "assistant" && typeof m.content === "string";
    });
    // Skip the opening turn when there is anything after it: it is typically
    // the "English / francais / espanol?" menu, which is written in all three
    // languages and says nothing about what the participant actually picked.
    var opening = bot.length > 1 ? bot[0] : null;
    var sample = (opening ? bot.slice(1) : bot).slice(-3);
    var lang = scoreLanguage(sample.map(function (m) { return m.content; }).join(" "));
    if (lang) return lang;
    // Too little bot text so far — widen to everything said on the page, but
    // still leave the opening menu out: it is the one message guaranteed to
    // point at the wrong language.
    return scoreLanguage(conversationHistory1.filter(function (m) {
      return m && m !== opening && typeof m.content === "string";
    }).map(function (m) { return m.content; }).join(" "));
  }

  // Work out the wording to show, honouring the configured language mode.
  // Returns the detected language (or "") and one label line per language shown.
  function resolveTroubleLabel() {
    function labelFor(l) {
      if (TROUBLE_LABEL_OVERRIDE) {
        if (TROUBLE_LABEL_OVERRIDE.all) return TROUBLE_LABEL_OVERRIDE.all;
        if (TROUBLE_LABEL_OVERRIDE[l]) return TROUBLE_LABEL_OVERRIDE[l];
      }
      return TROUBLE_LABELS[l] || TROUBLE_LABELS.en;
    }

    var detected = (TROUBLE_LANG === "auto" || TROUBLE_LANG === "multi")
      ? detectChatLanguage()
      : "";

    var langs;
    if (TROUBLE_LANG === "en" || TROUBLE_LANG === "fr" || TROUBLE_LANG === "es") {
      langs = [TROUBLE_LANG];
    } else if (TROUBLE_LANG === "auto" && detected) {
      langs = [detected];
    } else {
      // "multi", or "auto" with no confident answer: show every language, the
      // most likely one first. Longer, but it can never be the wrong language.
      langs = TROUBLE_LANG_ORDER.filter(function (l) { return l !== detected; });
      if (detected) langs.unshift(detected);
    }

    var lines = [];
    langs.forEach(function (l) {
      var t = labelFor(l);
      if (t && lines.indexOf(t) === -1) lines.push(t);   // one override -> one line
    });

    return { detected: detected, lines: lines };
  }

  // Escape a string for use inside a CSS  content: "..."  value.
  function cssContent(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\A ");
  }

  function injectTroubleStyle(label) {
    var old = document.getElementById("qc-trouble-style-__QNSAFE__");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    // Both engines' buttons, and both the bare and the nav-scoped selector for
    // each. The nav-scoped ones are only here for specificity: a survey theme
    // that styles "#navigation #next-button" would otherwise outrank a plain
    // "#next-button" rule of ours even with !important. For the same reason
    // every rule below repeats the full selector pair rather than relying on a
    // shorter one — an earlier version set font-size on the wide list and 0 on
    // the narrow one, and the arrow glyph stayed visible next to our label.
    var s = "html." + TROUBLE_CLASS + " ";
    var c1 = s + "#NextButton", c2 = s + "#Buttons #NextButton";
    var m1 = s + "#next-button", m2 = s + "#navigation #next-button";
    var classic = c1 + "," + c2;
    var modern = m1 + "," + m2;

    var css =
      classic + "," + modern + "{" +
        "background-color:" + TROUBLE_COLOR + " !important;" +
        "background-image:none !important;" +
        "border:1px solid " + TROUBLE_COLOR + " !important;" +
        "width:auto !important;min-width:0 !important;max-width:360px !important;" +
        "height:auto !important;min-height:0 !important;" +
        "padding:10px 16px !important;" +
        "font-weight:600 !important;line-height:1.35 !important;" +
        "white-space:pre-line !important;text-align:center !important;" +
      "}" +
      classic + ":hover," + modern + ":hover{filter:brightness(0.9);}" +
      // Classic engine: <input>, a replaced element, so it just shows its value.
      classic + "{color:#fff !important;font-size:14px !important;}" +
      // New experience: a <button> whose content is an arrow glyph, an icon, or
      // both. Collapse whatever is in there (font-size:0 for bare text nodes,
      // display:none for child elements, colour as a backstop) and draw our own
      // label with ::after — so the real button is never mutated and the whole
      // thing reverts by dropping the class.
      modern + "{font-size:0 !important;color:transparent !important;}" +
      m1 + " > *," + m2 + " > *{display:none !important;}" +
      m1 + "::before," + m2 + "::before{content:none !important;}" +
      m1 + "::after," + m2 + "::after{" +
        "content:\"" + cssContent(label) + "\";" +
        "display:inline !important;" +
        "font-size:14px !important;font-weight:600 !important;color:#fff !important;" +
        "white-space:pre-line !important;" +
      "}";

    var style = document.createElement("style");
    style.id = "qc-trouble-style-__QNSAFE__";
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  function applyTroubleStyle() {
    if (troubleApplied || !TROUBLE_ENABLED) return;
    troubleApplied = true;

    var resolved = resolveTroubleLabel();
    // Record which language we labelled the button in, so the sniffer can be
    // audited against the transcript afterwards.
    try { setSurveyEmbeddedData("__QN__chat_lang", resolved.detected || "unknown"); } catch (e) {}

    injectTroubleStyle(resolved.lines.join("\n"));
    document.documentElement.classList.add(TROUBLE_CLASS);

    // Classic engine: <input id="NextButton">, so the label has to be set
    // directly. Stash the original ON the element — addOnUnload is a separate
    // closure and needs to be able to put it back without sharing state.
    var ci = document.getElementById("NextButton");
    if (ci && ci.tagName === "INPUT") {
      if (ci.getAttribute("data-qc-orig-value") === null) {
        ci.setAttribute("data-qc-orig-value", ci.value || "");
      }
      ci.value = resolved.lines.join("  /  ");   // an <input> can't wrap lines
    }
    // ::after content is not reliably announced, so name the button explicitly.
    var nb = document.getElementById("next-button");
    if (nb) {
      if (nb.getAttribute("data-qc-orig-aria") === null) {
        nb.setAttribute("data-qc-orig-aria", nb.getAttribute("aria-label") || "");
      }
      nb.setAttribute("aria-label", resolved.lines.join(" / "));
    }
  }

  // Put the Next button back exactly as the survey theme had it.
  function clearTroubleStyle() {
    troubleApplied = false;
    document.documentElement.classList.remove(TROUBLE_CLASS);
    var st = document.getElementById("qc-trouble-style-__QNSAFE__");
    if (st && st.parentNode) st.parentNode.removeChild(st);

    var ci = document.getElementById("NextButton");
    if (ci && ci.getAttribute("data-qc-orig-value") !== null) {
      ci.value = ci.getAttribute("data-qc-orig-value");
      ci.removeAttribute("data-qc-orig-value");
    }
    var nb = document.getElementById("next-button");
    if (nb && nb.getAttribute("data-qc-orig-aria") !== null) {
      var orig = nb.getAttribute("data-qc-orig-aria");
      if (orig) nb.setAttribute("aria-label", orig);
      else nb.removeAttribute("aria-label");
      nb.removeAttribute("data-qc-orig-aria");
    }
  }

  function clearFailsafeTimer() {
    if (failsafeTimer) { clearTimeout(failsafeTimer); failsafeTimer = null; }
  }

  // Fixed countdown from page load. Started once and never reset, so it fires
  // a set number of minutes after the chat loads regardless of activity.
  function startFailsafeTimer() {
    if (!HIDE_NEXT || nextRevealed || SHOW_NEXT_AFTER_MS <= 0) return;
    if (failsafeStarted) return;
    failsafeStarted = true;
    failsafeTimer = setTimeout(function () {
      // Time is up — reveal so no one gets stuck (even if the chat is ongoing).
      // This is the "having trouble" reveal, not the normal end of the
      // interview, so it gets the warning styling and wording.
      revealNext(false, true);
    }, SHOW_NEXT_AFTER_MS);
  }

  function hideNext() {
    if (!HIDE_NEXT) return;
    injectHideStyle();
    document.documentElement.classList.add(HIDE_CLASS);
    try { qthis.hideNextButton(); } catch (e) {}
  }

  // markComplete: the interview genuinely finished (persist the flag).
  // trouble:      the failsafe timer is what revealed the button, so show the
  //               warning-coloured "having trouble with the chatbot" version.
  function revealNext(markComplete, trouble) {
    clearFailsafeTimer();
    if (markComplete) {
      // Persist that the interview genuinely finished, so returning to this page
      // (Back/Forward or a refresh) does NOT re-gate a respondent who is done.
      try { setSurveyEmbeddedData("__QN__chat_complete", "true"); } catch (e) {}
    }
    if (trouble) {
      // Telemetry: flag the respondents who reached the escape hatch. Written
      // even when the warning styling itself is switched off.
      try { setSurveyEmbeddedData("__QN__chat_timeout_reveal", "true"); } catch (e) {}
    }

    if (nextRevealed) {
      // Already on screen. The one change still worth making: the timer put up
      // the warning button, and the interview has since ended properly — so
      // hand back the survey's normal Next button.
      if (!trouble && troubleApplied) {
        clearTroubleStyle();
        if (leakGuardTimer) { clearInterval(leakGuardTimer); leakGuardTimer = null; }
      }
      return;
    }
    nextRevealed = true;
    // Remove the gating class first (the CSS rule stops matching -> visible),
    // then the official API, then a belt-and-suspenders inline clear.
    document.documentElement.classList.remove(HIDE_CLASS);
    if (trouble) applyTroubleStyle();
    // Keep the off-screen guard running while the warning styling is up: it
    // targets the SHARED Next button, so it still has to be undone on the way
    // out. Otherwise the guard has nothing left to clean up.
    if (!troubleApplied && leakGuardTimer) {
      clearInterval(leakGuardTimer); leakGuardTimer = null;
    }
    try { qthis.showNextButton(); } catch (e) {}
    var b = document.getElementById("next-button") ||
            document.getElementById("NextButton");
    if (b) b.style.visibility = "visible";
  }

  // Drop the gate because we are LEAVING the page while still gated (not because
  // the interview finished). The hide is a class on the persistent <html>
  // targeting the SHARED #next-button, so in the new experience it would
  // otherwise "stick" and hide the Next button on whatever page the respondent
  // lands on next — most visibly after pressing "Back". The same is true of the
  // "having trouble" restyle, so that is undone here too. This does NOT mark the
  // interview complete.
  function releaseGate() {
    clearFailsafeTimer();
    if (leakGuardTimer) { clearInterval(leakGuardTimer); leakGuardTimer = null; }
    clearTroubleStyle();
    document.documentElement.classList.remove(HIDE_CLASS);
    var b = document.getElementById("next-button") ||
            document.getElementById("NextButton");
    if (b) b.style.visibility = "";
    try { qthis.showNextButton(); } catch (e) {}
  }

  // Guaranteed cleanup that does NOT depend on any navigation event firing
  // (addOnUnload is unreliable on "Previous" in the new experience). Once this
  // question's chat UI is no longer on screen while still gated — or while the
  // "having trouble" restyle is up — release the gate.
  function startLeakGuard() {
    var offscreen = 0;
    leakGuardTimer = setInterval(function () {
      if (nextRevealed && !troubleApplied) {
        clearInterval(leakGuardTimer); leakGuardTimer = null; return;
      }
      var el = document.getElementById("chat-history-__QNSAFE__");
      var onScreen = el && el.getClientRects().length > 0;
      if (onScreen) { offscreen = 0; return; }
      if (++offscreen < 2) return;   // debounce transient blips (~1s off-screen)
      clearInterval(leakGuardTimer); leakGuardTimer = null;
      releaseGate();
    }, 500);
  }

  // Remove the ping token (if present) from a bot message.
  // Returns { text: cleanedMessage, ping: booleanWasPresent }.
  function extractPing(text) {
    if (typeof text !== "string") return { text: text, ping: false };
    var ping = /\[\[\s*END_INTERVIEW\s*\]\]/i.test(text);
    var cleaned = text
      .replace(/\[\[\s*END_INTERVIEW\s*\]\]/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    return { text: cleaned, ping: ping };
  }

  /*********************************************************
   * UI HELPERS
   *********************************************************/
  function appendMessage(text, cssClasses) {
    var chatBox = document.getElementById("chat-history-__QNSAFE__");
    if (!chatBox) return null;

    var el = document.createElement("div");

    // Always add base message class
    el.classList.add("message");

    // Allow "bot-message typing-indicator" etc.
    if (cssClasses && typeof cssClasses === "string") {
      cssClasses.split(/\s+/).filter(Boolean).forEach(function (cls) {
        el.classList.add(cls);
      });
    }

    var isBot = cssClasses && cssClasses.indexOf("bot-message") !== -1;
    if (isBot && typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined") {
      el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text));
    } else {
      el.textContent = text;
    }
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;

    return el;
  }

  function showTypingIndicator() {
    var chatBox = document.getElementById("chat-history-__QNSAFE__");
    if (!chatBox) return null;
    var el = document.createElement("div");
    el.classList.add("message", "bot-message", "typing-indicator");
    el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    chatBox.appendChild(el);
    chatBox.scrollTop = chatBox.scrollHeight;
    return el;
  }

  function removeTypingIndicator(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Show a transient error bubble WITHOUT recording it in the transcript or
  // sending it back to the model as context.
  function showError(msg) {
    appendMessage(msg || "Sorry — something went wrong talking to the server.", "bot-message");
  }

  /*********************************************************
   * EMBEDDED DATA SAVE
   *********************************************************/
  function saveChatHistory() {
    // Shrink guard: never overwrite a longer stored transcript with a shorter
    // one. Protects the recorded interview if the page is re-displayed with an
    // empty in-memory history (a classic-experience reload, or a rehydrate that
    // failed to parse) before it can be repopulated.
    if (conversationHistory1.length < storedLen) return;
    storedLen = conversationHistory1.length;

    var s = JSON.stringify(conversationHistory1);

    // Overflow safety valve: if the transcript somehow exceeds the declared
    // capacity, drop the OLDEST turns until it fits rather than truncating
    // mid-JSON (which would be unparseable). Flag it so analysis can spot the
    // (very rare) case. With the default 8 parts this is ~120k chars of headroom.
    var capacity = HISTORY_PARTS_MAX * HISTORY_CHUNK;
    if (s.length > capacity) {
      var trimmed = conversationHistory1.slice();
      while (trimmed.length > 1 && JSON.stringify(trimmed).length > capacity) {
        trimmed.shift();
      }
      s = JSON.stringify(trimmed);
      setSurveyEmbeddedData("__QN__chat_history_truncated", "true");
    }

    // Chunk across the declared part fields. Part 1 keeps the historical column
    // name; unused higher parts are cleared to "" so read-back stops at the
    // first empty part.
    for (var i = 1; i <= HISTORY_PARTS_MAX; i++) {
      var chunk = s.slice((i - 1) * HISTORY_CHUNK, i * HISTORY_CHUNK);
      var key = (i === 1) ? "__QN__chat_history" : "__QN__chat_history_" + i;
      setSurveyEmbeddedData(key, chunk);
    }
  }

  // Read one transcript part back from the DOM bridge, coalescing the two
  // engine variants (new-experience "__js_" field vs. classic plain field).
  function readHistoryPart(i) {
    return readBridge("safe-hist-js-" + i + "-__QNSAFE__") ||
           readBridge("safe-hist-" + i + "-__QNSAFE__");
  }

  // Reassemble the full serialized transcript from its parts. Parts are
  // contiguous, so the first empty part marks the end.
  function readSavedHistoryRaw() {
    var out = "";
    for (var i = 1; i <= HISTORY_PARTS_MAX; i++) {
      var v = readHistoryPart(i);
      if (!v) break;
      out += v;
    }
    return out;
  }

  function renderSavedHistory(arr) {
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m || typeof m.content !== "string") continue;
      if (m.role === "user") appendMessage(m.content, "user-message");
      else if (m.role === "assistant") appendMessage(m.content, "bot-message");
    }
  }

  /*********************************************************
   * BOT REPLY HANDLER (shared by kickoff + send)
   *
   * Strips the ping token, renders + stores the cleaned message, and
   * reveals the Next button if the ping was present. An empty message
   * (e.g. the model sent only the token) is not rendered as a blank
   * bubble. The failsafe timer runs independently from page load.
   *********************************************************/
  function handleBotReply(rawText) {
    var parsed = extractPing(rawText);
    var botMessage = parsed.text;
    if (!botMessage && !parsed.ping) botMessage = "(no response)";

    if (botMessage) {
      appendMessage(botMessage, "bot-message");
      conversationHistory1.push({
        role: "assistant",
        content: botMessage,
        time: new Date().toISOString(),
        question_id: QUESTION_ID
      });
      saveChatHistory();
    }

    if (parsed.ping) {
      revealNext(true, false);
    } else if (HIDE_NEXT) {
      // The model just answered the final allowed user turn: reveal now instead
      // of waiting for the next (rejected) send attempt or the failsafe timer.
      var uTurns = conversationHistory1.filter(function (x) { return x.role === "user"; }).length;
      if (uTurns >= MAX_CHATS) revealNext(true, false);
    }
  }

  /*********************************************************
   * MAIN SEND FUNCTION
   *********************************************************/
  function sendMessage() {
    var messageInput = document.getElementById("message-input-__QNSAFE__");
    if (!messageInput) return;

    var message = (messageInput.value || "").trim();
    if (!message) return;

    // Enforce max user turns
    var userTurns = conversationHistory1.filter(function (x) {
      return x.role === "user";
    }).length;

    if (userTurns >= MAX_CHATS) {
      appendMessage("Chat limit reached. Please continue the survey.", "bot-message");
      revealNext(true, false);   // never trap the respondent once the cap is hit
      return;
    }

    // Display + store user message
    appendMessage(message, "user-message");

    conversationHistory1.push({
      role: "user",
      content: message,
      time: new Date().toISOString(),
      question_id: QUESTION_ID
    });

    saveChatHistory();
    messageInput.value = "";

    // Show typing indicator
    var typingEl = showTypingIndicator();

    /*********************************************************
     * SAFE PARAMETER HANDLING (namespaced per question)
     *********************************************************/
    var model = (document.getElementById("safe-model-__QNSAFE__").value || "").trim();
    if (!model) model = "gpt-4o";

    var temperature = parseFloat(document.getElementById("safe-temperature-__QNSAFE__").value);
    if (isNaN(temperature)) temperature = 0.7;

    var maxTokens = parseInt(document.getElementById("safe-max-tokens-__QNSAFE__").value, 10);
    if (isNaN(maxTokens)) maxTokens = 300;

    /*********************************************************
     * PROXY REQUEST
     *********************************************************/
    // Note: do not send `prompt` separately. The current user message is
    // already the last entry in `conversationHistory1` (pushed above), so
    // sending it again would cause the model to see two consecutive identical
    // user turns and confuse short answers (e.g. "3" gets read as "33").
    fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: document.getElementById("safe-prompt-__QNSAFE__").value,
        history: conversationHistory1,
        model: model,
        temperature: temperature,
        max_tokens: maxTokens
      })
    })
      .then(function (response) {
        if (!response.ok) {
          // Proxy returned an error status (rate limit, disabled, upstream error).
          // Surface it, but do NOT fabricate an assistant turn in the transcript.
          removeTypingIndicator(typingEl);
          showError("The assistant is temporarily unavailable. Please wait a moment and try again.");
          return null;
        }
        return response.json();
      })
      .then(function (data) {
        if (!data) return;   // error already handled above
        var text = (data && typeof data.text === "string") ? data.text.trim() : "";
        if (!text) {
          // 200 with no usable completion — treat as a transient error rather than
          // recording a fake "(no response)" turn and echoing it back to the model.
          removeTypingIndicator(typingEl);
          showError("The assistant didn't return a response. Please try again.");
          return;
        }

        // Strip the ping token BEFORE measuring word count for the typing delay.
        var parsed = extractPing(text);
        var wordCount = parsed.text.split(/\s+/).filter(Boolean).length;
        var dynamicDelay = Math.min(wordCount * DELAY_PER_WORD, MAX_DELAY_SECONDS) * 1000;

        setTimeout(function () {
          removeTypingIndicator(typingEl);
          handleBotReply(text);
        }, dynamicDelay);
      })
      .catch(function (error) {
        console.error("Proxy fetch error:", error);
        removeTypingIndicator(typingEl);
        showError("Sorry — something went wrong talking to the server.");
        // Do not reveal here: the failsafe timer (started on load) will reveal
        // the Next button when it elapses, without letting a transient blip end
        // the interview early.
      });
  }

  /*********************************************************
   * BUTTON + ENTER KEY HOOKUP
   *********************************************************/
  var sendButton = document.getElementById("send-button-__QNSAFE__");
  if (sendButton) sendButton.addEventListener("click", sendMessage);

  var messageInput = document.getElementById("message-input-__QNSAFE__");
  if (messageInput) {
    messageInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        sendMessage();
      }
    });
  }

 /********************************
  * INITIALIZE CONVO AUTOMATICALLY
  ********************************/
  function kickoffBot() {
  var typingEl = showTypingIndicator();

  var model = (document.getElementById("safe-model-__QNSAFE__").value || "").trim() || "gpt-4o";
  var temperature = parseFloat(document.getElementById("safe-temperature-__QNSAFE__").value);
  if (isNaN(temperature)) temperature = 0.7;
  var maxTokens = parseInt(document.getElementById("safe-max-tokens-__QNSAFE__").value, 10);
  if (isNaN(maxTokens)) maxTokens = 300;

  fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "Begin the interview now.",
      system: document.getElementById("safe-prompt-__QNSAFE__").value,
      history: [],
      model: model,
      temperature: temperature,
      max_tokens: maxTokens
    })
  })
    .then(function (response) {
      if (!response.ok) {
        removeTypingIndicator(typingEl);
        showError("Couldn't start the conversation just now. Please wait a few moments — a Continue button will appear shortly — or try refreshing the page.");
        return null;
      }
      return response.json();
    })
    .then(function (data) {
      if (!data) return;   // error already handled above
      removeTypingIndicator(typingEl);
      var text = (data && typeof data.text === "string") ? data.text.trim() : "";
      if (!text) {
        showError("Couldn't start the conversation just now. Please wait a few moments — a Continue button will appear shortly.");
        return;
      }
      // Defensive: honor a ping even on the opening turn (normally absent).
      handleBotReply(text);
    })
    .catch(function (error) {
      console.error("Kickoff error:", error);
      removeTypingIndicator(typingEl);
      showError("Couldn't start the conversation — please check your connection. A Continue button will appear shortly.");
    });
  }

  // Rehydrate any previously-saved transcript so returning to this page
  // (Back/Forward or a refresh) RESUMES the conversation instead of starting a
  // new one and overwriting the recorded interview.
  var resumeBlocked = false;   // a saved transcript exists but couldn't be read back
  (function resumeSavedHistory() {
    var raw = readSavedHistoryRaw();
    if (!raw) return;
    try {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        conversationHistory1 = arr;
        storedLen = arr.length;
        renderSavedHistory(arr);
        return;
      }
    } catch (e) {
      // A saved transcript exists but we can't read it back intact — e.g. the
      // rare case of a literal "</textarea>" typed into the chat corrupting the
      // (hidden) DOM bridge. Fail CLOSED: don't start a fresh conversation and
      // block all writes (storedLen = Infinity) so the recorded interview that
      // is still safely stored server-side is never overwritten.
      resumeBlocked = true;
      storedLen = Infinity;
      showError("We couldn't fully restore your previous conversation, but your earlier responses are saved. Please continue with the survey.");
    }
  })();

  // Gate the Next button (if configured) before starting the conversation —
  // unless the interview was already completed on a prior visit, in which case
  // re-hiding it would trap a respondent who is already done.
  if (HIDE_NEXT) {
    // Don't re-gate if the interview already finished on a prior visit, or if we
    // couldn't restore a saved conversation (the respondent can't meaningfully
    // continue the chat, so let them proceed).
    if (alreadyComplete || resumeBlocked) {
      revealNext(false, false);
    } else {
      hideNext();
      startFailsafeTimer();
      startLeakGuard();
    }
  }

  // Only auto-start when there is genuinely no prior conversation to resume and
  // we're not in the fail-closed "couldn't restore" state.
  if (conversationHistory1.length === 0 && !resumeBlocked) {
    kickoffBot();
  }

});

Qualtrics.SurveyEngine.addOnUnload(function () {
  // Fast cleanup so this question's Next-button gate — and the "having trouble"
  // restyle, which is applied to the SAME shared button — never carries onto the
  // next page shown. The in-page leak guard (startLeakGuard in addOnReady) is the
  // GUARANTEED fallback for navigations that don't fire this hook (e.g.
  // "Previous" in the new experience). This is a separate closure from
  // addOnReady, so it uses the build-time literals rather than HIDE_CLASS /
  // TROUBLE_CLASS, and reads the stashed originals off the button itself.
  try {
    document.documentElement.classList.remove("qc-hide-next-__QNSAFE__");
    document.documentElement.classList.remove("qc-trouble-next-__QNSAFE__");
  } catch (e) {}
  var st = document.getElementById("qc-trouble-style-__QNSAFE__");
  if (st && st.parentNode) st.parentNode.removeChild(st);

  var b = document.getElementById("next-button") || document.getElementById("NextButton");
  if (b) b.style.visibility = "";

  var ci = document.getElementById("NextButton");
  if (ci && ci.getAttribute("data-qc-orig-value") !== null) {
    ci.value = ci.getAttribute("data-qc-orig-value");
    ci.removeAttribute("data-qc-orig-value");
  }
  var nb = document.getElementById("next-button");
  if (nb && nb.getAttribute("data-qc-orig-aria") !== null) {
    var orig = nb.getAttribute("data-qc-orig-aria");
    if (orig) nb.setAttribute("aria-label", orig);
    else nb.removeAttribute("aria-label");
    nb.removeAttribute("data-qc-orig-aria");
  }
});
