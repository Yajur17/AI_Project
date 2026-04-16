# OpenAI + LangChain API Server

A lightweight Node.js API server for interacting with OpenAI and LangChain chains. Includes request logging, latency tracking, cost estimation, validation, and serverless deployment support.

## What's Implemented

### 8 Core Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ask` | POST | Ask a single question to OpenAI |
| `/batch` | POST | Process 1-5 unique prompts in parallel |
| `/chain` | POST | Run LangChain modes (`hello` single-step or `research` 2-step) |
| `/cost-estimate` | POST | Estimate API cost before calling OpenAI |
| `/models` | GET | List available OpenAI models |
| `/health` | GET | Check server status |
| `/prompt` | POST | Structured output extraction with 3 parsing strategies (json, regex, custom) and retry logic |
| `/prompt/evaluate` | POST | Reliability benchmark — runs all 3 strategies across test inputs and ranks by success rate |

## Key Features

✅ **Latency Tracking** — All OpenAI calls measure round-trip time in milliseconds  
✅ **LangChain Integration** — Dedicated chain module with single-step and 2-step sequential workflows  
✅ **Comprehensive Logging** — Every request/response logged to `api_calls.log`  
✅ **Input Validation** — Prompts must be non-empty strings  
✅ **Semantic Duplicate Detection** — Batch rejects duplicates even with different case/punctuation  
✅ **Cost Calculation** — Real-time token usage and estimated cost  
✅ **Request Size Limits** — Max 1MB payload to prevent memory issues  
✅ **Error Handling** — Try-catch with detailed error messages  
✅ **Timeout Protection** — 10-second abort timeout on OpenAI requests  
✅ **DynamoDB Audit Persistence** — Per-request audit record stored with `created`, `requestId`, and full call data  
✅ **Research JSON Output** — `/chain` research mode returns `outline[]` and `research[]` arrays  
✅ **Structured Output Extraction** — `/prompt` endpoint extracts structured data from any question using 3 parser strategies with automatic retry on malformed output  
✅ **Dynamic Schema Support** — pass optional `schemaFields` to enforce specific output keys; falls back to generic key-value if omitted  
✅ **Reliability Benchmarking** — `/prompt/evaluate` runs all 3 strategies on a test set (≥10 inputs) and returns `successRate`, `averageAttempts`, and ranked comparison  

## Setup

```bash
npm install
```

Add your OpenAI API key to `.env`:
```env
OPENAI_API_KEY=your_openai_api_key
# backward compatible:
# key=your_openai_api_key

# optional logging controls:
# ENABLE_FILE_LOGS=true
# INCLUDE_PROMPT_IN_LOGS=false
# LOG_LEVEL=info
# LOG_SUCCESS_SAMPLE_RATE=0.25

# optional DynamoDB audit controls:
# DDB_TABLE_NAME=aiproject
# ENABLE_DDB_AUDIT=true
```

## Run

```bash
node apiClient.js
# Server listens on http://localhost:3004 (or set PORT env var)
```

## AWS Lambda Deployment (ZIP) - Success

The API is successfully deployed to AWS Lambda using a ZIP package and tested via Postman.

### Runtime/Handler Used

- Runtime: `Node.js 20.x`
- Handler: `apiClient.handler`
- Environment variables in Lambda: `OPENAI_API_KEY`, `DDB_TABLE_NAME` (and optional `ENABLE_DDB_AUDIT`)

### ZIP Deployment Steps (Used)

```bash
# from AI_Project/
npm ci --omit=dev
zip -r lambda.zip apiClient.js langchainChain.js package.json node_modules
```

Upload `lambda.zip` to Lambda and configure API Gateway HTTP API routes to your function.

### Important Fix Applied

If you see `Runtime.ImportModuleError: Cannot find module 'apiclient'`, set handler exactly to `apiClient.handler` (case-sensitive on Lambda Linux runtime).

### Verified Lambda Response

Lambda successfully returned:
- `statusCode: 200`
- A Lambda proxy envelope (`statusCode`, `headers`, `body`) when invoked directly
- JSON payload inside `body` containing endpoint response fields

For `/chain` with `mode: "research"`, payload now includes:
- `outline` as `string[]`
- `research` as `string[]`
- `usage`, `estimatedCost`, `latencyMs`

## API Examples

### 1. Ask (Single Prompt)
```bash
curl -X POST http://localhost:3004/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is machine learning?","temperature":0.7,"model":"gpt-4o"}'
```

**Response:**
```json
{
  "prompt": "What is machine learning?",
  "outputText": "...",
  "usage": {
    "inputTokens": 9,
    "outputTokens": 125,
    "totalTokens": 134
  },
  "estimatedCost": 0.0018,
  "latencyMs": 2450
}
```

### 2. Batch (Multiple Prompts)
```bash
curl -X POST http://localhost:3004/batch \
  -H "Content-Type: application/json" \
  -d '{
    "prompts": ["Prompt 1", "Prompt 2", "Prompt 3", "Prompt 4", "Prompt 5"],
    "temperature": 0.5,
    "model": "gpt-4o"
  }'
```

**Note:** All prompts must be unique (no semantic duplicates).

