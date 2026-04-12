# OpenAI API Integration Project — Technical Summary

**Date Created:** April 8, 2026  
**Project Name:** yajur-ai  
**Version:** 1.0.0  
**Type:** Node.js API (Express + Serverless) deployed on AWS Lambda (ZIP)

**Update Added:** April 10, 2026 (LangChain integration + new /chain endpoint)

---

## 1. Project Overview

Built a lightweight, production-ready HTTP server that abstracts the OpenAI API with advanced request handling, logging, cost tracking, and latency monitoring. Designed to explore how prompts, temperature settings, and token usage impact API costs and response quality.

**Key Focus Areas:**
- API reliability and error handling
- Real-time cost estimation and token tracking
- Request validation and duplicate detection
- Performance measurement (latency)
- Comprehensive audit logging

---

## 2. Architecture & Core Endpoints

### 6 RESTful Endpoints

| Endpoint | Method | Input | Purpose |
|----------|--------|-------|---------|
| `/ask` | POST | `{prompt, temperature?, model?}` | Single prompt handling with optional parameters |
| `/batch` | POST | `{prompts[], temperature?, model?}` | Parallel processing of 1-5 unique prompts |
| `/chain` | POST | `{mode, question?, topic?, temperature?, model?}` | LangChain-powered single-step and 2-step chained workflows |
| `/cost-estimate` | POST | `{prompt, expectedOutputTokens}` | Pre-calculation of API costs (no API call) |
| `/models` | GET | N/A | List available OpenAI models |
| `/health` | GET | N/A | Server status check |

### Request-Response Flow

```
Client Request → Validation Layer → Logging (Entry)
                      ↓
              OpenAI API Call
                      ↓
Response Parsing → Cost Calculation → Latency Measurement
                      ↓
              Logging (Exit) → Client Response
```

---

## 3. Validation & Safety Features

### Input Validation
- **Prompt Validation:** Non-empty string required for all prompts
- **Request Size Limit:** 1MB maximum payload to prevent memory exhaustion
- **Timeout Protection:** 10-second abort timeout on OpenAI requests via `AbortController`
- **Semantic Duplicate Detection:** Batch endpoint automatically rejects duplicate prompts even with case/punctuation variations

### Error Handling Strategy
- Try-catch blocks around all API calls
- Timeout errors distinguished from network errors
- Detailed error messages returned to client
- All errors logged to `api_calls.log` for audit trail

---

## 4. Key Technical Implementations

### 4.0 LangChain Integration (April 10)

Added a new orchestration module `langchainChain.js` and connected it via `/chain` endpoint.

- `runHelloWorldChain({ question, model, temperature })`
  - PromptTemplate + ChatOpenAI chain (`prompt.pipe(llm)`)
  - Returns text, tokens, estimated cost, latency

- `runResearchChain({ topic, model, temperature })`
  - Step 1: generate 3-point outline
  - Step 2: expand outline into exactly 3 paragraphs
  - Sequential data flow: topic -> outline -> research
  - Aggregates token usage across both model calls

Design choice: chain logic is isolated from transport logic (Express route handlers) to keep API surface stable and allow future chain evolution without endpoint rewrites.

### 4.1 Latency Tracking
```javascript
const startTime = Date.now();
const response = await client.responses.create(...);
const latencyMs = Date.now() - startTime;
```
- **Purpose:** Understand API response times under different load conditions
- **Implementation:** High-resolution timing around OpenAI SDK calls
- **Data Captured:** Round-trip time in milliseconds included in every response

### 4.2 Cost Calculation Engine
**Pricing Model (GPT-4o):**
- Input tokens: $0.00003 per 1K tokens
- Output tokens: $0.00006 per 1K tokens

```javascript
const estimatedCost = (inputTokens * INPUT_RATE_PER_1K + outputTokens * OUTPUT_RATE_PER_1K) / 1000;
```

**Key Insight:** Output token cost dominates (higher rate + typically larger volume)

