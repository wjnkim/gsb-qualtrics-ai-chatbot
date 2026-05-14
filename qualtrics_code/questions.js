Qualtrics.SurveyEngine.addOnload(function () {
  // runs when the page loads (before addOnReady)
});

Qualtrics.SurveyEngine.addOnReady(function () {

  /*********************************************************
   * QUESTION CONTEXT
   * __QN__ is replaced at build time with {question_name}_
   * __QNSAFE__ is replaced with a DOM-safe question token
   * __QUESTION_NAME__ is replaced with the literal question name
   *********************************************************/
  var QUESTION_ID = this.questionId;
  var QUESTION_NAME = "__QUESTION_NAME__";

  Qualtrics.SurveyEngine.setEmbeddedData("__QN__chat_question_id", QUESTION_ID);

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
    Qualtrics.SurveyEngine.setEmbeddedData(
      "__QN__chat_history",
      JSON.stringify(conversationHistory1)
    );
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
        var botMessage = (data && data.text ? data.text.trim() : "(no response)");

        // Dynamic delay: scale by word count to mimic human typing speed
        var wordCount = botMessage.split(/\s+/).filter(Boolean).length;
        var dynamicDelay = Math.min(wordCount * DELAY_PER_WORD, MAX_DELAY_SECONDS) * 1000;

        setTimeout(function () {
          removeTypingIndicator(typingEl);

          appendMessage(botMessage, "bot-message");

          conversationHistory1.push({
            role: "assistant",
            content: botMessage,
            time: new Date().toISOString(),
            question_id: QUESTION_ID
          });

          saveChatHistory();
        }, dynamicDelay);
      })
      .catch(function (error) {
        console.error("Proxy fetch error:", error);
        removeTypingIndicator(typingEl);
        appendMessage("Sorry — something went wrong talking to the server.", "bot-message");
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
      var botMessage = (data && data.text ? data.text.trim() : "(no response)");
      removeTypingIndicator(typingEl);
      appendMessage(botMessage, "bot-message");
      conversationHistory1.push({
        role: "assistant",
        content: botMessage,
        time: new Date().toISOString(),
        question_id: QUESTION_ID
      });
      saveChatHistory();
    })
    .catch(function (error) {
      console.error("Kickoff error:", error);
      removeTypingIndicator(typingEl);
    });
  }
  
  // Only auto-start if there's no existing chat history (handles back-navigation)
  if (conversationHistory1.length === 0) {
    kickoffBot();
  }
  
});

Qualtrics.SurveyEngine.addOnUnload(function () {
  // runs when leaving the page
});
