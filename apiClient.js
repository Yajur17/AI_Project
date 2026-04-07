import dotenv from "dotenv";
import OpenAI from "openai";
import http from "http";
import fs from "fs";

dotenv.config();

const API_KEY = process.env.key;

if (!API_KEY) {
  throw new Error("Missing OpenAI API key. Set `key` in your .env file.");
}

const client = new OpenAI({ apiKey: API_KEY });

const INPUT_RATE_PER_1K = 0.00003;
const OUTPUT_RATE_PER_1K = 0.00006;
const MAX_REQUEST_SIZE = 1_000_000; // 1 MB

function logToFile(label, data) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${label}:\n${JSON.stringify(data, null, 2)}\n\n`;
  fs.appendFileSync("api_calls.log", entry);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_REQUEST_SIZE) {
        reject(new Error(`Request body exceeds maximum size of ${MAX_REQUEST_SIZE / 1_000_000}MB.`));
      }
    });

    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", () => reject(new Error("Failed to read request body.")));
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function estimateCost(inputTokens = 0, outputTokens = 0) {
  return (inputTokens * INPUT_RATE_PER_1K + outputTokens * OUTPUT_RATE_PER_1K) / 1000;
}

async function askOne({ prompt, model = "gpt-4o", temperature }) {
  const requestPayload = {
    model,
    input: [{ role: "user", content: prompt }],
  };

  if (typeof temperature === "number") {
    requestPayload.temperature = temperature;
  }

  logToFile("OPENAI REQUEST", requestPayload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  const startTime = Date.now();
  let response;
  try {
    response = await client.responses.create(requestPayload, { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("OpenAI request timed out after 10 seconds.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const endTime = Date.now();
  const latencyMs = endTime - startTime;

  logToFile("OPENAI RESPONSE", {
    model: response.model,
    outputText: response.output_text,
    usage: response.usage,
    latencyMs,
  });
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;

  return {
    prompt,
    outputText: response.output_text,
    usage: { inputTokens, outputTokens, totalTokens },
    estimatedCost: estimateCost(inputTokens, outputTokens),
    latencyMs,
  };
}

function isValidPrompt(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTemperature(value) {
  return typeof value === "undefined" || typeof value === "number";
}

function isValidModel(value) {
  return typeof value === "undefined" || typeof value === "string";
}

function startServer(port = Number(process.env.PORT) || 3004) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/ask") {
      try {
        const { prompt, temperature, model } = await readJsonBody(req);
        logToFile("/ask REQUEST", { prompt, temperature, model });

        if (!isValidPrompt(prompt)) {
          sendJson(res, 400, { error: "`prompt` must be a non-empty string." });
          return;
        }

        if (!isValidTemperature(temperature)) {
          sendJson(res, 400, { error: "`temperature` must be a number when provided." });
          return;
        }

        if (!isValidModel(model)) {
          sendJson(res, 400, { error: "`model` must be a string when provided." });
          return;
        }

        const result = await askOne({ prompt, temperature, model });
        logToFile("/ask RESPONSE", result);
        sendJson(res, 200, result);
      } catch (error) {
        logToFile("/ask ERROR", { error: error.message || "Internal server error." });
        sendJson(res, 500, { error: error.message || "Internal server error." });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
      return;
    }

    if (req.method === "POST" && req.url === "/batch") {
      try {
        const { prompts, temperature, model } = await readJsonBody(req);
        logToFile("/batch REQUEST", {
          promptsCount: Array.isArray(prompts) ? prompts.length : 0,
          temperature,
          model,
        });

       if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 5) {
          sendJson(res, 400, { error: "`prompts` must be an array of 1 to 5 prompt strings." });
          return;
        }

        const allValid = prompts.every((p) => isValidPrompt(p));
        if (!allValid) {
          sendJson(res, 400, { error: "Each prompt in `prompts` must be a non-empty string." });
          return;
        }

        const uniquePrompts = new Set(prompts.map((p) => p.trim().toLowerCase()));
        if (uniquePrompts.size !== prompts.length) {
          sendJson(res, 400, { error: "All prompts in the array must be unique (duplicates detected after normalization). No semantically identical prompts allowed." });
          return;
        }

        if (!isValidTemperature(temperature)) {
          sendJson(res, 400, { error: "`temperature` must be a number when provided." });
          return;
        }

        if (!isValidModel(model)) {
          sendJson(res, 400, { error: "`model` must be a string when provided." });
          return;
        }

        const results = await Promise.all(
          prompts.map((prompt) => askOne({ prompt, temperature, model }))
        );

        logToFile("/batch RESPONSE", { count: results.length });
        sendJson(res, 200, { count: results.length, results });
      } catch (error) {
        logToFile("/batch ERROR", { error: error.message || "Internal server error." });
        sendJson(res, 500, { error: error.message || "Internal server error." });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/cost-estimate") {
      try {
        const { prompt, expectedOutputTokens = 200 } = await readJsonBody(req);
        logToFile("/cost-estimate REQUEST", { prompt, expectedOutputTokens });

        if (!isValidPrompt(prompt)) {
          sendJson(res, 400, { error: "`prompt` must be a non-empty string." });
          return;
        }

        if (
          typeof expectedOutputTokens !== "number" ||
          !Number.isFinite(expectedOutputTokens) ||
          expectedOutputTokens < 0
        ) {
          sendJson(res, 400, { error: "`expectedOutputTokens` must be a non-negative number." });
          return;
        }

        const estimatedInputTokens = Math.ceil(prompt.length / 4);
        const estimatedCost = estimateCost(estimatedInputTokens, expectedOutputTokens);

        const responsePayload = {
          estimatedInputTokens,
          expectedOutputTokens,
          estimatedCost,
          rates: {
            inputPer1K: INPUT_RATE_PER_1K,
            outputPer1K: OUTPUT_RATE_PER_1K,
          },
        };

        logToFile("/cost-estimate RESPONSE", responsePayload);

        sendJson(res, 200, responsePayload);
      } catch (error) {
        logToFile("/cost-estimate ERROR", {
          error: error.message || "Internal server error.",
        });
        sendJson(res, 500, { error: error.message || "Internal server error." });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/models") {
      try {
        logToFile("/models REQUEST", {});
        const models = await client.models.list();
        const ids = (models.data || []).map((m) => m.id);
        logToFile("/models RESPONSE", { count: ids.length });
        sendJson(res, 200, { count: ids.length, models: ids });
      } catch (error) {
        logToFile("/models ERROR", { error: error.message || "Internal server error." });
        sendJson(res, 500, { error: error.message || "Internal server error." });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  });

  server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  return server;
}

startServer();
