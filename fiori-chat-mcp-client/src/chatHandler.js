'use strict';

const { getTools, getOrCreateSession, releaseSession, callTool } = require('./mcpClient');
const { chat, toOpenAITools } = require('./llmClient');

const MAX_TOOL_ROUNDS = 6;
const MAX_TURNS = 20;
const CONTEXT_WINDOW = 64;           // 32 exchanges — keep service discoveries in context
const SESSION_TTL_MS = 60 * 60 * 1000;
const TRUNCATE_LIMIT = 16000;

// ── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();

// Prune expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      releaseSession(id).catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

// ── ServiceId fuzzy matching ────────────────────────────────────────────────
let catalogServiceIds = [];

/**
 * Lazily capture serviceIds from discover-sap-data results.
 * Called after every tool result — no separate warm-up call needed.
 */
function captureServiceIds(toolName, resultText) {
  if (toolName !== 'discover-sap-data') return;
  try {
    const matches = resultText.matchAll(/"serviceId"\s*:\s*"([^"]+)"/g);
    const ids = [...matches].map(m => m[1]);
    if (ids.length > 0) {
      catalogServiceIds = ids;
      console.log(`[Catalog] Captured ${ids.length} service IDs from discover result`);
    }
  } catch { /* ignore */ }
}

/**
 * Fuzzy-resolve a serviceId against known IDs.
 * The LLM often drops the _0001 suffix. This fixes it silently.
 */
function resolveServiceId(rawId) {
  if (!rawId || catalogServiceIds.length === 0) return rawId;
  if (catalogServiceIds.includes(rawId)) return rawId;

  const lower = rawId.toLowerCase();
  const exact = catalogServiceIds.find(id => id.toLowerCase() === lower);
  if (exact) return exact;

  const prefixMatch = catalogServiceIds.find(id => id.toLowerCase().startsWith(lower));
  if (prefixMatch) {
    console.log(`[Catalog] Fuzzy-resolved "${rawId}" → "${prefixMatch}"`);
    return prefixMatch;
  }

  const containsMatch = catalogServiceIds.find(id => id.toLowerCase().includes(lower));
  if (containsMatch) {
    console.log(`[Catalog] Fuzzy-resolved "${rawId}" → "${containsMatch}"`);
    return containsMatch;
  }
  return rawId;
}

// ── SAP value formatting ────────────────────────────────────────────────────

function formatSAPValue(key, value) {
  if (typeof value === 'string') {
    // /Date(1692057600000)/ or /Date(1702028968672+0000)/ → 2023-08-15
    const dateMatch = value.match(/^\/Date\((-?\d+)([+-]\d+)?\)\/$/);
    if (dateMatch) {
      const d = new Date(parseInt(dateMatch[1], 10));
      return d.toISOString().split('T')[0];
    }
    // PT08H37M24S (ISO 8601 duration / SAP time) → 08:37:24
    const timeMatch = value.match(/^PT(\d+)H(\d+)M(\d+)S$/);
    if (timeMatch) {
      return `${timeMatch[1].padStart(2, '0')}:${timeMatch[2].padStart(2, '0')}:${timeMatch[3].padStart(2, '0')}`;
    }
  }
  return value;
}

/**
 * Clean OData results: convert SAP formats, strip metadata/nav links.
 * KEY PRINCIPLE: drop FIELDS to fit limit, NEVER drop RECORDS.
 */
