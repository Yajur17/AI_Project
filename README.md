# OpenAI API Server

A lightweight Node.js HTTP server for interacting with the OpenAI API. Includes request logging, latency tracking, cost estimation, and comprehensive validation.

## What's Implemented

### 5 Core Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ask` | POST | Ask a single question to OpenAI |
| `/batch` | POST | Process 1-5 unique prompts in parallel |
| `/cost-estimate` | POST | Estimate API cost before calling OpenAI |
| `/models` | GET | List available OpenAI models |
| `/health` | GET | Check server status |

## Key Features

✅ **Latency Tracking** — All OpenAI calls measure round-trip time in milliseconds  
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
key=your_openai_api_key
```

## Run

```bash
node apiClient.js
# Server listens on http://localhost:3004 (or set PORT env var)
```

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

## Logging

All API activity logged to `api_calls.log`:
- Request payloads with timestamps
- Response data with latency measurements
- Error messages and stack context
- OpenAI API calls (separate OPENAI REQUEST/RESPONSE entries)

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
- OpenAI SDK v4+
- Built-in HTTP server (no external frameworks)
- dotenv for environment variables