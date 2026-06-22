# SAP AI Chat Assistant — Technical Specification

**Version:** 1.0.0
**Date:** 22 June 2026
**Author:** Deepak Parashar
**Status:** Deployed on SAP BTP Cloud Foundry (Scania PoC Sandbox)
**Repository:** https://github.com/deparashar/ai-chatbot-poc

---

## 1. Overview

A conversational AI assistant that lets users query SAP S/4HANA business data using natural language. The system translates user questions into OData API calls via the Model Context Protocol (MCP), using OpenAI GPT for intent understanding and response formatting.

**Why this exists:** ChatGPT Enterprise blocks MCP connections via IT policy. This web app replicates what ChatGPT would do natively with MCP connectors — acting as its own orchestrator.

**Example interaction:**
```
User:  "Show me 5 billing documents"
System: discovers service → reads entity metadata → fetches records → formats as Markdown table
```

### 1.1 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM provider | OpenAI API | Enterprise-grade, reliable tool calling |
| LLM model | GPT-5.4 Mini | Best cost/performance ratio, reasoning model |
| MCP transport | Streamable HTTP | Required by the deployed MCP server |
| MCP server | [lemaiwo/btp-sap-odata-to-mcp-server](https://github.com/lemaiwo/btp-sap-odata-to-mcp-server) | Open-source, BTP-native, 3-level progressive discovery |
| UI framework | Vanilla JS (ES modules) | No build step, instant load, zero CDN dependency |
| Auth | XSUAA via App Router | BTP-native, handles OAuth2 login + CSRF |
| Deployment | MTA on Cloud Foundry | Single `cf deploy` for all modules |
| MCP Server auth | client_credentials (separate) | User JWT has wrong audience for MCP server's XSUAA |
| Secrets | `cf set-env` (Credential Store support coded but not bound) | Simple for PoC; credstoreClient.js ready for production |

---

## 2. Architecture

### 2.1 System Diagram

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                SAP BTP Cloud Foundry (eu10-004)                          ║
║                Org: Scania_ieb_-_poc-sbx  / Space: SBX                   ║
║                                                                          ║
║  ┌────────────────┐    ┌───────────────────────┐                         ║
║  │  App Router    │    │    MCP Client          │                         ║
║  │                │    │                        │                         ║
║  │ @sap/approuter │───▶│  Node.js / Express     │                         ║
║  │                │    │  ┌──────────────────┐  │                         ║
║  │ • XSUAA login  │    │  │  server.js        │  │                         ║
║  │ • JWT forward  │    │  │  chatHandler.js   │  │                         ║
║  │ • CSRF guard   │    │  │  llmClient.js     │  │                         ║
║  │ • CSP headers  │    │  │  mcpClient.js     │  │                         ║
║  │ • Admin scope  │    │  │  credstoreClient  │  │                         ║
║  └───────┬────────┘    │  │  logBuffer.js     │  │                         ║
║          │             │  └────────┬─────────┘  │                         ║
║          │             │           │             │                         ║
║          │             │  ┌────────▼─────────┐  │                         ║
║          │             │  │  Web UI (SPA)     │  │                         ║
║          │             │  │  Vanilla JS       │  │                         ║
║          │             │  │  ES Modules       │  │                         ║
║          │             │  └──────────────────┘  │                         ║
║          │             └──────────┬──────────────┘                        ║
║          │                        │                                       ║
║          ▼                        │ Streamable HTTP                       ║
║    ┌──────────────┐               ▼                                       ║
║    │    XSUAA     │    ┌───────────────────────┐                          ║
║    │  (OAuth2)    │    │   MCP Server          │                          ║
║    │              │    │  (sap-mcp-server-SBX) │                          ║
║    │ JWT issuance │    │  • discover-sap-data  │                          ║
║    │ token valid. │    │  • get-entity-metadata│                          ║
║    └──────────────┘    │  • execute-sap-op     │                          ║
║                        └──────────┬────────────┘                          ║
║                                   │ BTP Destination                       ║
║                                   ▼                                       ║
║                        ┌───────────────────────┐                          ║
║                        │   SAP S/4HANA / ECC    │                          ║
║                        │   OData V2 Services    │                          ║
║                        └───────────────────────┘                          ║
╚═══════════════════════════════════════════════════════════════════════════╝
           ▲                        ▲
           │ HTTPS / OAuth2         │ HTTPS / API Key
           │                        │
    ┌──────┴───────┐       ┌────────┴─────────┐
    │   Browser    │       │   OpenAI API      │
    │ (End User)   │       │   GPT-5.4 Mini    │
    └──────────────┘       └──────────────────┘
```

### 2.2 Component Summary

| Component | Location | Runtime | Purpose |
|-----------|----------|---------|---------|
| App Router | `fiori-chat-router/` | @sap/approuter | XSUAA login, JWT forwarding, CSRF enforcement, CSP headers |
| MCP Client | `fiori-chat-mcp-client/src/` | Node.js / Express 4 | LLM orchestration, tool-call loop, session management, static file serving |
| Web UI | `fiori-chat-mcp-client/webapp/` | Browser (ES modules) | Chat interface, markdown rendering, theme toggle, admin log viewer |
| MCP Server | `sap-mcp-server/` (open-source) | Node.js / TypeScript | OData discovery, metadata, CRUD via MCP protocol |
| XSUAA | BTP managed service | — | OAuth2 authorization, JWT issuance |
| OpenAI API | External (api.openai.com) | — | LLM inference (GPT-5.4 Mini) |
| SAP System | Client's S/4HANA / ECC | — | OData V2 services (business data) |

---

## 3. Control Flow

### 3.1 Request Lifecycle (Happy Path — Data Fetch Query)

```
Browser         App Router       MCP Client          OpenAI LLM      MCP Server       SAP OData
   │                │                │                   │                │                │
   │  POST /chat    │                │                   │                │                │
   │  {message,     │                │                   │                │                │
   │   sessionId}   │                │                   │                │                │
   ├───────────────▶│                │                   │                │                │
   │                │ Validate JWT   │                   │                │                │
   │                │ Check CSRF     │                   │                │                │
   │                ├───────────────▶│                   │                │                │
   │                │                │                   │                │                │
   │                │                │◀── Parallel init ─┤                │                │
   │                │                │    getTools()      │                │                │
   │                │                │    getOrCreateSession()            │                │
   │                │                │                   │                │                │
   │                │                │  Build context:   │                │                │
   │                │                │  system prompt    │                │                │
   │                │                │  + last 64 msgs   │                │                │
   │                │                │                   │                │                │
   │                │                │── Round 1 ───────▶│                │                │
   │                │                │  messages + tools │                │                │
   │                │                │◀── tool_call ─────│                │                │
   │                │                │  discover-sap-data│                │                │
   │                │                │                   │                │                │
   │                │                │── callTool() ─────────────────────▶│                │
   │                │                │                   │                │── catalog ────▶│
   │                │                │                   │                │◀── services ───│
   │                │                │◀── services ──────────────────────│                │
   │                │                │                   │                │                │
   │                │                │── Round 2 ───────▶│                │                │
   │                │                │  services list    │                │                │
   │                │                │◀── tool_call ─────│                │                │
   │                │                │  execute-sap-op   │                │                │
   │                │                │                   │                │                │
   │                │                │── callTool() ─────────────────────▶│                │
   │                │                │                   │                │── GET records ▶│
   │                │                │                   │                │◀── JSON ───────│
   │                │                │◀── data ──────────────────────────│                │
   │                │                │                   │                │                │
   │                │                │── Round 3 ───────▶│                │                │
   │                │                │  data results     │                │                │
   │                │                │◀── text answer ───│                │                │
   │                │                │  (Markdown table) │                │                │
   │                │◀───────────────│                   │                │                │
   │◀───────────────│  {reply,       │                   │                │                │
   │  render answer │   tokenUsage}  │                   │                │                │
```

### 3.2 LLM Roundtrips by Query Type

| User Intent | Example | LLM Rounds | Tools Called |
|-------------|---------|------------|--------------|
| Explore schema | "What entities does Billing have?" | 2 | `discover-sap-data` → `get-entity-metadata` |
| Fetch records | "Show me 5 billing documents" | 2–3 | `discover` → `get-entity-metadata` → `execute-sap-operation` |
| Follow-up | "Now filter by amount > 1000" | 1–2 | `execute-sap-operation` (reuses known serviceId) |
| Unknown service | "Find inbound delivery services" | 2–3 | `discover-sap-data` → `get-entity-metadata` |

### 3.3 Tool-Call Loop (chatHandler.js)

```
handleChat(message, sessionId)
 │
 ├─ Check turn limit (max 20 per session)
 │
 ├─ Parallel prefetch:
 │    ├── getTools()              → cached MCP tool definitions (fetched once, reused)
 │    └── getOrCreateSession()    → live MCP transport connection (reused across turns)
 │
 ├─ Build messages: system prompt + sliding window (last 64 messages)
 │
 └─ for round = 0..5:
       │
       ├── LLM chat completion (messages + tools)
       │
       ├── No tool_calls?  ──▶  return text response ✓
       │
       ├── Deduplicate tool calls (same name + args → skip)
       │
       ├── Execute tools in parallel (Promise.all):
       │    └── For each tool call:
       │         ├── parseToolArgs()      coerce strings to correct types (int)
       │         ├── resolveServiceId()   fuzzy-match against known catalog
       │         ├── callTool()           execute via MCP transport
       │         └── smartTruncate()      clean OData, convert dates, drop fields (16KB max)
       │
       └── Append tool results → next round
```

---

## 4. MCP Protocol Integration

### 4.1 Transport

```
Protocol:   Streamable HTTP  (NOT Server-Sent Events)
SDK:        @modelcontextprotocol/sdk — StreamableHTTPClientTransport
Endpoint:   {MCP_SERVER_URL}/mcp
Auth:       OAuth2 client_credentials token from XSUAA
            (User JWT cannot be used — audience mismatch)
```

### 4.2 Session Lifecycle

```
1. getMcpToken()        → client_credentials grant via XSUAA
                          cached in memory, refreshed at 80% of TTL
2. createClient()       → new StreamableHTTPClientTransport → client.connect()
3. client.listTools()   → returns 3 tools (cached globally, fetched once)
4. client.callTool()    → executes tool, result returned as text
5. On error             → releaseSession() + reconnect once + retry
6. On reset / expiry    → releaseSession() → client.close()
```

### 4.3 Tool Definitions (from MCP Server)

The MCP server uses a **3-level progressive discovery** pattern. Instead of exposing 200+ tools (one per SAP entity), it provides 3 generic tools that the LLM navigates:

| Tool | Purpose | Key Parameters | Returns |
|------|---------|----------------|---------|
| `discover-sap-data` | Find OData services matching a query | `query?`, `category?`, `limit` | Service list with serviceIds and entity names |
| `get-entity-metadata` | Get entity sets and field schemas | `serviceId`, `entityName` | Field names, types, keys, capabilities |
| `execute-sap-operation` | Read/write against an entity set | `serviceId`, `entityName`, `operation`, `topNumber?`, `filterString?`, `selectString?`, `orderbyString?`, `expandString?` | JSON records |

**Benefits of 3-level approach:**
- Token efficient: LLM sees 3 tool definitions, not 200+
- Progressive detail: metadata fetched only when needed
- Clear workflow: discover → inspect → execute

### 4.4 MCP Server Source

The MCP server is the open-source [lemaiwo/btp-sap-odata-to-mcp-server](https://github.com/lemaiwo/btp-sap-odata-to-mcp-server). It is deployed as-is with environment variable configuration. **We did not build the MCP server — it is consumed as infrastructure.**

Key MCP server config (set via `cf set-env` after deploy):
- `ODATA_MAX_SERVICES` — limit discovered services
- `ODATA_SERVICE_PATTERNS` — glob pattern (e.g. `Z*`, `API_*`)
- `SAP_DISCOVERY_DESTINATION_NAME` / `SAP_EXECUTION_DESTINATION_NAME` — BTP Destination names

---

## 5. LLM Integration

### 5.1 Configuration

| Parameter | Value | Source |
|-----------|-------|--------|
| Provider | OpenAI | `LLM_BASE_URL` env var |
| Model | `gpt-5.4-mini` | `LLM_MODEL` env var (set via `cf set-env`) |
| SDK | `openai` npm package | — |
| Temperature | 0.1 | Hardcoded in llmClient.js |
| Max tokens | 4096 | `max_completion_tokens` in llmClient.js |
| Tool choice | `auto` | LLM decides when to call tools |

> **Note:** GPT-5.4 Mini is a reasoning model that requires `max_completion_tokens` instead of the deprecated `max_tokens` parameter. The `temperature` parameter is accepted.

### 5.2 System Prompt Structure

```
┌──────────────────────────────────────────────────┐
│  SYSTEM PROMPT                                    │
│  ├── Role: SAP business data assistant            │
│  ├── How to work:                                 │
│  │    ├── Use discover-sap-data ONCE at start     │
│  │    ├── Use get-entity-metadata before querying  │
│  │    ├── Use execute-sap-operation to read data   │
│  │    ├── Remember serviceIds across turns          │
│  │    └── Call ONE tool at a time                   │
│  ├── SAP OData rules:                              │
│  │    ├── Never use "read-single" — use "read"     │
│  │    ├── Always include topNumber for lists        │
│  │    ├── Use selectString for efficiency           │
│  │    ├── Date filters: datetime'YYYY-MM-DDT...'   │
│  │    └── SAP keys are zero-padded (10 digits)      │
│  └── Response style:                                │
│       ├── Markdown tables with exact values          │
│       ├── Never invent or round data                 │
│       └── Show "-" for missing fields                │
└──────────────────────────────────────────────────┘
```

### 5.3 Performance Optimizations

| Optimization | Mechanism | Impact |
|-------------|-----------|--------|
| Sliding context window | Only last 64 messages sent to LLM | O(1) token usage regardless of turn count |
| Parallel tool execution | `Promise.all` for concurrent tool calls | Reduces wall-clock time for multi-tool rounds |
| Tool deduplication | Same tool + same args in one round → skipped | Prevents duplicate calls |
| Smart truncation | Drop low-value fields first, never drop records | Keeps results under 16KB |
| SAP value conversion | `/Date(...)/ → YYYY-MM-DD`, `PT08H37M24S → 08:37:24` | Smaller payloads, readable by LLM |
| Type coercion | `parseToolArgs()` coerces string → number for topNumber/skipNumber | Fixes LLM sending numerics as strings |
| ServiceId fuzzy match | `resolveServiceId()` prefix/contains match against catalog | LLM drops `_0001` suffix — auto-resolved |
| Token caching | OAuth token refreshed at 80% of TTL | Eliminates per-request token fetches |
| Tool caching | `getTools()` called once, cached globally | Tools never change — no need to re-fetch |

### 5.4 LLM Error Handling

```
LLM API error
  │
  ├── HTTP 429  → "Rate limit exceeded — please wait a moment and try again"
  ├── HTTP 401  → "LLM authentication failed. Please check the API key configuration."
  ├── HTTP 403  → "LLM authentication failed. Please check the API key configuration."
  ├── HTTP 404  → "LLM model not found. The configured model may not be available."
  ├── HTTP 413  → "Message too long — conversation exceeded context limit. Please clear the chat."
  ├── HTTP 5xx  → "The LLM service is temporarily unavailable."
  └── Other     → "Something went wrong: {message}"

All errors returned as normal chat messages (not HTTP 500), with the matching HTTP status code.
```

### 5.5 Smart Truncation Algorithm

Tool results from SAP can be large. `smartTruncate()` ensures they fit within the 16KB limit:

```
Phase 1: Clean OData JSON
  ├── Convert /Date(...)/ → YYYY-MM-DD
  ├── Convert PT08H37M24S → 08:37:24
  ├── Strip __metadata objects
  ├── Strip __deferred navigation links
  └── Remove null / empty string values

Phase 2: Drop fields by value (if still over limit)
  ├── Score fields:  ID/Key=100  Amount/Name=90  Date=85  Org=60  Status=20  Boolean=10
  ├── Sort by score descending
  └── Drop lowest-scored fields until it fits (minimum 3 fields kept)

KEY PRINCIPLE: Drop FIELDS to fit limit, NEVER drop RECORDS.
The LLM always sees all matching records, just with fewer columns.
```

---

## 6. Session Management

### 6.1 Server-Side Sessions (chatHandler.js)

```
sessions: Map<sessionId, {
  messages:     Array<{role, content}>   // Full conversation history
  turnCount:    number                   // Messages sent (max 20)
  tokenUsage:   {prompt, completion, total}  // Cumulative LLM tokens
  lastActivity: number                   // Timestamp for TTL pruning
}>
```

| Setting | Value | Notes |
|---------|-------|-------|
| `MAX_TURNS` | 20 | Max messages per session |
| `CONTEXT_WINDOW` | 64 | Messages sent to LLM (last 32 exchanges) |
| `SESSION_TTL` | 60 min | Inactivity timeout |
| `MAX_TOOL_ROUNDS` | 6 | Max function-calling iterations per message |
| Pruning interval | 5 min | Background `setInterval`, also releases MCP transport |

### 6.2 Client-Side Sessions (chat.js)

| Element | Mechanism | Reset trigger |
|---------|-----------|---------------|
| `sessionId` | `crypto.randomUUID()` — sent with every request | New Chat button |
| `turnCount` | Mirrors server-side count | New Chat, Clear Chat |
| `tokenUsage` | Accumulated from server response | New Chat, Clear Chat |

### 6.3 Session Reset Operations

| Operation | Button | Effect |
|-----------|--------|--------|
| **New Chat** | "New Chat" | POST /session/reset → destroy session + MCP transport → new sessionId |
| **Clear Chat** | "Clear" | POST /session/clear → reset messages + turns, keep same sessionId + MCP connection warm |

### 6.4 MCP Transport Sessions (mcpClient.js)

- One `StreamableHTTPClientTransport` per chat session
- Stored in `sessionClients: Map<sessionId, Client>`
- Auto-reconnect on session/connection errors (one retry)
- Released on: session reset, session expiry, or background pruning

---

## 7. Token Usage Tracking

LLM token usage is tracked per session and displayed in the UI.

```
Flow:
  1. OpenAI returns usage: { prompt_tokens, completion_tokens, total_tokens }
  2. llmClient.js attaches _tokenUsage to the assistant message object
  3. chatHandler.js reads _tokenUsage, adds to session.tokenUsage accumulator
  4. chatHandler.js DELETES _tokenUsage from the message before pushing to
     conversation array  ← Critical: OpenAI rejects unknown properties on replay
  5. server.js returns { reply, tokenUsage } in response
  6. UI shows: "17 messages remaining · 4,238 tokens used"
```

---

## 8. Frontend Architecture

### 8.1 Module Structure

```
webapp/
├── index.html           HTML shell — no inline JS or CSS
├── css/
│   └── style.css        CSS custom properties for light/dark/auto themes (662 lines)
└── js/
    ├── app.js           Entry point — event wiring, theme toggle, admin check, init
    ├── chat.js          CSRF handling, fetch calls, session state, token tracking
    ├── components.js    DOM builders: messages, welcome screen, thinking dots, turn counter
    ├── markdown.js      Markdown → HTML (tables, code blocks, lists, headings, bold, italic)
    └── logs.js          Admin log viewer: fetch, filter, search, clear, auto-refresh
```

- **No build step.** Native `<script type="module">` with `import`/`export`.
- **No framework.** Vanilla JS DOM APIs only.
- **No CDN.** Zero external dependencies in the browser.

### 8.2 UI Features

| Feature | Implementation |
|---------|---------------|
| Chat bubbles | `div.msg-wrap` with role-based alignment (user right / bot left) |
| Markdown rendering | Custom parser: tables, bold, italic, fenced code, lists, headings |
| Thinking animation | CSS `@keyframes` on three `<span>` dots |
| Dark mode | CSS custom properties + `data-theme` attribute (auto/light/dark) |
| Theme persistence | `localStorage.getItem('theme')` |
| Copy button | `navigator.clipboard.writeText()` on hover over bot messages |
| Response time | `performance.now()` delta shown as "(2.3s)" |
| Scroll-to-bottom | Floating button, visible when scrolled > 200px from bottom |
| Turn counter | "X messages remaining · Y tokens used" — amber when ≤ 3 turns |
| Token counter | Cumulative session token usage from OpenAI response metadata |
| Starter chips | Welcome screen with suggested queries |
| Auto-grow textarea | `input` event → set height to `scrollHeight` (max 120px) |
| Clear Chat | Resets UI + server messages/turns, keeps MCP transport warm |
| New Chat | Destroys session + MCP transport, generates fresh sessionId |
| Keyboard | Enter = send, Shift+Enter = newline |
| Admin Logs tab | Role-gated tab (admin scope) with real-time log viewer |

### 8.3 Admin Log Viewer

The Logs tab is visible only to users with the `admin` XSUAA scope. It provides a real-time view
of the backend's in-memory log buffer (ring buffer, 500 entries max).

```
┌─────────────────────────────────────────────────────┐
│  Logs Toolbar                                        │
│  [All levels ▼]  [Search logs...]    [Refresh] [Clear]│
├─────────────────────────────────────────────────────┤
│  Timestamp    Level   Message                        │
│  Jun 22 14:02 INFO    [Chat] "Show me billing..."    │
│  Jun 22 14:02 INFO    [MCP] Calling: discover-sap... │
│  Jun 22 14:03 ERROR   [MCP] Error (execute-sap-...   │
│  ...                                                 │
└─────────────────────────────────────────────────────┘
```

| Feature | Detail |
|---------|--------|
| Ring buffer | `logBuffer.js` intercepts console.log/warn/error, stores last 500 entries |
| Level filter | Dropdown: All / Info / Warn / Error |
| Search | Substring search with 300ms debounce |
| Auto-refresh | Every 5s (toggleable) |
| Clear | DELETE `/admin/logs` — empties ring buffer |
| Message formatting | Bracketed tags `[MCP]` highlighted, JSON dimmed, serviceIds colored |
| Stats bar | `{used}/{max} · N errors · N warns` |
| Access control | App Router enforces `$XSAPPNAME.admin` scope; server.js double-checks JWT |

### 8.4 Responsive Breakpoints

| Breakpoint | Change |
|------------|--------|
| < 600px | Message width: 90%, header stacks, reduced padding |
| ≥ 600px | Message width: 72%, side-by-side header layout |

---

## 9. Authentication & Security

### 9.1 Auth Flow

```
Browser
  │
  │  GET / (unauthenticated)
  ▼
App Router ──▶ XSUAA login page (OAuth2 authorization_code)
                │
                │  Login via Microsoft Entra ID (Scania SSO)
                │  → XSUAA issues JWT
                │  audience: sb-fiori-chat-poc-SBX!tXXXXX
                ▼
App Router ──▶ MCP Client (Bearer JWT in header, forwardAuthToken: true)
                │
                ├── Extracts user scopes from JWT (admin check for logs)
                │
                └── Uses SEPARATE token for MCP Server calls:
                    client_credentials grant
                    client_id: from sap-mcp-xsuaa-SBX service key
                    (User JWT has WRONG audience for MCP server — cannot be forwarded)
```

### 9.2 XSUAA Configuration (xs-security.json)

```json
{
  "xsappname": "fiori-chat-poc",
  "tenant-mode": "dedicated",
  "scopes": [
    { "name": "$XSAPPNAME.user", "description": "Chat user" },
    { "name": "$XSAPPNAME.admin", "description": "Admin — access logs and diagnostics" }
  ],
  "role-templates": [
    { "name": "ChatUser", "scope-references": ["$XSAPPNAME.user"] },
    { "name": "LogAdmin", "scope-references": ["$XSAPPNAME.user", "$XSAPPNAME.admin"] }
  ],
  "role-collections": [
    { "name": "Fiori Chat Admin", "role-template-references": ["$XSAPPNAME.LogAdmin"] },
    { "name": "Fiori Chat User", "role-template-references": ["$XSAPPNAME.ChatUser"] }
  ]
}
```

### 9.3 App Router Security (xs-app.json)

| Setting | Value |
|---------|-------|
| Auth | All routes require XSUAA login |
| Admin routes | `^/admin/(.*)$` requires `$XSAPPNAME.admin` scope |
| CSP | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'` |
| CSRF | Enforced on all POST requests by App Router |
| Timeout | 120s on `mcp-client-backend` destination (LLM calls can take 30–60s) |
| Routing | `/admin/*` → admin endpoints, `/api/*` and `/*` → MCP Client backend |

### 9.4 Data Flow Through OpenAI

SAP business data **does** transit the OpenAI API — the LLM needs to see the data to format its answer. However:
- **Credentials/tokens never leave BTP.** OAuth tokens are used within the BTP network only.
- **Under Enterprise API terms**, data sent to OpenAI is not used for training.
- **No PII is stored** by the application — all state is in-memory and ephemeral.

### 9.5 Known Security Items

- `/chat` endpoint checks for Bearer token presence but does not enforce `user` scope (deferred for PoC)
- CORS not restricted to specific origins
- No server-side rate limiting
- Secrets currently in CF env vars (Credential Store code exists but no binding)
- No `helmet` middleware for HTTP security headers
- XSS risk from LLM-generated HTML (no DOMPurify sanitization)

---

## 10. Deployment

### 10.1 MTA Structure

```
fiori-chat-poc (ID: fiori-chat-poc, Version: 1.0.0)
│
├── sap-mcp-server               Open-source MCP server — 512MB
│    requires: sap-mcp-destination-SBX, sap-mcp-connectivity-SBX, sap-mcp-xsuaa-SBX
│    provides: sap-mcp-server-api
│
├── fiori-chat-mcp-client         Node.js backend + static UI — 256MB
│    requires: poc-chat-xsuaa, sap-mcp-server-api
│    provides: fiori-chat-mcp-client-api
│
├── fiori-chat-router             @sap/approuter — 128MB
│    requires: poc-chat-xsuaa, fiori-chat-mcp-client-api (destination)
│
├── sap-mcp-destination-SBX       Existing service (Destination)
├── sap-mcp-connectivity-SBX      Existing service (Connectivity)
├── sap-mcp-xsuaa-SBX             Existing service (XSUAA for MCP server)
└── poc-chat-xsuaa                New managed XSUAA (for chat app)
```

### 10.2 Build & Deploy

```bash
cd MCPClient-poc
mbt build -t ./                       # → fiori-chat-poc_1.0.0.mtar
cf deploy fiori-chat-poc_1.0.0.mtar
```

**Post-deploy — secrets (NOT in mta.yaml):**
```bash
# LLM configuration
cf set-env fiori-chat-mcp-client LLM_API_KEY '<openai-key>'
cf set-env fiori-chat-mcp-client LLM_MODEL 'gpt-5.4-mini'

# MCP server auth (from sap-mcp-xsuaa-SBX service key)
# MCP_CLIENT_ID contains "!" — use printf to bypass shell expansion
printf '%s' 'sb-btp-sap-odata-...!tXXXXX' \
  | xargs -I{} cf set-env fiori-chat-mcp-client MCP_CLIENT_ID "{}"
cf set-env fiori-chat-mcp-client MCP_CLIENT_SECRET '<secret>'

# MCP server service filtering
cf set-env sap-mcp-server-SBX ODATA_SERVICE_PATTERNS '<pattern>'
cf set-env sap-mcp-server-SBX ODATA_MAX_SERVICES 200

cf restart fiori-chat-mcp-client
cf restart sap-mcp-server-SBX
```

### 10.3 Environment Variables

| Variable | Set In | Purpose |
|----------|--------|---------|
| `MCP_SERVER_URL` | mta.yaml (auto) | MCP server endpoint (resolved from `sap-mcp-server-api`) |
| `LLM_BASE_URL` | mta.yaml | OpenAI API base URL |
| `LLM_MODEL` | cf set-env | LLM model identifier (default in mta.yaml: `gpt-4o-mini`) |
| `LLM_API_KEY` | cf set-env | OpenAI API key |
| `MCP_CLIENT_ID` | cf set-env | XSUAA client ID for MCP server auth |
| `MCP_CLIENT_SECRET` | cf set-env | XSUAA client secret |
| `MCP_UAA_URL` | Auto (from VCAP) | XSUAA token endpoint (extracted at startup) |
| `ODATA_SERVICE_PATTERNS` | cf set-env (MCP server) | Glob pattern for service filtering |
| `ODATA_MAX_SERVICES` | cf set-env (MCP server) | Max services to discover |
| `DEV_TOKEN` | .env (local only) | JWT for local dev without App Router |

### 10.4 Deployed URLs

| App | URL |
|-----|-----|
| App Router (entry point) | `https://scania-ieb---poc-sbx-sbx-fiori-chat-router.cfapps.eu10-004.hana.ondemand.com` |
| MCP Client (backend API) | `https://scania-ieb---poc-sbx-sbx-fiori-chat-mcp-client.cfapps.eu10-004.hana.ondemand.com` |
| MCP Server | `https://scania-ieb---poc-sbx-sbx-sap-mcp-server.cfapps.eu10-004.hana.ondemand.com` |

### 10.5 CF Org & Space

| Field | Value |
|-------|-------|
| API Endpoint | `https://api.cf.eu10-004.hana.ondemand.com` |
| Org | `Scania_ieb_-_poc-sbx` |
| Space | `SBX` |
| Region | EU10 (Frankfurt) |

---

## 11. Credential Store Integration

The codebase includes `credstoreClient.js` which supports loading secrets from BTP Credential Store (proxy plan). This is **coded but not currently bound** — secrets are set via `cf set-env` for simplicity.

### 11.1 How It Works (When Bound)

```
App Startup → initSecrets()
  │
  ├── Check VCAP_SERVICES for credstore binding
  │
  ├── If bound:
  │    ├── Fetch llm-api-key      → set LLM_API_KEY env var
  │    ├── Fetch mcp-client-id    → set MCP_CLIENT_ID env var
  │    ├── Fetch mcp-client-secret → set MCP_CLIENT_SECRET env var
  │    └── Extract UAA URL from XSUAA → set MCP_UAA_URL env var
  │
  └── If not bound:
       └── Fall back to environment variables (current behavior)
```

### 11.2 To Enable

1. Create a Credential Store instance: `cf create-service credstore proxy credstore-poc`
2. Store secrets: `llm-api-key`, `mcp-client-id`, `mcp-client-secret`
3. Bind to app: add `credstore-poc` as a requirement in `mta.yaml`
4. Redeploy — `initSecrets()` will auto-detect the binding and load secrets

---

## 12. File Reference

```
MCPClient-poc/
├── mta.yaml                          MTA descriptor (3 modules, 4 services)
├── xs-security.json                  XSUAA configuration (scopes, role templates)
├── ARCHITECTURE.md                   This document
├── .gitignore                        Excludes node_modules, .env, build artifacts, PNGs
├── architecture-diagram.html         SVG technical architecture diagram
├── flow-diagram.html                 SVG simplified flow diagram (non-technical audience)
│
├── fiori-chat-router/                App Router module
│   ├── package.json                  @sap/approuter ^16 dependency
│   └── xs-app.json                   Routes, CSP headers, admin scope, auth config
│
├── fiori-chat-mcp-client/            MCP Client module (backend + UI)
│   ├── package.json                  Dependencies (MCP SDK, OpenAI, Express)
│   ├── .env.example                  Environment variable template
│   ├── .cfignore                     CF deploy exclusions
│   ├── .gitignore                    Excludes .env, node_modules, logs
│   │
│   ├── src/
│   │   ├── server.js                 Express app: routes, CORS, admin endpoints, static serving
│   │   ├── chatHandler.js            Orchestration: tool loop, fuzzy serviceId, smart truncation, sessions
│   │   ├── mcpClient.js              MCP transport: connect, callTool, token cache, retry
│   │   ├── llmClient.js              OpenAI client: system prompt, tool conversion
│   │   ├── credstoreClient.js        BTP Credential Store reader (fallback to env vars)
│   │   └── logBuffer.js              Ring buffer (500 entries) intercepting console output
│   │
│   └── webapp/
│       ├── index.html                HTML shell with tab navigation (Chat / Logs)
│       ├── xs-app.json               Static file serving config
│       ├── css/style.css             Theming, layout, log viewer, responsive (662 lines)
│       └── js/
│           ├── app.js                Init, tab switching, admin check, theme toggle
│           ├── chat.js               CSRF, sendMessage(), session reset, clear
│           ├── components.js         Message bubbles, welcome screen, turn/token counter
│           ├── markdown.js           Markdown → HTML (tables, code, lists, bold, italic)
│           └── logs.js               Admin log viewer: fetch, filter, search, clear
│
└── sap-mcp-server/                   Open-source MCP server (consumed, not built by us)
    ├── src/                          TypeScript source (compiled to dist/)
    │   ├── index.ts                  HTTP server + session management
    │   ├── mcp-server.ts             MCP protocol orchestrator
    │   ├── tools/
    │   │   └── hierarchical-tool-registry.ts  3-level progressive discovery
    │   ├── services/
    │   │   ├── auth-service.ts       XSUAA JWT validation + OAuth
    │   │   ├── destination-service.ts BTP Destination Service bridge
    │   │   ├── sap-client.ts         OData execution client
    │   │   └── sap-discovery.ts      Service/entity discovery
    │   ├── types/
    │   │   └── sap-types.ts          ODataService, EntityType, Property interfaces
    │   └── utils/
    │       └── config.ts             Env config + service filtering (glob, regex)
    ├── package.json                  MCP SDK, SAP Cloud SDK, Zod, Winston
    ├── tsconfig.json                 ES2022, Node16 modules
    ├── xs-security.json              MCP server XSUAA scopes
    └── mta.yaml                      Standalone deploy config (not used in combined MTA)
```

---

## 13. Dependencies

### Backend (fiori-chat-mcp-client)

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.10.1 | MCP client, Streamable HTTP transport |
| `openai` | ^4.96.0 | OpenAI-compatible LLM API client |
| `express` | ^4.21.2 | HTTP server, static files, routing |
| `cors` | ^2.8.5 | Cross-origin request handling |
| `dotenv` | ^16.4.7 | Local .env file loading |
| `@sap/xssec` | ^4.2.4 | XSUAA JWT validation |
| `@sap/xsenv` | ^5.4.0 | VCAP_SERVICES parsing on CF |

### MCP Server (sap-mcp-server)

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.17.1 | MCP server protocol |
| `@sap-cloud-sdk/connectivity` | ^4.x | BTP connectivity + destinations |
| `@sap-cloud-sdk/http-client` | ^4.x | HTTP requests via destinations |
| `express` | ^4.18.0 | HTTP server |
| `helmet` | ^7.0.0 | Security headers |
| `zod` | ^3.22.0 | Schema validation |
| `winston` | ^3.8.0 | Structured logging |

### Frontend

No npm dependencies. Zero external scripts or CDN resources.

---

## 14. Links

| Resource | URL |
|----------|-----|
| App (entry point) | https://scania-ieb---poc-sbx-sbx-fiori-chat-router.cfapps.eu10-004.hana.ondemand.com |
| GitHub Repository | https://github.com/deparashar/ai-chatbot-poc |
| MCP Server (open-source) | https://github.com/lemaiwo/btp-sap-odata-to-mcp-server |
| OpenAI API Docs | https://platform.openai.com/docs |
| MCP Specification | https://modelcontextprotocol.io |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk |
| SAP BTP Cockpit | https://emea.cockpit.btp.cloud.sap |
| XSUAA Docs | https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax |
| App Router Docs | https://help.sap.com/docs/btp/sap-business-technology-platform/application-router |
| MTA Build Tool | https://sap.github.io/cloud-mta-build-tool |
