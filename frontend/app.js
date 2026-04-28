const ENDPOINTS = [
  {
    key: "talkSession",
    label: "POST /talk/session",
    method: "POST",
    path: "/talk/session",
    sampleBody: {
      userName: "yajur",
    },
  },
  {
    key: "talk",
    label: "POST /talk",
    method: "POST",
    path: "/talk",
    sampleBody: {
      userName: "yajur",
      prompt: "Continue our chat.",
      model: "gpt-4o",
      temperature: 0.7,
    },
  },
  {
    key: "health",
    label: "GET /health",
    method: "GET",
    path: "/health",
    sampleBody: null,
  },
  {
    key: "models",
    label: "GET /models",
    method: "GET",
    path: "/models",
    sampleBody: null,
  },
  {
    key: "ask",
    label: "POST /ask",
    method: "POST",
    path: "/ask",
    sampleBody: {
      prompt: "What is machine learning in simple terms?",
      model: "gpt-4o",
      temperature: 0.7,
    },
  },
  {
    key: "batch",
    label: "POST /batch",
    method: "POST",
    path: "/batch",
    sampleBody: {
      prompts: [
        "Define cloud computing in one paragraph.",
        "What is serverless in plain English?"
      ],
      model: "gpt-4o",
      temperature: 0.6,
    },
  },
  {
    key: "chainHello",
    label: "POST /chain (hello)",
    method: "POST",
    path: "/chain",
    sampleBody: {
      mode: "hello",
      question: "What is retrieval-augmented generation?",
      model: "gpt-4o",
      temperature: 0.7,
    },
  },
  {
    key: "chainResearch",
    label: "POST /chain (research)",
    method: "POST",
    path: "/chain",
    sampleBody: {
      mode: "research",
      topic: "Practical applications of quantum computing",
      model: "gpt-4o",
      temperature: 0.5,
    },
  },
  {
    key: "costEstimate",
    label: "POST /cost-estimate",
    method: "POST",
    path: "/cost-estimate",
    sampleBody: {
      prompt: "Explain embeddings in AI.",
      expectedOutputTokens: 180,
    },
  },
  {
    key: "prompt",
    label: "POST /prompt",
    method: "POST",
    path: "/prompt",
    sampleBody: {
      topic: "How to improve sleep quality",
      audience: "fitness beginners",
      style: "actionable and concise",
      parser: "json",
      schemaFields: ["answer"],
      retries: 2,
      model: "gpt-4o",
      temperature: 0.4,
    },
  },
  {
    key: "promptEval",
    label: "POST /prompt/evaluate",
    method: "POST",
    path: "/prompt/evaluate",
    sampleBody: {
      tests: [
        "When should I consume creatine?",
        "How to warm up before squats?",
        "How much protein do beginners need?",
        "Best post-workout meal options",
        "Can I train when sore?",
        "How much water should I drink daily?",
        "How many rest days should I take?",
        "Difference between hypertrophy and strength",
        "What is progressive overload?",
        "How long should a beginner workout last?"
      ],
      schemaFields: ["answer"],
      retries: 2,
      model: "gpt-4o",
      temperature: 0.3,
    },
  },
];

const state = {
  baseUrl: "",
  selected: ENDPOINTS[0],
  history: [],
  chat: {
    userId: "",
    userName: "",
    conversation: [],
  },
};

const els = {
  chatUserName: document.getElementById("chatUserName"),
  openChatSession: document.getElementById("openChatSession"),
  chatSessionMeta: document.getElementById("chatSessionMeta"),
  chatTranscript: document.getElementById("chatTranscript"),
  chatPrompt: document.getElementById("chatPrompt"),
  sendChatMessage: document.getElementById("sendChatMessage"),
  clearChatView: document.getElementById("clearChatView"),
  chatStatus: document.getElementById("chatStatus"),
  endpointSelect: document.getElementById("endpointSelect"),
  requestBody: document.getElementById("requestBody"),
  loadSample: document.getElementById("loadSample"),
  sendRequest: document.getElementById("sendRequest"),
  clearResponse: document.getElementById("clearResponse"),
  requestStatus: document.getElementById("requestStatus"),
  httpStatus: document.getElementById("httpStatus"),
  latencyValue: document.getElementById("latencyValue"),
  tokensValue: document.getElementById("tokensValue"),
  costValue: document.getElementById("costValue"),
  responseOutput: document.getElementById("responseOutput"),
  historyList: document.getElementById("historyList"),
};

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function normalizeUserName(userName) {
  return String(userName || "").trim().toLowerCase();
}