### 3. Cost Estimate (No API Call)
```bash
curl -X POST http://localhost:3004/cost-estimate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain AI","expectedOutputTokens":200}'
```

### 4. List Models
```bash
curl http://localhost:3004/models
```

### 5. Health Check
```bash
curl http://localhost:3004/health
```

### 6. LangChain Hello Mode
```bash
curl -X POST http://localhost:3004/chain \
  -H "Content-Type: application/json" \
  -d '{"mode":"hello","question":"What is RAG?","temperature":0.7,"model":"gpt-4o"}'
```

### 7. LangChain Research Mode (2-step)
```bash
curl -X POST http://localhost:3004/chain \
  -H "Content-Type: application/json" \
  -d '{"mode":"research","topic":"Quantum computing","temperature":0.5,"model":"gpt-4o"}'
```

**Research Response Shape:**
```json
{
  "topic": "Quantum computing",
  "outline": [
    "What it is",
    "How it differs from classical computing",
    "Current real-world applications"
  ],
  "research": [
    "Paragraph 1...",
    "Paragraph 2...",
    "Paragraph 3..."
  ],
  "usage": {
    "inputTokens": 310,
    "outputTokens": 420,
    "totalTokens": 730
  },
  "estimatedCost": 0.0000345,
  "latencyMs": 4800
}
```

## Logging

All API activity logged to `api_calls.log`:
- Request payloads with timestamps
- Response data with latency measurements
- Error messages and stack context
- OpenAI API calls (separate OPENAI REQUEST/RESPONSE entries)
- Chain endpoint activity (`/chain REQUEST`, `/chain RESPONSE`, `/chain ERROR`)

### DynamoDB Audit Logging

When `ENABLE_DDB_AUDIT=true`, each request is persisted to DynamoDB table `DDB_TABLE_NAME` with:
- `created` (ISO timestamp)
- `requestId` (incoming `x-request-id` or generated UUID)
- `data` object:
  - endpoint, method, statusCode, latencyMs
  - request (headers/query/params/body)
  - response (headers/body)

Sensitive headers are redacted: `authorization`, `x-api-key`, `cookie`, `set-cookie`.

### Logging Defaults

- Local runtime: file logging is enabled by default
- AWS Lambda runtime: file logging is disabled by default
- Override with `ENABLE_FILE_LOGS=true` or `ENABLE_FILE_LOGS=false`
- DynamoDB audit logging is enabled by default on Lambda (or set `ENABLE_DDB_AUDIT` explicitly)

## Error Handling

- **400** — Invalid input (bad prompt, duplicates, wrong types)
- **500** — Server error (API failure, timeout)
- **404** — Endpoint not found

## Pricing

- Input: `$0.00003` per 1K tokens
- Output: `$0.00006` per 1K tokens

Update constants in `apiClient.js` to match current rates.

## Tech Stack

- Node.js (ES modules)
- LangChain (`@langchain/core`, `@langchain/openai`, `langchain`)
- OpenAI SDK v4+
- Express + serverless-http
- dotenv for environment variables

## Structured Output Extraction

The `/prompt` endpoint supports 3 parsing strategies for any topic:

- `json`: asks the model for strict JSON
- `regex`: asks for plain key-value lines (`Field: Value`)
- `custom`: handles natural text + key-value + JSON fallback

### Optional Schema

You can pass `schemaFields` to force required keys.

```json
{
  "schemaFields": ["answer", "key_points"]
}
```

If `schemaFields` is omitted, parsing is generic and usually returns at least an `answer` field.

### Retry Logic for Malformed Output

`/prompt` accepts `retries` (0 to 5). If parsing fails, the server re-prompts the model with the parse error and retries automatically.

### Structured Extraction Example (General Q&A)

```bash
curl -X POST http://localhost:3004/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "When should I consume creatine?",
    "audience": "gym beginner",
    "style": "concise",
    "parser": "custom",
    "retries": 2,
    "temperature": 0.7,
    "model": "gpt-4o"
  }'
```

### Structured Extraction With Required Fields

```bash
curl -X POST http://localhost:3004/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "When should I consume creatine?",
    "audience": "gym beginner",
    "style": "concise",
    "parser": "json",
    "schemaFields": ["answer", "key_points"],
    "retries": 2
  }'
```

### Reliability Benchmark Across 3 Strategies

Use `/prompt/evaluate` to run at least 10 test inputs across `json`, `regex`, and `custom` and get success rate metrics.

```bash
curl -X POST http://localhost:3004/prompt/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "schemaFields": ["answer"],
    "retries": 2,
    "temperature": 0.2,
    "model": "gpt-4o"
  }'
```

Custom test set example (must be at least 10):

```bash
curl -X POST http://localhost:3004/prompt/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "tests": [
      "When should I consume creatine?",
      "What should I eat before a workout?",
      "How much water should I drink daily?",
      "How to improve squat depth?",
      "Difference between whey isolate and concentrate?",
      "What are signs of overtraining?",
      "How much protein do beginners need?",
      "Can I train abs every day?",
      "Best warm-up for leg day?",
      "Should cardio be before or after weights?"
    ],
    "schemaFields": ["answer"],
    "retries": 2
  }'
```
