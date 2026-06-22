# SAP AI Chat Assistant — Improvement Plan

**Generated:** 22 June 2026
**Based on:** Source code review + deployment observations

---

## HIGH PRIORITY

### 1. No streaming — entire response buffered before display
- **Where:** `fiori-chat-mcp-client/webapp/js/chat.js` + `src/llmClient.js`
- **Problem:** The entire LLM response is fetched in one `fetch()` call. For multi-tool-call queries (10–30s), the user sees only thinking dots with no progressive content.
- **Fix:** Switch to `stream: true` on the OpenAI API call and use Server-Sent Events to push partial responses to the frontend. Cuts perceived latency from 30s to <1s for first token.

### 2. No request abort/timeout on frontend
- **Where:** `fiori-chat-mcp-client/webapp/js/chat.js:sendMessage()`
- **Problem:** No `AbortController` on the fetch call. If the server hangs, the user is stuck with a permanent "thinking" animation and no way to cancel except refreshing.
- **Fix:** Add `AbortController` with a 60s timeout. Add a "Stop generating" button visible during requests.

### 3. User scope not enforced on /chat endpoint
- **Where:** `fiori-chat-mcp-client/src/server.js:93`
- **Problem:** The `/chat` POST endpoint checks for Bearer token presence but does not verify the `user` XSUAA scope. Any authenticated user (even without role assignment) can chat.
- **Fix:** Add scope check: `if (!scopes.includes('user')) return res.status(403)`. The App Router catch-all route should also add `"scope": "$XSAPPNAME.user"`.

### 4. Secrets in CF environment variables
- **Where:** Deployment (cf set-env)
- **Problem:** `LLM_API_KEY`, `MCP_CLIENT_ID`, `MCP_CLIENT_SECRET` are in plain env vars. Anyone with CF space developer access can read them via `cf env`.
- **Fix:** Bind BTP Credential Store service. The code already supports it (`credstoreClient.js`) — just needs a service instance and binding in `mta.yaml`.

### 5. `$count` operation not supported
- **Where:** MCP server tool registry
- **Problem:** Users ask "how many billing documents are there?" but the MCP server doesn't support `$count`. The LLM falls back to fetching all records and counting, which is slow and may hit limits.
- **Fix:** Either add `$count` support to the MCP server (upstream PR) or add a system prompt instruction telling the LLM to use `topNumber: 1` with a note that exact counts are not available.

### 6. `res.json()` called before `res.ok` check — crashes on non-JSON errors
- **Where:** `fiori-chat-mcp-client/webapp/js/chat.js`
- **Problem:** `await res.json()` is called unconditionally. If the server returns a 502/503 with an HTML error page (common with reverse proxies), `res.json()` throws a `SyntaxError`.
- **Fix:** Check `res.ok` first, then conditionally parse JSON:
  ```js
  if (!res.ok) {
    const text = await res.text();
    try { return JSON.parse(text).error; } catch { return text; }
  }
  const data = await res.json();
  ```

### 7. Turn count incremented on failure — locks users out
- **Where:** `fiori-chat-mcp-client/webapp/js/chat.js`
- **Problem:** `turnCount++` happens before the request. If the request fails, the turn is still consumed. After 20 failures, the user is locked out despite having no successful conversation.
- **Fix:** Move `turnCount++` to after a successful response.

---

## MEDIUM PRIORITY

### 8. CSRF token cached forever, no refresh on 403
- **Where:** `fiori-chat-mcp-client/webapp/js/chat.js:fetchCsrf()`
- **Problem:** Once `csrfToken` is set, it's cached indefinitely. If the token expires server-side, every subsequent request fails with 403. Only `resetSession()` clears it.
- **Fix:** On 403 response, clear `csrfToken` and retry once with a fresh token.

### 9. No CORS origin whitelist
- **Where:** `fiori-chat-mcp-client/src/server.js`
- **Problem:** `app.use(cors())` allows all origins. In production, only the App Router URL should be allowed.
- **Fix:** `app.use(cors({ origin: 'https://scania-ieb---poc-sbx-sbx-fiori-chat-router.cfapps.eu10-004.hana.ondemand.com' }))` or read from environment.

### 10. No security headers (helmet)
- **Where:** `fiori-chat-mcp-client/src/server.js`
- **Problem:** No `X-Frame-Options`, `HSTS`, `X-Content-Type-Options` headers on backend responses.
- **Fix:** `npm install helmet` and add `app.use(helmet())` before routes.