function getConfiguredDefaultBaseUrl() {
  return normalizeBaseUrl(window.APP_CONFIG?.API_BASE_URL || "");
}

function populateEndpointSelect() {
  els.endpointSelect.innerHTML = "";
  ENDPOINTS.forEach((endpoint) => {
    const option = document.createElement("option");
    option.value = endpoint.key;
    option.textContent = endpoint.label;
    els.endpointSelect.appendChild(option);
  });
}

function getEndpointByKey(key) {
  return ENDPOINTS.find((endpoint) => endpoint.key === key) || ENDPOINTS[0];
}

function renderSelectedEndpoint() {
  if (state.selected.sampleBody) {
    els.requestBody.value = JSON.stringify(state.selected.sampleBody, null, 2);
    els.requestBody.disabled = false;
  } else {
    els.requestBody.value = "";
    els.requestBody.disabled = true;
  }
}

function setStatus(text, tone = "neutral") {
  els.requestStatus.textContent = text;
  els.requestStatus.style.color =
    tone === "error" ? "#9f291d" : tone === "success" ? "#145f42" : "#556264";
}

function setResponseMeta(statusLabel, payload) {
  els.httpStatus.textContent = statusLabel;

  const latency = payload?.latencyMs;
  const totalTokens = payload?.usage?.totalTokens;
  const cost = payload?.estimatedCost;

  els.latencyValue.textContent = Number.isFinite(latency) ? `${latency} ms` : "-";
  els.tokensValue.textContent = Number.isFinite(totalTokens) ? String(totalTokens) : "-";
  els.costValue.textContent = Number.isFinite(cost) ? `$${cost.toFixed(6)}` : "-";
}

function setResponseOutput(payload) {
  els.responseOutput.textContent = JSON.stringify(payload, null, 2);
}

function rememberHistory(item) {
  state.history.unshift(item);
  state.history = state.history.slice(0, 8);
  renderHistory();
}

function renderHistory() {
  if (state.history.length === 0) {
    els.historyList.innerHTML = "<li>No calls yet.</li>";
    return;
  }

  els.historyList.innerHTML = state.history
    .map(
      (entry) =>
        `<li><strong>${entry.method} ${entry.path}</strong> · ${entry.status} · ${entry.duration} ms</li>`
    )
    .join("");
}

function setChatStatus(text, tone = "neutral") {
  els.chatStatus.textContent = text;
  els.chatStatus.style.color =
    tone === "error" ? "#9f291d" : tone === "success" ? "#145f42" : "#556264";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderChatMeta() {
  if (!state.chat.userName) {
    els.chatSessionMeta.textContent = "No active session.";
    return;
  }

  const messageCount = Array.isArray(state.chat.conversation) ? state.chat.conversation.length : 0;
  els.chatSessionMeta.textContent = `username: ${state.chat.userName} · userId: ${state.chat.userId} · messages: ${messageCount}`;
}

function renderChatConversation() {
  const conversation = Array.isArray(state.chat.conversation) ? state.chat.conversation : [];

  if (conversation.length === 0) {
    els.chatTranscript.innerHTML =
      '<div class="chat-empty">No messages yet. Send the first message to start this chat.</div>';
    return;
  }

  els.chatTranscript.innerHTML = conversation
    .map((message) => {
      const isUser = message.role === "human";
      return `
        <article class="chat-bubble ${isUser ? "user" : "assistant"}">
          <span class="chat-role">${isUser ? "You" : "Assistant"}</span>
          <p class="chat-text">${escapeHtml(message.content || "")}</p>
        </article>
      `;
    })
    .join("");

  els.chatTranscript.scrollTop = els.chatTranscript.scrollHeight;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${normalizeBaseUrl(state.baseUrl)}${path}`, options);
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.error || `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

async function openChatSession() {
  const userName = normalizeUserName(els.chatUserName.value);
  if (!userName) {
    setChatStatus("Username is required.", "error");
    return;
  }

  els.openChatSession.disabled = true;
  setChatStatus("Loading chat session...");

  try {
    const payload = await requestJson("/talk/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userName }),
    });

    state.chat = {
      userId: payload.userId || "",
      userName: payload.userName || userName,
      conversation: Array.isArray(payload.conversation) ? payload.conversation : [],
    };

    els.chatUserName.value = state.chat.userName;
    renderChatMeta();
    renderChatConversation();
    setChatStatus(payload.existingChat ? "Existing chat loaded." : "New chat ready.", "success");
  } catch (error) {
    setChatStatus(error.message || "Failed to load chat session.", "error");
  } finally {
    els.openChatSession.disabled = false;
  }
}

async function sendChatMessage() {
  const userName = normalizeUserName(els.chatUserName.value);
  const prompt = els.chatPrompt.value.trim();

  if (!userName) {
    setChatStatus("Username is required.", "error");
    return;
  }

  if (!prompt) {
    setChatStatus("Message cannot be empty.", "error");
    return;
  }

  els.sendChatMessage.disabled = true;
  setChatStatus("Sending message...");

  try {
    const payload = await requestJson("/talk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userName,
        prompt,
        model: "gpt-4o",
        temperature: 0.7,
      }),
    });

    state.chat = {
      userId: payload.userId || "",
      userName: payload.userName || userName,
      conversation: Array.isArray(payload.conversation) ? payload.conversation : [],
    };

    els.chatUserName.value = state.chat.userName;
    els.chatPrompt.value = "";
    renderChatMeta();
    renderChatConversation();
    setChatStatus("Message sent.", "success");
  } catch (error) {
    setChatStatus(error.message || "Failed to send message.", "error");
  } finally {
    els.sendChatMessage.disabled = false;
  }
}

