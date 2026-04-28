import OpenAI from "openai";
import express from "express";
import serverless from "serverless-http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser, StringOutputParser } from "@langchain/core/output_parsers";
import { BufferMemory as ConversationBufferMemory, ChatMessageHistory } from "langchain/memory";
import { runHelloWorldChain, runResearchChain } from "./langchainChain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  try {
    const dotenv = await import("dotenv");
    dotenv.default.config({ quiet: true });
  } catch (err) {
    console.warn("dotenv not available (expected in Lambda):", err.message);
  }
}

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
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
const CHAT_DDB_TABLE_NAME = process.env.CHAT_DDB_TABLE_NAME || "aiproject_chat";
const CHAT_USERNAME_INDEX_NAME =
  process.env.CHAT_USERNAME_INDEX_NAME || "UserNameCreatedIndex";

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

let ddbDocClient = null;
function getDdbDocClient() {
  if (!ddbDocClient) {
    try {
      const ddbClient = new DynamoDBClient({});
      ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
    } catch (error) {
      writeLog("warn", "dynamodb_init_failed", {
        message: error?.message || "Could not initialize DynamoDB client.",
        context: "Will skip audit logging.",
      });
      return null;
    }
  }
  return ddbDocClient;
}

const INPUT_RATE_PER_1K = 0.00003;
const OUTPUT_RATE_PER_1K = 0.00006;
const MAX_BODY_SIZE = "1mb";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const LOG_PATH = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/tmp/api_calls.log"
  : "api_calls.log";
const CHAT_MEMORY_PATH = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/tmp/chat-memory.json"
  : path.join(__dirname, "chat-memory.json");

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

function isValidUserId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeUserName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidUserName(value) {
  return normalizeUserName(value).length > 0;
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

  const docClient = getDdbDocClient();
  if (!docClient) {
    return;
  }

  try {
    await docClient.send(
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

async function writeChatRecord({ userId, userName, created, data }) {
  if (!ENABLE_DDB_AUDIT) {
    return;
  }

  const docClient = getDdbDocClient();
  if (!docClient) {
    return;
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: CHAT_DDB_TABLE_NAME,
        Item: {
          userId,
          userName,
          created,
          data: fitForDynamo(data),
        },
      })
    );
  } catch (error) {
    writeLog("error", "dynamodb_chat_write_failed", {
      message: error?.message || "Unknown DynamoDB write error.",
      tableName: CHAT_DDB_TABLE_NAME,
      userId,
    });
  }
}