function smartTruncate(text, limit = TRUNCATE_LIMIT) {
  try {
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) throw new Error('not JSON');

    const prefix = text.substring(0, jsonStart);
    const jsonText = text.substring(jsonStart);
    const data = JSON.parse(jsonText);
    const results = data?.d?.results;

    if (Array.isArray(results) && results.length > 0) {
      // Phase 1: Clean each record — convert dates/times, strip metadata
      const cleaned = results.map(r => {
        const clean = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === '__metadata') continue;
          if (v && typeof v === 'object' && v.__deferred) continue;
          if (v === null || v === '') continue;
          clean[k] = formatSAPValue(k, v);
        }
        return clean;
      });

      // Check if it fits
      let candidate = prefix + JSON.stringify({ d: { results: cleaned } });
      if (candidate.length <= limit) return candidate;

      // Phase 2: Drop fields to fit — remove least-useful fields from ALL records
      // Score fields: booleans and single-char values are least useful
      const allKeys = [...new Set(cleaned.flatMap(r => Object.keys(r)))];
      const fieldScores = allKeys.map(key => {
        const sampleVal = cleaned.find(r => r[key] !== undefined)?.[key];
        let score = 50; // default
        // Key/ID fields — keep
        if (/Document|Partner|Order|Delivery|ID$|Number/i.test(key)) score = 100;
        // Business values — keep
        if (/Amount|Price|Quantity|Currency|Name|Description/i.test(key)) score = 90;
        // Dates — keep
        if (/Date/i.test(key)) score = 85;
        // Org fields — medium
        if (/Organization|Channel|Division|Plant|Company/i.test(key)) score = 60;
        // Status/flags — low
        if (/Status|Category|Indicator|IsRelevant|Block|Reason/i.test(key)) score = 20;
        // Booleans — lowest
        if (typeof sampleVal === 'boolean') score = 10;
        // Single-char coded values — low
        if (typeof sampleVal === 'string' && sampleVal.length === 1) score = 15;
        return { key, score };
      });

      // Sort by score descending — drop lowest-scored fields first
      fieldScores.sort((a, b) => b.score - a.score);

      let keepFields = fieldScores.map(f => f.key);
      while (keepFields.length > 3) {
        const pruned = cleaned.map(r => {
          const p = {};
          for (const k of keepFields) {
            if (r[k] !== undefined) p[k] = r[k];
          }
          return p;
        });
        candidate = prefix + JSON.stringify({ d: { results: pruned } });
        if (candidate.length <= limit) return candidate;
        // Drop the lowest-scored remaining field
        keepFields = keepFields.slice(0, keepFields.length - 1);
      }

      // Phase 3: Still too big with only 3 fields — return what we can
      const minimal = cleaned.map(r => {
        const m = {};
        for (const k of keepFields) {
          if (r[k] !== undefined) m[k] = r[k];
        }
        return m;
      });
      return prefix + JSON.stringify({ d: { results: minimal } });
    }

    // Single entity (not array) — clean and return
    if (data?.d && !Array.isArray(data.d)) {
      const clean = {};
      for (const [k, v] of Object.entries(data.d)) {
        if (k === '__metadata') continue;
        if (v && typeof v === 'object') continue;
        if (v === null || v === '') continue;
        clean[k] = formatSAPValue(k, v);
      }
      return prefix + JSON.stringify(clean);
    }
  } catch {
    // Not OData JSON — fall through
  }

  // Fallback: simple truncation at JSON boundary
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf('}', limit);
  const pos = cut > limit * 0.5 ? cut + 1 : limit;
  return text.substring(0, pos) + '\n...[truncated]';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], turnCount: 0, tokenUsage: { prompt: 0, completion: 0, total: 0 }, lastActivity: Date.now() });
  }
  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  return session;
}

function clearSession(sessionId) {
  sessions.delete(sessionId);
  releaseSession(sessionId).catch(() => {});
}

function softResetSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.messages = [];
    session.turnCount = 0;
    session.tokenUsage = { prompt: 0, completion: 0, total: 0 };
    session.lastActivity = Date.now();
  }
  // MCP transport stays alive — no releaseSession()
}

function parseToolArgs(raw) {
  const input = JSON.parse(raw);
  for (const field of ['limit', 'topNumber', 'skipNumber']) {
    if (typeof input[field] === 'string') input[field] = parseInt(input[field], 10);
  }
  return input;
}

// ── LLM error classifier ────────────────────────────────────────────────────

function classifyLLMError(err) {
  const status = err.status || err.statusCode || err.code;
  const msg = err.message || '';

  if (status === 429 || /rate.limit|too.many.requests|quota|tokens.*limit/i.test(msg)) {
    return { userMessage: 'Rate limit exceeded — the LLM API is temporarily throttled. Please wait a moment and try again.', status: 429 };
  }
  if (status === 401 || status === 403 || /auth|api.key|invalid.*key|unauthorized/i.test(msg)) {
    return { userMessage: 'LLM authentication failed. Please check the API key configuration.', status: 401 };
  }
  if (status === 404 || /model.*not.*found|does not exist/i.test(msg)) {
    return { userMessage: `LLM model not found. The configured model may not be available.`, status: 404 };
  }
  if (status === 413 || /too.*large|context.*length|maximum.*tokens|token.*limit/i.test(msg)) {
    return { userMessage: 'Message too long — the conversation exceeded the model\'s context limit. Please clear the chat and try again.', status: 413 };
  }
  if (status >= 500 || /server.*error|service.*unavailable|internal/i.test(msg)) {
    return { userMessage: 'The LLM service is temporarily unavailable. Please try again shortly.', status: 502 };
  }
  return { userMessage: `Something went wrong: ${msg}`, status: 500 };
}

