const ENDPOINTS = [
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
};

const els = {
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
  state.selected = ENDPOINTS[0];
  els.endpointSelect.value = state.selected.key;
  renderSelectedEndpoint();
  clearResponse();
  renderHistory();
  attachEvents();
}

init();
