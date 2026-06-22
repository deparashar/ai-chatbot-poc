'use strict';

/**
 * SAP Credential Store client (proxy plan).
 *
 * Reads secrets from the BTP Credential Store service bound to this app.
 * In local development (no VCAP_SERVICES), falls back to environment variables.
 *
 * Credential Store REST API:
 *   GET {url}/api/v1/credentials/password/{name}
 *   Authorization: Basic base64(username:password)
 *   sapcp-credstore-namespace: {namespace}
 */

function getCredstoreBinding() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    return vcap.credstore?.[0]?.credentials || null;
  } catch {
    return null;
  }
}

/**
 * Fetches a named password credential from the Credential Store.
 * Returns null if credstore is not bound (local dev fallback).
 */
async function getSecret(name) {
  const creds = getCredstoreBinding();
  if (!creds) return null;

  const { url, username, password, namespace } = creds;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  const res = await fetch(`${url}/api/v1/credentials/password/${encodeURIComponent(name)}`, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'sapcp-credstore-namespace': namespace,
    },
  });

  if (res.status === 404) {
    console.warn(`[CredStore] Secret "${name}" not found in namespace "${namespace}"`);
    return null;
  }
  if (!res.ok) {
    throw new Error(`[CredStore] Failed to fetch "${name}": HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.value;
}

/**
 * Reads the UAA URL from the bound XSUAA service (poc-chat-xsuaa).
 * All XSUAA instances in the same BTP subaccount share the same UAA base URL.
 */
function getUaaUrl() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    const xsuaaEntry = vcap.xsuaa?.[0]?.credentials;
    // url is the full UAA base URL e.g. https://{subdomain}.authentication.eu10.hana.ondemand.com
    return xsuaaEntry?.url || process.env.MCP_UAA_URL || null;
  } catch {
    return process.env.MCP_UAA_URL || null;
  }
}

/**
 * Initialises all secrets at app startup.
 * Loads from Credential Store if bound; falls back to env vars for local dev.
 *
 * Secrets expected in Credential Store (type: password):
 *   - llm-api-key         → OpenAI API key
 *   - mcp-client-id       → XSUAA clientid for MCP server
 *   - mcp-client-secret   → XSUAA clientsecret for MCP server
 */
async function initSecrets() {
  const binding = getCredstoreBinding();

  if (!binding) {
    console.log('[CredStore] No binding found — using environment variables (local dev mode)');
    return;
  }

  console.log(`[CredStore] Bound to namespace "${binding.namespace}" — loading secrets...`);

  const [llmKey, mcpClientId, mcpClientSecret] = await Promise.all([
    getSecret('llm-api-key'),
    getSecret('mcp-client-id'),
    getSecret('mcp-client-secret'),
  ]);

  if (llmKey) {
    process.env.LLM_API_KEY = llmKey;
    console.log('[CredStore] Loaded: llm-api-key');
  } else {
    console.warn('[CredStore] Missing secret: llm-api-key');
  }

  if (mcpClientId) {
    process.env.MCP_CLIENT_ID = mcpClientId;
    console.log('[CredStore] Loaded: mcp-client-id');
  } else {
    console.warn('[CredStore] Missing secret: mcp-client-id');
  }

  if (mcpClientSecret) {
    process.env.MCP_CLIENT_SECRET = mcpClientSecret;
    console.log('[CredStore] Loaded: mcp-client-secret');
  } else {
    console.warn('[CredStore] Missing secret: mcp-client-secret');
  }

  const uaaUrl = getUaaUrl();
  if (uaaUrl) {
    process.env.MCP_UAA_URL = uaaUrl;
    console.log(`[CredStore] UAA URL: ${uaaUrl}`);
  } else {
    console.warn('[CredStore] Could not determine UAA URL from VCAP_SERVICES');
  }
}

module.exports = { initSecrets, getSecret, getUaaUrl };