// ── Main chat handler ────────────────────────────────────────────────────────

async function handleChat(userMessage, sessionId) {
  const session = getSession(sessionId);

  if (session.turnCount >= MAX_TURNS) {
    return { reply: `You've reached the limit of ${MAX_TURNS} messages in this chat. Please start a new chat to continue.`, tokenUsage: session.tokenUsage };
  }

  session.messages.push({ role: 'user', content: userMessage });
  session.turnCount++;

  // Pre-fetch tools and warm MCP session in parallel
  const [mcpTools] = await Promise.all([
    getTools(),
    getOrCreateSession(sessionId),
  ]);
  const openAITools = toOpenAITools(mcpTools);

  // Sliding context window
  const recent = session.messages.length > CONTEXT_WINDOW
    ? session.messages.slice(-CONTEXT_WINDOW)
    : session.messages;
  const messages = [...recent];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantMessage;
    try {
      assistantMessage = await chat(messages, openAITools);
    } catch (llmErr) {
      const classified = classifyLLMError(llmErr);
      console.error(`[LLM] ${classified.status}: ${llmErr.message}`);
      return { reply: classified.userMessage, tokenUsage: session.tokenUsage };
    }

    // Accumulate token usage
    if (assistantMessage._tokenUsage) {
      session.tokenUsage.prompt += assistantMessage._tokenUsage.prompt;
      session.tokenUsage.completion += assistantMessage._tokenUsage.completion;
      session.tokenUsage.total += assistantMessage._tokenUsage.total;
      delete assistantMessage._tokenUsage;
    }

    messages.push(assistantMessage);

    // No tool calls — LLM produced a final text answer
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const reply = assistantMessage.content || 'No response generated.';
      session.messages.push({ role: 'assistant', content: reply });
      return { reply, tokenUsage: session.tokenUsage };
    }

    // Deduplicate and parse tool calls
    const seenCalls = new Set();
    const validCalls = [];

    for (const toolCall of assistantMessage.tool_calls) {
      let toolInput;
      try {
        toolInput = parseToolArgs(toolCall.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Invalid tool arguments — skipped.' });
        continue;
      }

      const callKey = `${toolCall.function.name}:${JSON.stringify(toolInput)}`;
      if (seenCalls.has(callKey)) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Duplicate call skipped.' });
        continue;
      }
      seenCalls.add(callKey);
      validCalls.push({ toolCall, toolInput });
    }

    // Execute tool calls in parallel
    const results = await Promise.all(
      validCalls.map(async ({ toolCall, toolInput }) => {
        const toolName = toolCall.function.name;
        // Fuzzy-resolve serviceId (LLM often drops _0001 suffix)
        if (toolInput.serviceId) {
          toolInput.serviceId = resolveServiceId(toolInput.serviceId);
        }
        console.log(`[MCP] Calling: ${toolName}`, JSON.stringify(toolInput));
        try {
          const result = await callTool(sessionId, toolName, toolInput);
          // Lazily capture serviceIds from discover results
          captureServiceIds(toolName, result);
          const truncated = smartTruncate(result, TRUNCATE_LIMIT);
          console.log(`[MCP] Result (${toolName}): ${truncated.substring(0, 200)}`);
          return { id: toolCall.id, content: truncated };
        } catch (err) {
          console.error(`[MCP] Error (${toolName}):`, err.message);
          return { id: toolCall.id, content: `Tool error: ${err.message}` };
        }
      })
    );

    for (const { id, content } of results) {
      messages.push({ role: 'tool', tool_call_id: id, content });
    }
  }

  return { reply: 'Could not generate a response after maximum tool call rounds.', tokenUsage: session.tokenUsage };
}

module.exports = { handleChat, clearSession, softResetSession };