async function findLatestChatByUserName(userName) {
  const normalizedUserName = normalizeUserName(userName);
  if (!normalizedUserName) {
    return null;
  }

  const docClient = getDdbDocClient();
  if (!docClient) {
    return null;
  }

  try {
    const response = await docClient.send(
      new QueryCommand({
        TableName: CHAT_DDB_TABLE_NAME,
        IndexName: CHAT_USERNAME_INDEX_NAME,
        KeyConditionExpression: "userName = :userName",
        ExpressionAttributeValues: {
          ":userName": normalizedUserName,
        },
        ScanIndexForward: false,
        Limit: 1,
      })
    );

    return response.Items?.[0] || null;
  } catch (error) {
    if (error?.message?.includes("does not have the specified index")) {
      try {
        const fallbackResponse = await docClient.send(
          new ScanCommand({
            TableName: CHAT_DDB_TABLE_NAME,
            FilterExpression: "userName = :userName",
            ExpressionAttributeValues: {
              ":userName": normalizedUserName,
            },
          })
        );

        return (fallbackResponse.Items || [])
          .sort((left, right) => String(right.created || "").localeCompare(String(left.created || "")))[0] || null;
      } catch (fallbackError) {
        writeLog("error", "dynamodb_chat_lookup_fallback_failed", {
          message: fallbackError?.message || "Unknown DynamoDB scan error.",
          tableName: CHAT_DDB_TABLE_NAME,
          userName: normalizedUserName,
        });
        return null;
      }
    }

    writeLog("error", "dynamodb_chat_lookup_failed", {
      message: error?.message || "Unknown DynamoDB query error.",
      tableName: CHAT_DDB_TABLE_NAME,
      indexName: CHAT_USERNAME_INDEX_NAME,
      userName: normalizedUserName,
    });
    return null;
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

function isValidParserMode(value) {
  return (
    typeof value === "undefined" ||
    value === "string" ||
    value === "json" ||
    value === "regex" ||
    value === "custom"
  );
}

function isValidRetryCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

function extractJsonSnippet(text) {
  if (typeof text !== "string") {
    return "";
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }

  return text.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSchemaFields(fields) {
  if (!Array.isArray(fields)) {
    return [];
  }

  return Array.from(
    new Set(
      fields
        .map((field) => String(field).trim())
        .filter((field) => field.length > 0)
    )
  );
}

function normalizeParsedValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

function validateStructuredRecord(record, schemaFields = []) {
  if (!isPlainObject(record)) {
    return { ok: false, reason: "Parsed output is not an object." };
  }

  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, normalizeParsedValue(value)])
  );

  if (schemaFields.length === 0) {
    if (Object.keys(normalized).length === 0) {
      return { ok: false, reason: "Parsed output is empty." };
    }
    return { ok: true, value: normalized };
  }

  for (const field of schemaFields) {
    if (!(field in normalized)) {
      return { ok: false, reason: `Missing required field: ${field}.` };
    }

    const value = normalized[field];
    if (typeof value === "string" && value.trim().length === 0) {
      return { ok: false, reason: `Field ${field} is empty.` };
    }
    if (Array.isArray(value) && value.length === 0) {
      return { ok: false, reason: `Field ${field} is empty.` };
    }
    if (value === null || typeof value === "undefined") {
      return { ok: false, reason: `Field ${field} is empty.` };
    }
  }

  return { ok: true, value: normalized };
}

function parseKeyValueLines(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const result = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_ ]{2,40})\s*[:\-]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    const value = match[2].trim();
    if (key.length > 0 && value.length > 0) {
      result[key] = value;
    }
  }

  return result;
}

async function parseWithJsonStrategy(rawText, schemaFields = []) {
  const parser = new JsonOutputParser();
  const candidate = extractJsonSnippet(rawText);
  const parsed = await parser.invoke(candidate);

  if (isPlainObject(parsed)) {
    return validateStructuredRecord(parsed, schemaFields);
  }

  if (schemaFields.length === 1) {
    return validateStructuredRecord({ [schemaFields[0]]: parsed }, schemaFields);
  }

  return validateStructuredRecord({ answer: parsed }, schemaFields);
}

function parseWithRegexStrategy(rawText, schemaFields = []) {
  const kv = parseKeyValueLines(rawText);
  if (Object.keys(kv).length > 0) {
    return validateStructuredRecord(kv, schemaFields);
  }

  if (schemaFields.length === 1) {
    return validateStructuredRecord({ [schemaFields[0]]: String(rawText || "").trim() }, schemaFields);
  }

  return validateStructuredRecord({ answer: String(rawText || "").trim() }, schemaFields);
}

function parseWithCustomStrategy(rawText, schemaFields = []) {
  const text = String(rawText || "").replace(/\r/g, "").trim();

  const jsonCandidate = extractJsonSnippet(text);
  if (jsonCandidate.startsWith("{") && jsonCandidate.endsWith("}")) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      const validated = validateStructuredRecord(parsed, schemaFields);
      if (validated.ok) {
        return validated;
      }
    } catch {
      // Continue to heuristic parsing.
    }
  }

  const kv = parseKeyValueLines(text);
  if (Object.keys(kv).length > 0) {
    const validated = validateStructuredRecord(kv, schemaFields);
    if (validated.ok) {
      return validated;
    }
  }

  const bulletPoints = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*\d.)]\s+/.test(line))
    .map((line) => line.replace(/^[-*\d.)]\s+/, "").trim())
    .filter((line) => line.length > 0);

  const fallback = { answer: text };
  if (bulletPoints.length > 0) {
    fallback.key_points = bulletPoints;
  }

  if (schemaFields.length === 1 && !(schemaFields[0] in fallback)) {
    return validateStructuredRecord({ [schemaFields[0]]: text }, schemaFields);
  }

  return validateStructuredRecord(fallback, schemaFields);
}