### 11. No rate limiting on /chat
- **Where:** `fiori-chat-mcp-client/src/server.js`
- **Problem:** No server-side rate limiting. A single user can exhaust OpenAI API quota by sending rapid requests.
- **Fix:** `npm install express-rate-limit` — limit `/chat` to ~30 requests per 15 minutes per session.

### 12. mta.yaml default LLM_MODEL is stale
- **Where:** `mta.yaml:58`
- **Problem:** `LLM_MODEL` default is `gpt-4o-mini` but the deployed app uses `gpt-5.4-mini` (set via `cf set-env`). After a fresh `cf deploy`, the model reverts to the old default.
- **Fix:** Update `mta.yaml` line 58 to `LLM_MODEL: gpt-5.4-mini`.

### 13. No "Stop generating" button
- **Where:** Frontend (`webapp/js/app.js`)
- **Problem:** While the bot is thinking (up to 30s+), the user cannot cancel the request.
- **Fix:** Show a "Stop" button during requests that calls `AbortController.abort()` on the pending fetch.

### 14. No DOMPurify for LLM output
- **Where:** `fiori-chat-mcp-client/webapp/js/markdown.js`
- **Problem:** The markdown renderer converts LLM output to HTML. A malicious prompt could inject `<script>` or `<img onerror>` via the LLM response.
- **Fix:** Add `DOMPurify.sanitize()` after markdown-to-HTML conversion.

### 15. All state is in-memory — lost on restart
- **Where:** `chatHandler.js` sessions Map, `mcpClient.js` sessionClients Map
- **Problem:** App restart (deploy, crash, container recycle) loses all active sessions silently. Users get no feedback.
- **Fix:** For PoC, add a frontend check: if a session request returns "session not found", show a message and auto-reset. For production, consider Redis-backed sessions.

---

## LOW PRIORITY

### 16. Missing favicon — 404 on every page load
- **Where:** `fiori-chat-mcp-client/webapp/`
- **Problem:** Browser requests `/favicon.ico`, gets 404. Wasted request + noise in logs.
- **Fix:** Add a `favicon.ico` to `webapp/`, or add a route returning 204.

### 17. No offline detection
- **Where:** Frontend
- **Problem:** If the user loses connectivity, the only feedback is a raw `TypeError: Failed to fetch`.
- **Fix:** Add `navigator.onLine` check and `offline`/`online` event listeners. Show a toast when offline.

### 18. Scroll listener not throttled
- **Where:** `fiori-chat-mcp-client/webapp/js/components.js`
- **Problem:** Scroll listener reads `scrollHeight`/`scrollTop`/`clientHeight` on every scroll event (60+ fps during momentum scrolling), triggering layout recalculation.
- **Fix:** Throttle with `requestAnimationFrame`.

### 19. No markdown link support
- **Where:** `fiori-chat-mcp-client/webapp/js/markdown.js`
- **Problem:** The markdown renderer handles headings, bold, italic, code, tables, lists — but no `[text](url)` links. URLs in bot responses appear as raw text.
- **Fix:** Add regex for link rendering: `text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')`

### 20. No CSV/table export for SAP data
- **Where:** Frontend
- **Problem:** SAP data responses (tables) cannot be exported. The copy button only copies raw markdown.
- **Fix:** Add a "Download CSV" button on messages containing tables. Parse the markdown table and generate CSV.

### 21. No confirmation on "New Chat" / "Clear Chat"
- **Where:** `fiori-chat-mcp-client/webapp/js/app.js`
- **Problem:** Both handlers immediately destroy all messages without confirmation. A misclick wipes the conversation.
- **Fix:** Add a `confirm()` dialog before clearing, or implement undo with a 5s toast.

### 22. App Router forwards ALL requests to backend — no local static files
- **Where:** `fiori-chat-router/xs-app.json`
- **Problem:** Every CSS/JS/HTML request takes an extra network hop through approuter → backend (10–50ms per file).
- **Fix:** Copy static assets into `fiori-chat-router/` and add `localDir` routes for `/js/*` and `/css/*`.

---

## Architecture Notes

- **MCP server is open-source.** It is deployed from [lemaiwo/btp-sap-odata-to-mcp-server](https://github.com/lemaiwo/btp-sap-odata-to-mcp-server). Do not modify it directly — use env vars for configuration. Feature requests (like `$count`) should go upstream.
- **OData V2 only.** The MCP server discovers via V2 catalog. V4 services are not visible.
- **All state is in-memory.** Session data and MCP clients are stored in `Map` objects. App restarts lose all sessions.
- **Single instance.** All 3 apps run with 1 instance. Container recycling during deployments causes brief connection drops.
- **Env vars not persisted across `cf deploy`** — must be re-set after every full deploy. Only `cf restart` preserves them.
