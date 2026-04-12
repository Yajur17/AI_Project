# OpenAI + LangChain API Server

A lightweight Node.js API server for interacting with OpenAI and LangChain chains. Includes request logging, latency tracking, cost estimation, validation, and serverless deployment support.

## What's Implemented

### 6 Core Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ask` | POST | Ask a single question to OpenAI |
| `/batch` | POST | Process 1-5 unique prompts in parallel |
| `/chain` | POST | Run LangChain modes (`hello` single-step or `research` 2-step) |
| `/cost-estimate` | POST | Estimate API cost before calling OpenAI |
| `/models` | GET | List available OpenAI models |
| `/health` | GET | Check server status |

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
- Environment variable in Lambda: `OPENAI_API_KEY`

### ZIP Deployment Steps (Used)

```bash
# from AI_Project/
npm ci --omit=dev
zip -r lambda.zip apiClient.js package.json node_modules
```

Upload `lambda.zip` to Lambda and configure API Gateway HTTP API routes to your function.

### Important Fix Applied

If you see `Runtime.ImportModuleError: Cannot find module 'apiclient'`, set handler exactly to `apiClient.handler` (case-sensitive on Lambda Linux runtime).

### Verified Lambda Response

Lambda successfully returned:
- `statusCode: 200`
- JSON body containing `prompt`, `outputText`, `usage`, `estimatedCost`, and `latencyMs`

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

## Logging

All API activity logged to `api_calls.log`:
- Request payloads with timestamps
- Response data with latency measurements
- Error messages and stack context
- OpenAI API calls (separate OPENAI REQUEST/RESPONSE entries)
- Chain endpoint activity (`/chain REQUEST`, `/chain RESPONSE`, `/chain ERROR`)

### Logging Defaults

- Local runtime: file logging is enabled by default
- AWS Lambda runtime: file logging is disabled by default
- Override with `ENABLE_FILE_LOGS=true` or `ENABLE_FILE_LOGS=false`

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