function getExtractionInstructionByStrategy(strategy, schemaFields = []) {
  const schemaText =
    schemaFields.length > 0
      ? `Required fields: ${schemaFields.join(", ")}.`
      : "If no explicit fields are requested, return at least one useful field like answer.";

  if (strategy === "json") {
    return (
      `${schemaText} ` +
      "Return ONLY valid JSON. Do not include markdown or explanations outside JSON."
    );
  }

  if (strategy === "regex") {
    return (
      `${schemaText} ` +
      "Return plain text key-value lines in the format `Field: Value`, one field per line."
    );
  }

  return (
    `${schemaText} ` +
    "Return concise content and ensure required fields are explicit and parseable."
  );
}

function getStructuredPrompt({ instruction, sourceTask, previousError }) {
  if (!previousError) {
    return (
      "You are an information extraction assistant.\n" +
      `${instruction}\n\n` +
      `Task: ${sourceTask}`
    );
  }

  return (
    "You are an information extraction assistant.\n" +
    `${instruction}\n` +
    `Your previous answer could not be parsed because: ${previousError}\n` +
    "Fix the format and return a parseable response.\n\n" +
    `Task: ${sourceTask}`
  );
}

async function parseByStrategy({ strategy, rawText, schemaFields }) {
  if (strategy === "json") {
    return parseWithJsonStrategy(rawText, schemaFields);
  }
  if (strategy === "regex") {
    return parseWithRegexStrategy(rawText, schemaFields);
  }
  return parseWithCustomStrategy(rawText, schemaFields);
}

async function extractStructuredWithRetries({
  llm,
  sourceTask,
  strategy,
  schemaFields = [],
  maxRetries,
  includeRawAttempts = false,
}) {
  const attempts = [];
  const instruction = getExtractionInstructionByStrategy(strategy, schemaFields);
  let previousError = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const formattedPrompt = getStructuredPrompt({
      instruction,
      sourceTask,
      previousError,
    });

    const llmResult = await llm.invoke(formattedPrompt);
    const rawText = messageContentToText(llmResult.content);
    const parsed = await parseByStrategy({ strategy, rawText, schemaFields });

    attempts.push({
      attempt,
      ok: parsed.ok,
      reason: parsed.ok ? null : parsed.reason,
      rawOutput: includeRawAttempts ? rawText : undefined,
    });

    if (parsed.ok) {
      const inputTokens = llmResult.usage_metadata?.input_tokens ?? 0;
      const outputTokens = llmResult.usage_metadata?.output_tokens ?? 0;
      const totalTokens = llmResult.usage_metadata?.total_tokens ?? inputTokens + outputTokens;
      return {
        ok: true,
        parsedOutput: parsed.value,
        rawOutput: rawText,
        attempts,
        usage: { inputTokens, outputTokens, totalTokens },
      };
    }

    previousError = parsed.reason;
  }

  return {
    ok: false,
    attempts,
    error:
      attempts[attempts.length - 1]?.reason ||
      "Model output could not be parsed with selected strategy.",
  };
}

const DEFAULT_EXTRACTION_TEST_INPUTS = [
  "When should I consume creatine?",
  "Explain progressive overload in simple words.",
  "What should I eat before a morning workout?",
  "How much sleep do beginners need for muscle recovery?",
  "Difference between whey concentrate and isolate.",
  "How to improve squat depth safely?",
  "What are signs of overtraining?",
  "Create a 3-day beginner gym split.",
  "Best hydration tips during summer workouts.",
  "Should I do cardio before or after weights?",
];

