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

  function revealNext() {
    clearFailsafeTimer();
    if (nextRevealed) return;
    nextRevealed = true;
    // Remove the gating class first (the CSS rule stops matching -> visible),
    // then the official API, then a belt-and-suspenders inline clear.
    document.documentElement.classList.remove(HIDE_CLASS);
    try { qthis.showNextButton(); } catch (e) {}
    var b = document.getElementById("next-button") ||
            document.getElementById("NextButton");
    if (b) b.style.visibility = "visible";
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

  /*********************************************************
   * EMBEDDED DATA SAVE
   *********************************************************/
  function saveChatHistory() {
    setSurveyEmbeddedData(
      "__QN__chat_history",
      JSON.stringify(conversationHistory1)
    );
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
      revealNext();
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
      revealNext();   // never trap the respondent once the cap is hit
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
      .then(function (response) { return response.json(); })
      .then(function (data) {
        // Strip the ping token BEFORE measuring word count / rendering.
        var parsed = extractPing(data && data.text ? data.text.trim() : "(no response)");
        var display = parsed.text;
        if (!display && !parsed.ping) display = "(no response)";

        // Dynamic delay: scale by word count to mimic human typing speed
        var wordCount = display.split(/\s+/).filter(Boolean).length;
        var dynamicDelay = Math.min(wordCount * DELAY_PER_WORD, MAX_DELAY_SECONDS) * 1000;

        setTimeout(function () {
          removeTypingIndicator(typingEl);
          handleBotReply(data && data.text ? data.text.trim() : "(no response)");
        }, dynamicDelay);
      })
      .catch(function (error) {
        console.error("Proxy fetch error:", error);
        removeTypingIndicator(typingEl);
        appendMessage("Sorry — something went wrong talking to the server.", "bot-message");
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
    .then(function (response) { return response.json(); })
    .then(function (data) {
      removeTypingIndicator(typingEl);
      // Defensive: honor a ping even on the opening turn (normally absent).
      handleBotReply(data && data.text ? data.text.trim() : "(no response)");
    })
    .catch(function (error) {
      console.error("Kickoff error:", error);
      removeTypingIndicator(typingEl);
    });
  }

  // Gate the Next button (if configured) before starting the conversation.
  if (HIDE_NEXT) {
    hideNext();
    startFailsafeTimer();
  }

  // Only auto-start if there's no existing chat history (handles back-navigation)
  if (conversationHistory1.length === 0) {
    kickoffBot();
  }

});

Qualtrics.SurveyEngine.addOnUnload(function () {
  // runs when leaving the page
});
