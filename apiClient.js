import dotenv from "dotenv";
import OpenAI from "openai";
import express from "express";
import serverless from "serverless-http";
import fs from "fs";
import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { runHelloWorldChain, runResearchChain } from "./langchainChain.js";

dotenv.config({ quiet: true });

const LOG_LEVEL = (process.env.LOG_LEVEL).toLowerCase();
const LOG_SUCCESS_SAMPLE_RATE = Number(process.env.LOG_SUCCESS_SAMPLE_RATE || "0.25");
const INCLUDE_PROMPT_IN_LOGS = process.env.INCLUDE_PROMPT_IN_LOGS === "true";
const ENABLE_FILE_LOGS =
  typeof process.env.ENABLE_FILE_LOGS === "string"
    ? process.env.ENABLE_FILE_LOGS === "true"
    : !process.env.AWS_LAMBDA_FUNCTION_NAME;
const ENABLE_DDB_AUDIT =
  typeof process.env.ENABLE_DDB_AUDIT === "string"
    ? process.env.ENABLE_DDB_AUDIT === "true"
    : !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DDB_TABLE_NAME = process.env.DDB_TABLE_NAME || "aiproject";

const LOG_PRIORITY = {
  error: 0,
  info: 1,
  debug: 2,
};

function shouldLog(level) {
  const current = LOG_PRIORITY[LOG_LEVEL] ?? LOG_PRIORITY.info;
  const target = LOG_PRIORITY[level] ?? LOG_PRIORITY.info;
  return target <= current;
}

