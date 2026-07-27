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

  /*********************************************************
   * BROWSER-SIDE RESUME (localStorage) — primary resume source
   *
   * Embedded data written from JS only reaches the server on submit / periodic
   * autosave, so on a MID-PAGE refresh the piped ${e://Field/..._chat_history}
   * reflects a STALE server snapshot and resume would jump back to an EARLIER
   * point in the chat. localStorage is written synchronously every turn and
   * survives a refresh instantly, so it is the primary resume source; embedded
   * data remains the researcher's exported record + a cross-device fallback.
   *
   * Keyed by ResponseID so it can NEVER bleed across participants who share a
   * browser (e.g. a lab computer). If the ResponseID pipe is missing/unresolved
   * we return null and skip localStorage entirely rather than risk a shared key.
   *********************************************************/
  function lsKey() {
    var rid = readBridge("safe-response-id-__QNSAFE__").trim();
    if (!rid || rid.indexOf("${") !== -1) return null;   // unresolved/missing pipe -> no localStorage
    return "qc_hist_" + "__QNSAFE__" + "_" + rid;
  }
  function readLocalHistory() {
    try {
      var k = lsKey();
      return (k && window.localStorage) ? (window.localStorage.getItem(k) || "") : "";
    } catch (e) { return ""; }
  }
  function writeLocalHistory(s) {
    try {
      var k = lsKey();
      if (k && window.localStorage) window.localStorage.setItem(k, s);
    } catch (e) {}
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
  var nextRevealed = false;
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
      revealNext();
    }, SHOW_NEXT_AFTER_MS);
  }

  function hideNext() {
    if (!HIDE_NEXT) return;
    injectHideStyle();
    document.documentElement.classList.add(HIDE_CLASS);
    try { qthis.hideNextButton(); } catch (e) {}
  }

  function revealNext(markComplete) {
    clearFailsafeTimer();
    if (markComplete) {
      // Persist that the interview genuinely finished, so returning to this page
      // (Back/Forward or a refresh) does NOT re-gate a respondent who is done.
      try { setSurveyEmbeddedData("__QN__chat_complete", "true"); } catch (e) {}
    }
    if (nextRevealed) return;
    nextRevealed = true;
    if (leakGuardTimer) { clearInterval(leakGuardTimer); leakGuardTimer = null; }
    // Remove the gating class first (the CSS rule stops matching -> visible),
    // then the official API, then a belt-and-suspenders inline clear.
    document.documentElement.classList.remove(HIDE_CLASS);
    try { qthis.showNextButton(); } catch (e) {}
    var b = document.getElementById("next-button") ||
            document.getElementById("NextButton");
    if (b) b.style.visibility = "visible";
  }

  // Drop the gate because we are LEAVING the page while still gated (not because
  // the interview finished). The hide is a class on the persistent <html>
  // targeting the SHARED #next-button, so in the new experience it would
  // otherwise "stick" and hide the Next button on whatever page the respondent
  // lands on next — most visibly after pressing "Back". This does NOT mark the
  // interview complete.
  function releaseGate() {
    clearFailsafeTimer();
    if (leakGuardTimer) { clearInterval(leakGuardTimer); leakGuardTimer = null; }
    document.documentElement.classList.remove(HIDE_CLASS);
    var b = document.getElementById("next-button") ||
            document.getElementById("NextButton");
    if (b) b.style.visibility = "";
    try { qthis.showNextButton(); } catch (e) {}
  }

  // Guaranteed cleanup that does NOT depend on any navigation event firing
  // (addOnUnload is unreliable on "Previous" in the new experience). Once this
  // question's chat UI is no longer on screen while still gated, release the gate.
  function startLeakGuard() {
    var offscreen = 0;
    leakGuardTimer = setInterval(function () {
      if (nextRevealed) { clearInterval(leakGuardTimer); leakGuardTimer = null; return; }
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

    // Primary resume source: full transcript in localStorage. Written first and
    // untrimmed (no ~20k cap there), so a mid-page refresh resumes the CURRENT
    // conversation instead of a stale server snapshot.
    writeLocalHistory(s);

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
      revealNext(true);
    } else if (HIDE_NEXT) {
      // The model just answered the final allowed user turn: reveal now instead
      // of waiting for the next (rejected) send attempt or the failsafe timer.
      var uTurns = conversationHistory1.filter(function (x) { return x.role === "user"; }).length;
      if (uTurns >= MAX_CHATS) revealNext(true);
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
      revealNext(true);   // never trap the respondent once the cap is hit
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
    // Prefer localStorage (always current on refresh); fall back to the piped
    // embedded-data snapshot (cross-device, or if localStorage is unavailable).
    var raw = readLocalHistory();
    if (!raw) raw = readSavedHistoryRaw();
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
      revealNext(false);
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
  // Fast cleanup so this question's Next-button gate never carries onto the next
  // page shown. The in-page leak guard (startLeakGuard in addOnReady) is the
  // GUARANTEED fallback for navigations that don't fire this hook (e.g.
  // "Previous" in the new experience). This is a separate closure from
  // addOnReady, so it uses the build-time class literal rather than HIDE_CLASS.
  try { document.documentElement.classList.remove("qc-hide-next-__QNSAFE__"); } catch (e) {}
  var b = document.getElementById("next-button") || document.getElementById("NextButton");
  if (b) b.style.visibility = "";
});