### 4.3 Comprehensive Logging System
- **Log File:** `api_calls.log` (append-only)
- **Timestamp:** ISO 8601 format on every entry
- **Source Tracking:** File name logged to identify which script made the call
- **Default Behavior (updated April 10):**
  - Local runtime: file logging enabled by default
  - Lambda runtime: file logging disabled by default
  - Explicit override via `ENABLE_FILE_LOGS`
- **Logged Data:**
  - Full request payloads
  - Complete response objects
  - Usage statistics (input/output/total tokens)
  - Latency measurements
  - `/chain REQUEST`, `/chain RESPONSE`, `/chain ERROR`

---

## 5. API Design Decisions

### Parameter Flexibility
- `temperature` optional (0–2.0 scale; undefined defaults to OpenAI's default)
- `model` optional (defaults to "gpt-4o")
- Supports both single prompt (`/ask`) and batch (`/batch`) workflows

### Batch Processing
- Parallel execution of multiple prompts using `Promise.all()`
- Automatic semantic duplicate rejection (case-insensitive, punctuation-insensitive)
- Output is array of individual responses with latency per call

### Cost-Estimate Endpoint
- **No API Call:** Estimation happens locally using token formula
- **Use Case:** Pre-calculate cost before committing to expensive API calls
- **Inputs:** Prompt text + expected output token count (user estimates)

---

## 6. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | ES Module (type: "module") |
| OpenAI SDK | openai | ^4.0.0 |
| LangChain Core | @langchain/core | ^0.3.x |
| LangChain OpenAI | @langchain/openai | ^0.5.x |
| LangChain Package | langchain | ^0.3.x |
| Environment | dotenv | ^17.4.0 |
| Server | express + serverless-http | ^4.x + ^3.x |
| Logging | `fs` module | Built-in |

**Why ES Modules?** Native support for `import` syntax, better tree-shaking, aligns with modern JavaScript standards.

---

## 7. Experimental Scripts

### prompt.js
**Purpose:** Test varying prompt complexity and length
- **Test Prompts:**
  - "What is machine learning?" (simple)
  - "Explain machine learning like I'm 5" (creative)
  - "Machine learning definition for engineer" (technical)
  - "ML in bullet points" (structured)
  - "Compare ML to traditional programming" (comparative)
- **Findings:** Prompt length weakly correlates with output tokens; model's interpretation is key

### temperature.js
**Purpose:** Measure temperature parameter impact on responses
- **Temperature Range:** 0, 0.5, 1.0, 1.5, 2.0
- **Fixed Prompt:** "Give a creative product name for a coffee shop"
- **Measurements:**
  - Output variance with temperature
  - Token count consistency across temperatures
  - Cost stability (temperatures don't affect token pricing)

---

## 8. Data Analysis & Findings

### API Call Dataset (14 calls captured)
- **Average Input Tokens:** 14.07 per call
- **Average Output Tokens:** 186.86 per call
- **Total Tokens:** 200.93 per call
- **Average Cost:** $0.00001163 per call

### Key Discovery
**Output tokens dominate cost.** Even though input token pricing is lower, output token volume (and higher per-token rate) drives ~85% of costs.

**Implication:** Optimizing prompt engineering (longer prompts don't necessarily hurt) is less critical than managing expected output length.

---

## 9. What Was Tested & Validated

✅ **HTTP Server Initialization** — Server starts on port 3004  
✅ **Request Parsing** — JSON payloads correctly deserialized  
✅ **OpenAI API Connectivity** — SDK successfully authenticates with API key  
✅ **Response Parsing** — Token usage and output text correctly extracted  
✅ **Latency Measurement** — Timing spans full request lifecycle  
✅ **Cost Calculation** — Matches OpenAI's rates  
✅ **Logging** — Append-only file maintains audit trail  
✅ **Error Handling** — Timeout and invalid JSON handled gracefully  
✅ **Batch Processing** — Multiple prompts execute in parallel  
✅ **Duplicate Detection** — Case-insensitive matching works  
✅ **LangChain Endpoint** — `/chain` hello and research modes execute successfully  
✅ **Chain Logging Parity** — `/chain` now logs request/response/error like other endpoints  

---

## 10. Production-Ready Features

| Feature | Status | Notes |
|---------|--------|-------|
| Error Handling | ✅ | Try-catch, timeouts, descriptive messages |
| Request Validation | ✅ | Size limits, required fields, type checking |
| Logging & Audit Trail | ✅ | Every call logged with timestamps |
| Security | ✅ | API key in .env (not hardcoded) |
| Performance | ✅ | Latency measurements included |
| Cost Tracking | ✅ | Real-time cost per token |
| Scalability | ⏳ | TODO: Connection pooling, rate limiting |
| Monitoring | ⏳ | TODO: Prometheus metrics, alerts |

---

## 11. Code Quality & Best Practices

- **Modular Functions:** `askOne()`, `sendJson()`, `estimateCost()` — single responsibility
- **Async/Await:** Clean async flow with proper error propagation
- **Resource Management:** `AbortController` for timeout safety
- **Immutable Data:** Functional approach to building request payloads
- **Environment Isolation:** Secrets in `.env`, validated at startup
- **Logging Strategy:** Structured JSON logging for machine parsing

---

## 12. How to Deploy & Run

### Installation
```bash
npm install
```

### Configuration
Create `.env` file:
```env
key=your_openai_api_key
PORT=3004  # optional
```

### Start Server
```bash
node apiClient.js
```

Server listens on `http://localhost:3004`

### Test Endpoints
```bash
# Single prompt
curl -X POST http://localhost:3004/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello","temperature":0.7}'

# Batch
curl -X POST http://localhost:3004/batch \
  -H "Content-Type: application/json" \
  -d '{"prompts":["P1","P2"],"temperature":0.5}'

# Health
curl http://localhost:3004/health
```

---

## 13. AWS Lambda ZIP Deployment Status (Success)

### Deployment Outcome
- Lambda deployment completed successfully via ZIP upload.
- API tested from Postman and returned `200 OK`.
- Response body included `prompt`, `outputText`, token usage, estimated cost, and latency.

### Lambda Configuration Used
- Runtime: `Node.js 20.x`
- Handler: `apiClient.handler`
- Environment variable: `OPENAI_API_KEY`

### Packaging Command Used
```bash
npm ci --omit=dev
zip -r lambda.zip apiClient.js package.json node_modules
```

### Issue Encountered and Fix
- Error observed: `Runtime.ImportModuleError: Cannot find module 'apiclient'`
- Root cause: handler case mismatch on Linux runtime.
- Fix applied: set handler to `apiClient.handler` (exact file-case match).

---

## 14. Interview Talking Points

**Problem Solved:**
"I built an abstraction layer over OpenAI's API to understand cost drivers and monitor performance. The server handles validation, error handling, and provides real-time cost estimation."

**Key Achievements:**
1. Designed 6 RESTful endpoints with clear separation of concerns
2. Implemented latency tracking and cost calculation for every API call
3. Built semantic duplicate detection for batch processing
4. Comprehensive audit logging for cost/performance analysis

**What I Learned:**
1. Output tokens dominate costs more than input tokens (higher rate + larger volume)
2. Temperature variations don't affect token counts, only response generation variance
3. Proper error handling (timeouts, size limits) is non-negotiable for production APIs

**Technologies Demonstrated:**
- Node.js ES Modules and http server architecture
- OpenAI SDK integration and error handling
- Asynchronous programming (async/await, Promise.all)
- Request validation and security patterns
- Logging and monitoring design

---

## 15. Future Enhancements

1. **Rate Limiting** — Token bucket algorithm to prevent API throttling
2. **Caching** — In-memory cache for identical prompts to reduce costs
3. **Monitoring Dashboard** — Real-time visualization of costs and latency
4. **A/B Testing** — Compare different temperature/model combinations
5. **Database Integration** — Persist call history for trend analysis
6. **Authentication** — API key for server access control

---

**Last Updated:** April 10, 2026
