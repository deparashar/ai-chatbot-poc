'use strict';

const { getTools, getOrCreateSession, releaseSession, callTool } = require('./mcpClient');
const { chat, toOpenAITools } = require('./llmClient');

const MAX_TOOL_ROUNDS = 5;
const MAX_TURNS = 20;
const CONTEXT_WINDOW = 8;           // send only last 8 messages (4 exchanges) to LLM
const SESSION_TTL_MS = 60 * 60 * 1000;
const TRUNCATE_LIMIT = 4000;

// ── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();

// Prune expired sessions every 5 minutes (not on every request)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      releaseSession(id).catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

// ── Service catalog cache (pre-loaded once, saves 1 LLM roundtrip) ──────────
let catalogCache = null;
let catalogServiceIds = [];   // extracted serviceId list for fuzzy matching

async function getServiceCatalog(sessionId) {
  if (catalogCache) return catalogCache;
  try {
    const result = await callTool(sessionId, 'discover-sap-data', { limit: 20 });
    catalogCache = result;
    // Extract serviceId list for fuzzy matching
    try {
      const parsed = JSON.parse(result);
      const services = Array.isArray(parsed) ? parsed : (parsed.services || parsed.results || []);
      catalogServiceIds = services.map(s => s.serviceId || s.id || s.name).filter(Boolean);
    } catch { /* not JSON — try regex fallback */
      const matches = result.matchAll(/"serviceId"\s*:\s*"([^"]+)"/g);
      catalogServiceIds = [...matches].map(m => m[1]);
    }
    console.log(`[Catalog] Pre-loaded ${catalogServiceIds.length} service IDs`);
    return catalogCache;
  } catch (err) {
    console.warn('[Catalog] Failed to pre-fetch:', err.message);
    return null;
  }
}

/**
 * Fuzzy-resolve a serviceId against the catalog.
 * The LLM often strips the _0001 suffix (e.g. "ZSB_CONTACT_UI_O2" instead of
 * "ZSB_CONTACT_UI_O2_0001"). This finds the best match from known serviceIds.
 */
function resolveServiceId(rawId) {
  if (!rawId || catalogServiceIds.length === 0) return rawId;
  // Exact match — return as-is
  if (catalogServiceIds.includes(rawId)) return rawId;
  // Case-insensitive exact match
  const lower = rawId.toLowerCase();
  const exact = catalogServiceIds.find(id => id.toLowerCase() === lower);
  if (exact) return exact;
  // Prefix match: rawId is a prefix of a catalog entry (e.g. missing _0001)
  const prefixMatch = catalogServiceIds.find(id => id.toLowerCase().startsWith(lower));
  if (prefixMatch) {
    console.log(`[Catalog] Fuzzy-resolved "${rawId}" → "${prefixMatch}"`);
    return prefixMatch;
  }
  // Contains match (rawId contained within a catalog entry)
  const containsMatch = catalogServiceIds.find(id => id.toLowerCase().includes(lower));
  if (containsMatch) {
    console.log(`[Catalog] Fuzzy-resolved "${rawId}" → "${containsMatch}"`);
    return containsMatch;
  }
  return rawId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function smartTruncate(text, limit = TRUNCATE_LIMIT) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf('}', limit);
  const pos = cut > limit * 0.5 ? cut + 1 : limit;
  return text.substring(0, pos) + '\n...[truncated]';
}

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

// ── Auto-chain: enrich get-entity-metadata results with actual data ─────────
// When the LLM calls get-entity-metadata and the user wants records,
// we auto-fetch the data so the LLM can format everything in one response.

const DATA_INTENT_RE = /show|fetch|read|list|give|get|display|record|booking|customer|order|product|travel|data|entries|items|rows/i;

function extractEntityName(metadataText) {
  try {
    const data = JSON.parse(metadataText);
    const entities = Array.isArray(data) ? data
      : data.entities || data.entitySets || data.results || [];
    if (entities.length > 0) {
      return entities[0].name || entities[0].entityName || entities[0].Name || null;
    }
  } catch {}
  const match = metadataText.match(/"(?:name|entityName|entity_name)"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function tryAutoChain(sessionId, toolName, toolInput, result, userMessage) {
  // Only auto-chain after get-entity-metadata when user wants actual data
  if (toolName !== 'get-entity-metadata') return result;
  if (!DATA_INTENT_RE.test(userMessage)) return result;

  const entityName = extractEntityName(result);
  if (!entityName) return result;

  try {
    console.log(`[Auto-chain] Fetching records: ${toolInput.serviceId} / ${entityName}`);
    const data = await callTool(sessionId, 'execute-sap-operation', {
      serviceId: toolInput.serviceId,
      entityName,
      operation: 'read',
      topNumber: 5,
    });
    return `${result}\n\n--- Auto-fetched first 5 records from "${entityName}" ---\n${data}`;
  } catch (err) {
    console.warn(`[Auto-chain] Failed:`, err.message);
    return result;
  }
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

  // Pre-fetch tools, service catalog, and warm MCP session in parallel
  const [mcpTools, serviceCatalog] = await Promise.all([
    getTools(),
    getServiceCatalog(sessionId),
    getOrCreateSession(sessionId),
  ]);
  const openAITools = toOpenAITools(mcpTools);

  // Sliding context window: send only recent messages to keep token usage flat
  const recent = session.messages.length > CONTEXT_WINDOW
    ? session.messages.slice(-CONTEXT_WINDOW)
    : session.messages;
  const messages = [...recent];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantMessage;
    try {
      assistantMessage = await chat(messages, openAITools, serviceCatalog);
    } catch (llmErr) {
      const classified = classifyLLMError(llmErr);
      console.error(`[LLM] ${classified.status}: ${llmErr.message}`);
      return { reply: classified.userMessage, tokenUsage: session.tokenUsage };
    }

    // Accumulate token usage from this LLM call, then strip it
    // before adding to messages (Groq rejects unknown properties)
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

    // Execute tool calls in parallel, with auto-chaining
    const results = await Promise.all(
      validCalls.map(async ({ toolCall, toolInput }) => {
        const toolName = toolCall.function.name;
        // Fuzzy-resolve serviceId before calling MCP (LLM often drops _0001 suffix)
        if (toolInput.serviceId) {
          toolInput.serviceId = resolveServiceId(toolInput.serviceId);
        }
        console.log(`[MCP] Calling: ${toolName}`, JSON.stringify(toolInput));
        try {
          let result = await callTool(sessionId, toolName, toolInput);

          // Auto-chain: if this was get-entity-metadata and user wants data,
          // also fetch the records so the LLM can respond in one shot
          result = await tryAutoChain(sessionId, toolName, toolInput, result, userMessage);

          const truncated = smartTruncate(result, 6000);
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