function buildStrategySummary(rows) {
  const total = rows.length;
  const successes = rows.filter((row) => row.success).length;
  const failures = total - successes;
  const successRate = total > 0 ? Number((successes / total).toFixed(4)) : 0;
  const averageAttempts =
    total > 0
      ? Number(
          (
            rows.reduce((sum, row) => sum + (row.attemptCount || 0), 0) /
            total
          ).toFixed(2)
        )
      : 0;

  return {
    total,
    successes,
    failures,
    successRate,
    averageAttempts,
  };
}

function messageContentToText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n")
      .trim();
  }

  return String(content ?? "");
}

function buildConversationMemory(messages = []) {
  return new ConversationBufferMemory({
    memoryKey: "chat_history",
    inputKey: "input",
    outputKey: "output",
    humanPrefix: "User",
    aiPrefix: "Assistant",
    chatHistory: new ChatMessageHistory(messages),
  });
}

function restoreStoredChatMessage(message) {
  if (!message || typeof message.content !== "string") {
    return null;
  }

  if (message.role === "ai") {
    return new AIMessage(message.content);
  }

  if (message.role === "human") {
    return new HumanMessage(message.content);
  }

  return null;
}

function serializeChatMessages(messages = []) {
  return messages.map((message) => ({
    role: typeof message._getType === "function" ? message._getType() : "unknown",
    content: messageContentToText(message.content),
  }));
}

function buildConversationSession({ userId, userName, messages = [] }) {
  return {
    userId: isValidUserId(userId) ? userId.trim() : randomUUID(),
    userName: normalizeUserName(userName),
    memory: buildConversationMemory(messages),
  };
}

function getStoredConversationRecords(storedValue) {
  if (Array.isArray(storedValue)) {
    return storedValue;
  }

  if (storedValue && typeof storedValue === "object" && Array.isArray(storedValue.conversation)) {
    return storedValue.conversation;
  }

  return [];
}

function restoreConversationSession(userName, storedValue) {
  const normalizedUserName = normalizeUserName(userName || storedValue?.userName);
  const restoredMessages = getStoredConversationRecords(storedValue)
    .map(restoreStoredChatMessage)
    .filter(Boolean);

  return buildConversationSession({
    userId: storedValue?.userId,
    userName: normalizedUserName,
    messages: restoredMessages,
  });
}

const conversationSessions = new Map();

function loadConversationMemoryStore() {
  if (!fs.existsSync(CHAT_MEMORY_PATH)) {
    return;
  }

  try {
    const raw = fs.readFileSync(CHAT_MEMORY_PATH, "utf8");
    if (!raw.trim()) {
      return;
    }

    const parsed = JSON.parse(raw);
    for (const [userName, storedValue] of Object.entries(parsed)) {
      const normalizedUserName = normalizeUserName(userName || storedValue?.userName);
      if (!normalizedUserName) {
        continue;
      }

      conversationSessions.set(
        normalizedUserName,
        restoreConversationSession(normalizedUserName, storedValue)
      );
    }
  } catch (error) {
    writeLog("error", "chat_memory_load_failed", {
      message: error?.message || "Could not load chat memory file.",
      path: CHAT_MEMORY_PATH,
    });
  }
}