function clearChatView() {
  state.chat = {
    userId: "",
    userName: "",
    conversation: [],
  };
  els.chatUserName.value = "";
  els.chatPrompt.value = "";
  renderChatMeta();
  renderChatConversation();
  setChatStatus("Chat view cleared.");
}

function getRequestBody() {
  if (state.selected.method === "GET") {
    return undefined;
  }

  const raw = els.requestBody.value.trim();
  if (!raw) {
    throw new Error("Request body is required for this endpoint.");
  }

  return JSON.parse(raw);
}

async function sendRequest() {
  const baseUrl = normalizeBaseUrl(state.baseUrl);
  if (!baseUrl) {
    setStatus("API base URL not configured in config.js.", "error");
    return;
  }

  const url = `${baseUrl}${state.selected.path}`;

  let body;
  try {
    body = getRequestBody();
  } catch (error) {
    setStatus(error.message || "Invalid JSON body.", "error");
    return;
  }

  const init = {
    method: state.selected.method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (typeof body !== "undefined") {
    init.body = JSON.stringify(body);
  }

  const start = performance.now();
  setStatus("Sending request...");
  els.sendRequest.disabled = true;

  try {
    const response = await fetch(url, init);
    const duration = Math.round(performance.now() - start);

    let payload;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    setResponseMeta(`${response.status} ${response.statusText}`, payload);
    setResponseOutput(payload);

    rememberHistory({
      method: state.selected.method,
      path: state.selected.path,
      status: response.status,
      duration,
    });

    if (response.ok) {
      setStatus("Request completed.", "success");
    } else {
      setStatus("Request failed. Check response output.", "error");
    }
  } catch (error) {
    setResponseMeta("Network Error", {});
    setResponseOutput({ error: error.message || "Failed to call API." });
    setStatus("Network error while calling API.", "error");
  } finally {
    els.sendRequest.disabled = false;
  }
}

function clearResponse() {
  setResponseMeta("No request", {});
  setResponseOutput({ message: "Run a request to see output." });
  setStatus("Ready.");
}

function initBaseUrl() {
  state.baseUrl = getConfiguredDefaultBaseUrl();
}

function attachEvents() {
  els.openChatSession.addEventListener("click", openChatSession);
  els.sendChatMessage.addEventListener("click", sendChatMessage);
  els.clearChatView.addEventListener("click", clearChatView);
  els.chatPrompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      sendChatMessage();
    }
  });

  els.endpointSelect.addEventListener("change", (event) => {
    state.selected = getEndpointByKey(event.target.value);
    renderSelectedEndpoint();
  });

  els.loadSample.addEventListener("click", renderSelectedEndpoint);
  els.sendRequest.addEventListener("click", sendRequest);
  els.clearResponse.addEventListener("click", clearResponse);
}

function init() {
  populateEndpointSelect();
  initBaseUrl();
  state.selected = getEndpointByKey("talk");
  els.endpointSelect.value = state.selected.key;
  renderSelectedEndpoint();
  clearResponse();
  renderChatMeta();
  renderChatConversation();
  renderHistory();
  attachEvents();
}

init();
