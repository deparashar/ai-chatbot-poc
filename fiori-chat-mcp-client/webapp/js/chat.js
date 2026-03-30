/**
 * Chat session management: CSRF handling, message sending, session reset.
 */

const MAX_TURNS = 20;

let csrfToken = null;
let sessionId = crypto.randomUUID();
let turnCount = 0;
let tokenUsage = { prompt: 0, completion: 0, total: 0 };

export function getState() {
  return { sessionId, turnCount, MAX_TURNS, tokenUsage };
}

async function fetchCsrf() {
  if (csrfToken) return csrfToken;
  const res = await fetch('/chat', { headers: { 'x-csrf-token': 'fetch' } });
  csrfToken = res.headers.get('x-csrf-token') || 'unsafe';
  return csrfToken;
}

/**
 * Sends a message to the backend and returns { reply, elapsed } or throws.
 */
export async function sendMessage(text) {
  turnCount++;
  const start = performance.now();

  const token = await fetchCsrf();
  const res = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ message: text, sessionId }),
  });

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }

  if (data.tokenUsage) {
    tokenUsage = data.tokenUsage;
  }

  return { reply: data.reply || '(no response)', elapsed };
}

/**
 * Resets the server-side session and returns a new sessionId.
 */
export async function resetSession() {
  try {
    const token = await fetchCsrf();
    await fetch('/session/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ sessionId }),
    });
  } catch (_) { /* best-effort */ }

  sessionId = crypto.randomUUID();
  csrfToken = null;
  turnCount = 0;
  tokenUsage = { prompt: 0, completion: 0, total: 0 };
}

/**
 * Clears messages and turns but keeps the same session (MCP connection stays warm).
 */
export async function clearChatSession() {
  try {
    const token = await fetchCsrf();
    await fetch('/session/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ sessionId }),
    });
  } catch (_) { /* best-effort */ }

  turnCount = 0;
  tokenUsage = { prompt: 0, completion: 0, total: 0 };
}