async function persistConversationMemoryStore() {
  const payload = {};

  for (const [userName, session] of conversationSessions.entries()) {
    payload[userName] = {
      userId: session.userId,
      userName: session.userName,
      conversation: serializeChatMessages(await session.memory.chatHistory.getMessages()),
    };
  }

  fs.writeFileSync(CHAT_MEMORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function getConversationSession(userName) {
  const normalizedUserName = normalizeUserName(userName);
  let session = conversationSessions.get(normalizedUserName);

  if (session) {
    return session;
  }

  const latestChat = await findLatestChatByUserName(normalizedUserName);
  if (latestChat) {
    session = restoreConversationSession(normalizedUserName, {
      userId: latestChat.userId,
      userName: latestChat.userName,
      conversation: latestChat.data?.conversation,
    });
    conversationSessions.set(normalizedUserName, session);
    await persistConversationMemoryStore();
    return session;
  }

  session = buildConversationSession({ userName: normalizedUserName });
  conversationSessions.set(normalizedUserName, session);
  await persistConversationMemoryStore();
  return session;
}

loadConversationMemoryStore();

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAnyOrigin = FRONTEND_ORIGINS.includes("*");
  const isAllowedOrigin = allowAnyOrigin || (origin && FRONTEND_ORIGINS.includes(origin));

  if (allowAnyOrigin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (isAllowedOrigin && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Request-Id,X-Api-Key"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});
app.use(express.json({ limit: MAX_BODY_SIZE }));

// Serve static frontend — only in local dev (not in Lambda)
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.use(express.static(path.join(__dirname, "frontend")));
}

app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = String(req.headers["x-request-id"] || randomUUID());
  const created = new Date().toISOString();
  res.setHeader("x-request-id", requestId);

  let responseBody;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = async (payload) => {
    responseBody = payload;
    const latencyMs = Date.now() - startTime;
    const isError = (res.statusCode || 200) >= 500;
    const shouldSampleSuccess = Math.random() < LOG_SUCCESS_SAMPLE_RATE;

    // Await audit write BEFORE sending response so Lambda doesn't freeze mid-write
    await writeAuditRecord({
      created,
      requestId,
      data: {
        endpoint: req.originalUrl,
        method: req.method,
        latencyMs,
        statusCode: res.statusCode || 200,
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
          body: payload,
        },
      },
    });

    if (isError || shouldSampleSuccess || LOG_LEVEL === "debug") {
      writeLog(isError ? "error" : "info", "http_request", {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode || 200,
        latencyMs,
        requestId,
      });
    }

    return originalJson(payload);
  };

  res.send = (payload) => {
    if (typeof responseBody === "undefined") {
      responseBody = payload;
    }
    return originalSend(payload);
  };
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

app.post("/talk", async (req, res) => {
  try {
    const { userName, prompt, temperature, model } = req.body ?? {};

    logToFile("/talk REQUEST", {
      userName: normalizeUserName(userName),
      prompt: INCLUDE_PROMPT_IN_LOGS ? prompt : "[redacted]",
      temperature,
      model,
    });

    if (!isValidUserName(userName)) {
      res.status(400).json({ error: "`userName` must be a non-empty string." });
      return;
    }

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

    const normalizedUserName = normalizeUserName(userName);
    const session = await getConversationSession(normalizedUserName);
    const memoryVariables = await session.memory.loadMemoryVariables({});
    const chatHistory = String(memoryVariables.chat_history || "");

    const llm = new ChatOpenAI({
      apiKey: API_KEY,
      model: model || "gpt-4o",
      ...(typeof temperature === "number" ? { temperature } : {}),
    });

    const talkPrompt = PromptTemplate.fromTemplate(
      "You are a helpful assistant in an ongoing conversation. " +
        "Use prior context when it matters, otherwise answer directly.\n\n" +
        "Conversation so far:\n{chat_history}\n" +
        "User: {input}\n" +
        "Assistant:"
    );

    const chain = talkPrompt.pipe(llm);
    const startTime = Date.now();
    const result = await chain.invoke({
      chat_history: chatHistory || "No previous conversation.",
      input: prompt,
    });
    const latencyMs = Date.now() - startTime;

    const outputText = messageContentToText(result.content);
    await session.memory.saveContext({ input: prompt }, { output: outputText });
    await persistConversationMemoryStore();

    const conversation = serializeChatMessages(await session.memory.chatHistory.getMessages());
    const inputTokens = result.usage_metadata?.input_tokens ?? 0;
    const outputTokens = result.usage_metadata?.output_tokens ?? 0;
    const totalTokens = result.usage_metadata?.total_tokens ?? inputTokens + outputTokens;
    const created = new Date().toISOString();

    await writeChatRecord({
      userId: session.userId,
      userName: session.userName,
      created,
      data: {
        prompt,
        outputText,
        conversation,
        usage: { inputTokens, outputTokens, totalTokens },
        latencyMs,
      },
    });

    const responsePayload = {
      userId: session.userId,
      userName: session.userName,
      outputText,
      conversation,
      usage: { inputTokens, outputTokens, totalTokens },
      estimatedCost: estimateCost(inputTokens, outputTokens),
      latencyMs,
    };

    logToFile("/talk RESPONSE", {
      userId: session.userId,
      userName: session.userName,
      messageCount: conversation.length,
      usage: responsePayload.usage,
      latencyMs,
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    writeLog("error", "talk_error", { message: error.message || "Internal server error." });
    logToFile("/talk ERROR", { error: error.message || "Internal server error." });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.post("/talk/session", async (req, res) => {
  try {
    const { userName } = req.body ?? {};

    if (!isValidUserName(userName)) {
      res.status(400).json({ error: "`userName` must be a non-empty string." });
      return;
    }

    const session = await getConversationSession(userName);
    const conversation = serializeChatMessages(await session.memory.chatHistory.getMessages());

    res.status(200).json({
      userId: session.userId,
      userName: session.userName,
      conversation,
      existingChat: conversation.length > 0,
    });
  } catch (error) {
    writeLog("error", "talk_session_error", {
      message: error.message || "Internal server error.",
    });
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

app.post("/prompt", async (req, res) => {
  try {
    const {
      topic,
      audience = "general audience",
      style = "clear and concise",
      parser = "json",
      schemaFields = [],
      retries = 2,
      model,
      temperature,
    } = req.body ?? {};

    const normalizedSchemaFields = normalizeSchemaFields(schemaFields);

    logToFile("/prompt REQUEST", {
      topic: INCLUDE_PROMPT_IN_LOGS ? topic : "[redacted]",
      audience,
      style,
      parser,
      schemaFields: normalizedSchemaFields,
      retries,
      model,
      temperature,
    });

    if (!isValidPrompt(topic)) {
      res.status(400).json({ error: "`topic` must be a non-empty string." });
      return;
    }

    if (!isValidPrompt(audience)) {
      res.status(400).json({ error: "`audience` must be a non-empty string." });
      return;
    }

    if (!isValidPrompt(style)) {
      res.status(400).json({ error: "`style` must be a non-empty string." });
      return;
    }

    if (!isValidParserMode(parser)) {
      res
        .status(400)
        .json({ error: "`parser` must be one of 'json', 'regex', 'custom', or 'string'." });
      return;
    }

    if (schemaFields && !Array.isArray(schemaFields)) {
      res.status(400).json({ error: "`schemaFields` must be an array of field names when provided." });
      return;
    }

    const retryCount = Number(retries);
    if (!isValidRetryCount(retryCount)) {
      res.status(400).json({ error: "`retries` must be an integer between 0 and 5." });
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

    const llm = new ChatOpenAI({
      apiKey: API_KEY,
      model: model || "gpt-4o",
      ...(typeof temperature === "number" ? { temperature } : {}),
    });

    const parserMode = parser === "string" ? "custom" : parser;
    const schemaInstruction =
      normalizedSchemaFields.length > 0
        ? `Required fields: ${normalizedSchemaFields.join(", ")}.`
        : "No fixed schema was provided. Prefer concise useful structure.";

    const sourceTask = [
      `Topic: ${topic}`,
      `Audience: ${audience}`,
      `Style: ${style}`,
      schemaInstruction,
    ].join("\n");

    const startTime = Date.now();
    const extractionResult = await extractStructuredWithRetries({
      llm,
      sourceTask,
      strategy: parserMode,
      schemaFields: normalizedSchemaFields,
      maxRetries: retryCount,
      includeRawAttempts: false,
    });
    const latencyMs = Date.now() - startTime;

    if (!extractionResult.ok) {
      res.status(502).json({
        error: "Model output could not be parsed with selected parser strategy.",
        parser: parserMode,
        retries: retryCount,
        parseMessage: extractionResult.error,
        attempts: extractionResult.attempts,
      });
      return;
    }

    const { inputTokens, outputTokens, totalTokens } = extractionResult.usage;

    const responsePayload = {
      topic,
      audience,
      style,
      parser: parserMode,
      schemaFields: normalizedSchemaFields,
      retries: retryCount,
      parsedOutput: extractionResult.parsedOutput,
      attemptsUsed: extractionResult.attempts.length,
      usage: { inputTokens, outputTokens, totalTokens },
      estimatedCost: estimateCost(inputTokens, outputTokens),
      latencyMs,
      rawOutput: extractionResult.rawOutput,
    };

    logToFile("/prompt RESPONSE", responsePayload);
    res.status(200).json(responsePayload);
  } catch (error) {
    writeLog("error", "prompt_error", { message: error.message || "Internal server error." });
    logToFile("/prompt ERROR", { error: error.message || "Internal server error." });
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.post("/prompt/evaluate", async (req, res) => {
  try {
    const {
      tests = DEFAULT_EXTRACTION_TEST_INPUTS,
      schemaFields,
      model,
      temperature,
      retries = 2,
      includeRawAttempts = false,
    } = req.body ?? {};

    const normalizedSchemaFields =
      typeof schemaFields === "undefined"
        ? ["answer"]
        : normalizeSchemaFields(schemaFields);

    if (!Array.isArray(tests) || tests.length < 10) {
      res.status(400).json({ error: "`tests` must be an array with at least 10 prompt strings." });
      return;
    }

    if (!tests.every((item) => isValidPrompt(item))) {
      res.status(400).json({ error: "Every test item must be a non-empty string." });
      return;
    }

    if (typeof schemaFields !== "undefined" && !Array.isArray(schemaFields)) {
      res.status(400).json({ error: "`schemaFields` must be an array of field names when provided." });
      return;
    }

    const retryCount = Number(retries);
    if (!isValidRetryCount(retryCount)) {
      res.status(400).json({ error: "`retries` must be an integer between 0 and 5." });
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

    const llm = new ChatOpenAI({
      apiKey: API_KEY,
      model: model || "gpt-4o",
      ...(typeof temperature === "number" ? { temperature } : {}),
    });

    const strategies = ["json", "regex", "custom"];
    const startTime = Date.now();
    const rows = [];

    for (const input of tests) {
      for (const strategy of strategies) {
        const result = await extractStructuredWithRetries({
          llm,
          sourceTask: input,
          strategy,
          schemaFields: normalizedSchemaFields,
          maxRetries: retryCount,
          includeRawAttempts,
        });

        rows.push({
          input,
          strategy,
          success: result.ok,
          attemptCount: result.attempts?.length || 0,
          failureReason: result.ok ? null : result.error,
          parsedOutput: result.ok ? result.parsedOutput : null,
          attempts: result.attempts,
        });
      }
    }

    const byStrategy = {
      json: buildStrategySummary(rows.filter((row) => row.strategy === "json")),
      regex: buildStrategySummary(rows.filter((row) => row.strategy === "regex")),
      custom: buildStrategySummary(rows.filter((row) => row.strategy === "custom")),
    };

    const ranking = Object.entries(byStrategy)
      .map(([strategy, stats]) => ({ strategy, ...stats }))
      .sort((a, b) => {
        if (b.successRate !== a.successRate) {
          return b.successRate - a.successRate;
        }
        return a.averageAttempts - b.averageAttempts;
      });

    const responsePayload = {
      testsRun: tests.length,
      schemaFields: normalizedSchemaFields,
      retries: retryCount,
      strategies,
      byStrategy,
      ranking,
      durationMs: Date.now() - startTime,
      results: rows,
    };

    logToFile("/prompt/evaluate RESPONSE", {
      testsRun: responsePayload.testsRun,
      retries: responsePayload.retries,
      byStrategy: responsePayload.byStrategy,
      ranking: responsePayload.ranking,
      durationMs: responsePayload.durationMs,
    });

    res.status(200).json(responsePayload);
  } catch (error) {
    writeLog("error", "prompt_evaluate_error", {
      message: error.message || "Internal server error.",
    });
    logToFile("/prompt/evaluate ERROR", {
      error: error.message || "Internal server error.",
    });
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
