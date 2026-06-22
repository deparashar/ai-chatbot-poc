'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MCP_SERVER_URL = process.env.MCP_SERVER_URL;

// UAA_URL, MCP_CLIENT_ID and MCP_CLIENT_SECRET are loaded at startup by
// credstoreClient.initSecrets() — read lazily so they're available after init.
function getMcpConfig() {
  return {
    uaaUrl: process.env.MCP_UAA_URL,
    clientId: process.env.MCP_CLIENT_ID,
    clientSecret: process.env.MCP_CLIENT_SECRET,
  };
}

// ── Global: token cache (tokens valid 12h, refresh at 80%) ──────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

// ── Global: tools cache (same 3 tools for every session, never changes) ─────
let cachedTools = null;

// ── Per chat session: live MCP clients ──────────────────────────────────────
const sessionClients = new Map();

// ────────────────────────────────────────────────────────────────────────────

async function getMcpToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const { uaaUrl, clientId, clientSecret } = getMcpConfig();
  if (!uaaUrl || !clientId || !clientSecret) {
    throw new Error('MCP credentials not initialised — check Credential Store bindings');
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(`${uaaUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${creds}`,
    },
    body: 'grant_type=client_credentials&response_type=token',
  });
  if (!resp.ok) throw new Error(`UAA token fetch failed: ${resp.status}`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ? data.expires_in * 0.8 * 1000 : 10 * 60 * 1000);
  return cachedToken;
}

/**
 * Creates and connects a fresh MCP client (internal helper).
 */
async function createClient() {
  const mcpToken = await getMcpToken();
  const transport = new StreamableHTTPClientTransport(
    new URL(`${MCP_SERVER_URL}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }
  );
  const client = new Client(
    { name: 'fiori-chat-mcp-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

/**
 * Returns the MCP tools list. Fetched once globally and cached — tools never
 * change between sessions so there's no need to re-fetch per message.
 */
async function getTools() {
  if (cachedTools) return cachedTools;
  // Bootstrap client just to list tools, then discard it
  const client = await createClient();
  try {
    const { tools } = await client.listTools();
    cachedTools = tools;
    return cachedTools;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Returns a live MCP client for the given chat sessionId.
 * Reuses the existing client if one is alive; creates a new one otherwise.
 */
async function getOrCreateSession(sessionId) {
  if (sessionClients.has(sessionId)) {
    return sessionClients.get(sessionId);
  }
  const client = await createClient();
  sessionClients.set(sessionId, client);
  return client;
}

/**
 * Closes and removes the MCP client for a chat session.
 * Called when the user starts a new chat or the session expires.
 */
async function releaseSession(sessionId) {
  const client = sessionClients.get(sessionId);
  if (client) {
    await client.close().catch(() => {});
    sessionClients.delete(sessionId);
  }
}

/**
 * Calls a single MCP tool. If the call fails due to a stale/expired session,
 * recreates the session once and retries before giving up.
 */
async function callTool(sessionId, toolName, toolInput) {
  let client = await getOrCreateSession(sessionId);
  try {
    return await _callTool(client, toolName, toolInput);
  } catch (err) {
    // Session may have expired on the server side — reconnect once and retry
    const isSessionError =
      err.message?.toLowerCase().includes('session') ||
      err.message?.toLowerCase().includes('connect') ||
      err.code === -32000;

    if (isSessionError) {
      console.warn(`[MCP] Session error for ${sessionId}, reconnecting…`);
      await releaseSession(sessionId);
      client = await getOrCreateSession(sessionId);
      return await _callTool(client, toolName, toolInput);
    }
    throw err;
  }
}

async function _callTool(client, toolName, toolInput) {
  const result = await client.callTool({ name: toolName, arguments: toolInput });
  if (!result.content || result.content.length === 0) return '';
  return result.content
    .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n');
}

module.exports = { getTools, getOrCreateSession, releaseSession, callTool };