function writeLog(level, event, data = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

const API_KEY = process.env.OPENAI_API_KEY || process.env.key;

if (!API_KEY) {
  throw new Error(
    "Missing OpenAI API key. Set OPENAI_API_KEY or `key` in .env (local) or Lambda environment variables."
  );
}

const client = new OpenAI({ apiKey: API_KEY });
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

const INPUT_RATE_PER_1K = 0.00003;
const OUTPUT_RATE_PER_1K = 0.00006;
const MAX_BODY_SIZE = "1mb";

const LOG_PATH = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/tmp/api_calls.log"
  : "api_calls.log";

function logToFile(label, data) {
  if (!ENABLE_FILE_LOGS) {
    return;
  }
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${label}:\n${JSON.stringify(data, null, 2)}\n\n`;
  fs.appendFileSync(LOG_PATH, entry);
}

function estimateCost(inputTokens = 0, outputTokens = 0) {
  return (inputTokens * INPUT_RATE_PER_1K + outputTokens * OUTPUT_RATE_PER_1K) / 1000;
}

function sanitizeHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "authorization" ||
      lowerKey === "x-api-key" ||
      lowerKey === "cookie" ||
      lowerKey === "set-cookie"
    ) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = value;
  }
  return output;
}

function fitForDynamo(data) {
  const raw = JSON.stringify(data);
  if (Buffer.byteLength(raw, "utf8") <= 350000) {
    return data;
  }

  return {
    truncated: true,
    reason: "Payload exceeded DynamoDB item size safety limit.",
    payloadPreview: raw.slice(0, 20000),
    payloadBytes: Buffer.byteLength(raw, "utf8"),
  };
}

async function writeAuditRecord({ created, requestId, data }) {
  if (!ENABLE_DDB_AUDIT) {
    return;
  }

  try {
    await ddbDocClient.send(
      new PutCommand({
        TableName: DDB_TABLE_NAME,
        Item: {
          created,
          requestId,
          data: fitForDynamo(data),
        },
      })
    );
  } catch (error) {
    writeLog("error", "dynamodb_audit_write_failed", {
      message: error?.message || "Unknown DynamoDB write error.",
      tableName: DDB_TABLE_NAME,
      requestId,
    });
  }
}

async function askOne({ prompt, model = "gpt-4o", temperature }) {
  const requestPayload = {
    model,
    input: [{ role: "user", content: prompt }],
  };

  if (typeof temperature === "number") {
    requestPayload.temperature = temperature;
  }

  const requestSummary = {
    model,
    temperature: typeof temperature === "number" ? temperature : null,
    promptChars: prompt.length,
  };

  if (INCLUDE_PROMPT_IN_LOGS) {
    requestSummary.prompt = prompt;
  }

  writeLog("debug", "openai_request", requestSummary);
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

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;

  const responseSummary = {
    model: response.model,
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs,
  };

  if (INCLUDE_PROMPT_IN_LOGS) {
    responseSummary.outputText = response.output_text;
  }

  writeLog("debug", "openai_response", responseSummary);
  logToFile("OPENAI RESPONSE", {
    model: response.model,
    outputText: response.output_text,
    usage: response.usage,
    latencyMs,
  });

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

const app = express();
app.use(express.json({ limit: MAX_BODY_SIZE }));

app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = String(req.headers["x-request-id"] || randomUUID());
  const created = new Date().toISOString();
  res.setHeader("x-request-id", requestId);

  let responseBody;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (payload) => {
    responseBody = payload;
    return originalJson(payload);
  };

  res.send = (payload) => {
    if (typeof responseBody === "undefined") {
      responseBody = payload;
    }
    return originalSend(payload);
  };

  res.on("finish", () => {
    const latencyMs = Date.now() - startTime;
    const isError = res.statusCode >= 500;
    const shouldSampleSuccess = Math.random() < LOG_SUCCESS_SAMPLE_RATE;

    if (!isError && !shouldSampleSuccess && LOG_LEVEL !== "debug") {
      return;
    }

    writeLog(isError ? "error" : "info", "http_request", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      latencyMs,
      requestId,
    });

    writeAuditRecord({
      created,
      requestId,
      data: {
        endpoint: req.originalUrl,
        method: req.method,
        latencyMs,
        statusCode: res.statusCode,
        request: {
          headers: sanitizeHeaders(req.headers || {}),
          query: req.query || {},
          params: req.params || {},
          body: req.body,
        },
        response: {
          headers: sanitizeHeaders(
            typeof res.getHeaders === "function" ? res.getHeaders() : {}
          ),
          body: responseBody,
        },
      },
    });
  });
  next();
});

app.post("/ask", async (req, res) => {
  try {
    const { prompt, temperature, model } = req.body ?? {};
    logToFile("/ask REQUEST", {
      prompt: INCLUDE_PROMPT_IN_LOGS ? prompt : "[redacted]",
      temperature,
      model,
    });

    if (!isValidPrompt(prompt)) {
      res.status(400).json({ error: "`prompt` must be a non-empty string." });
      return;
    }

    if (!isValidTemperature(temperature)) {
      res.status(400).json({ error: "`temperature` must be a number when provided." });
      return;
    }

    if (!isValidModel(model)) {
      res.status(400).json({ error: "`model` must be a string when provided." });
      return;
    }

    const result = await askOne({ prompt, temperature, model });
    logToFile("/ask RESPONSE", result);
    res.status(200).json(result);
  } catch (error) {
    writeLog("error", "ask_error", { message: error.message || "Internal server error." });
    logToFile("/ask ERROR", { error: error.message || "Internal server error." });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/batch", async (req, res) => {
  try {
    const { prompts, temperature, model } = req.body ?? {};
    logToFile("/batch REQUEST", {
      promptsCount: Array.isArray(prompts) ? prompts.length : 0,
      temperature,
      model,
    });

    if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 5) {
      res.status(400).json({ error: "`prompts` must be an array of 1 to 5 prompt strings." });
      return;
    }

    const allValid = prompts.every((p) => isValidPrompt(p));
    if (!allValid) {
      res.status(400).json({ error: "Each prompt in `prompts` must be a non-empty string." });
      return;
    }

    const uniquePrompts = new Set(prompts.map((p) => p.trim().toLowerCase()));
    if (uniquePrompts.size !== prompts.length) {
      res.status(400).json({
        error:
          "All prompts in the array must be unique (duplicates detected after normalization). No semantically identical prompts allowed.",
      });
      return;
    }

    if (!isValidTemperature(temperature)) {
      res.status(400).json({ error: "`temperature` must be a number when provided." });
      return;
    }

    if (!isValidModel(model)) {
      res.status(400).json({ error: "`model` must be a string when provided." });
      return;
    }

    const results = await Promise.all(
      prompts.map((prompt) => askOne({ prompt, temperature, model }))
    );

    logToFile("/batch RESPONSE", { count: results.length });
    res.status(200).json({ count: results.length, results });
  } catch (error) {
    writeLog("error", "batch_error", { message: error.message || "Internal server error." });
    logToFile("/batch ERROR", { error: error.message || "Internal server error." });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.post("/cost-estimate", async (req, res) => {
  try {
    const { prompt, expectedOutputTokens = 200 } = req.body ?? {};
    logToFile("/cost-estimate REQUEST", {
      prompt: INCLUDE_PROMPT_IN_LOGS ? prompt : "[redacted]",
      expectedOutputTokens,
    });

    if (!isValidPrompt(prompt)) {
      res.status(400).json({ error: "`prompt` must be a non-empty string." });
      return;
    }

    if (
      typeof expectedOutputTokens !== "number" ||
      !Number.isFinite(expectedOutputTokens) ||
      expectedOutputTokens < 0
    ) {
      res.status(400).json({ error: "`expectedOutputTokens` must be a non-negative number." });
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

    res.status(200).json(responsePayload);
  } catch (error) {
    writeLog("error", "cost_estimate_error", {
      message: error.message || "Internal server error.",
    });
    logToFile("/cost-estimate ERROR", {
      error: error.message || "Internal server error.",
    });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.get("/models", async (req, res) => {
  try {
    logToFile("/models REQUEST", {});
    const models = await client.models.list();
    const ids = (models.data || []).map((m) => m.id);
    logToFile("/models RESPONSE", { count: ids.length });
    res.status(200).json({ count: ids.length, models: ids });
  } catch (error) {
    writeLog("error", "models_error", { message: error.message || "Internal server error." });
    logToFile("/models ERROR", { error: error.message || "Internal server error." });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.post("/chain", async (req, res) => {
  try {
    const { mode = "hello", question, topic, temperature, model } = req.body ?? {};

    logToFile("/chain REQUEST", {
      mode,
      question: INCLUDE_PROMPT_IN_LOGS ? question : "[redacted]",
      topic: INCLUDE_PROMPT_IN_LOGS ? topic : "[redacted]",
      temperature,
      model,
    });

    if (mode === "hello") {
      if (!isValidPrompt(question)) {
        res.status(400).json({ error: "`question` must be a non-empty string." });
        return;
      }
      if (!isValidTemperature(temperature)) {
        res.status(400).json({ error: "`temperature` must be a number when provided." });
        return;
      }
      const result = await runHelloWorldChain({ question, model, temperature });
      logToFile("/chain RESPONSE", result);
      res.status(200).json(result);
      return;
    }

    if (mode === "research") {
      if (!isValidPrompt(topic)) {
        res.status(400).json({ error: "`topic` must be a non-empty string." });
        return;
      }
      if (!isValidTemperature(temperature)) {
        res.status(400).json({ error: "`temperature` must be a number when provided." });
        return;
      }
      const result = await runResearchChain({ topic, model, temperature });
      logToFile("/chain RESPONSE", result);
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: "`mode` must be 'hello' or 'research'." });
  } catch (error) {
    writeLog("error", "chain_error", { message: error.message || "Internal server error." });
    logToFile("/chain ERROR", { error: error.message || "Internal server error." });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    res.status(400).json({ error: "Invalid JSON body." });
    return;
  }
  next(err);
});

export const handler = serverless(app);

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = Number(process.env.PORT) || 3004;
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}
