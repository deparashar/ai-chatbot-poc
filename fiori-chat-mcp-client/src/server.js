'use strict';

// Log buffer must be required FIRST to intercept all console output
const { getLogs, getStats, clearLogs } = require('./logBuffer');

require('dotenv').config();

const { initSecrets } = require('./credstoreClient');
const express = require('express');
const cors = require('cors');
const { handleChat, clearSession, softResetSession } = require('./chatHandler');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Serve Fiori UI static files
app.use(express.static(path.join(__dirname, '..', 'webapp')));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// CSRF token preflight — App Router forwards GET with x-csrf-token: fetch
app.get('/chat', (_req, res) => { res.status(200).end(); });

// New Chat — clears server-side session and MCP connection
app.post('/session/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) clearSession(sessionId);
  res.status(200).end();
});

// Clear Chat — clears messages and turns but keeps MCP connection warm
app.post('/session/clear', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) softResetSession(sessionId);
  res.status(200).end();
});

// ── Admin: user info (returns roles so frontend can show/hide admin UI) ──
app.get('/admin/user-info', (req, res) => {
  const scopes = extractScopes(req);
  res.json({
    isAdmin: scopes.includes('admin'),
    scopes,
  });
});

// ── Admin: log viewer API ──
app.get('/admin/logs', (req, res) => {
  const scopes = extractScopes(req);
  if (!scopes.includes('admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { level, search, limit } = req.query;
  const logs = getLogs({ level: level || undefined, search: search || undefined, limit: limit ? parseInt(limit, 10) : 200 });
  const stats = getStats();
  res.json({ logs, stats });
});

// ── Admin: clear logs ──
app.delete('/admin/logs', (req, res) => {
  const scopes = extractScopes(req);
  if (!scopes.includes('admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  clearLogs();
  res.json({ cleared: true });
});

/**
 * Extracts XSUAA scopes from the JWT in the Authorization header.
 * In production the App Router forwards the JWT; in local dev we skip auth.
 */
function extractScopes(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return [];
  try {
    const payload = JSON.parse(Buffer.from(authHeader.split('.')[1], 'base64').toString());
    return (payload.scope || []).map(s => s.replace(/^[^.]+\./, ''));
  } catch {
    return [];
  }
}

// Chat endpoint
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'message is required' });
  }

  // In production (CF + App Router), the JWT arrives in Authorization header.
  // For local dev without XSUAA, we fall back to the MCP server's own token.
  const authHeader = req.headers['authorization'] || '';
  const userToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : process.env.DEV_TOKEN || '';

  if (!userToken) {
    return res.status(401).json({ error: 'No bearer token provided' });
  }

  try {
    console.log(`[Chat] "${message.substring(0, 80)}..."`);
    const result = await handleChat(message.trim(), sessionId || 'default');
    return res.json({ reply: result.reply, tokenUsage: result.tokenUsage });
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    const detail = err.message || 'Unknown error';
    const status = err.status || err.statusCode || 500;
    return res.status(status >= 400 && status < 600 ? status : 500)
      .json({ error: detail });
  }
});

// Load secrets from Credential Store before accepting traffic
initSecrets()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MCP Client listening on port ${PORT}`);
      console.log(`MCP Server: ${process.env.MCP_SERVER_URL}`);
      console.log(`LLM Model:  ${process.env.LLM_MODEL}`);
    });
  })
  .catch((err) => {
    console.error('[Startup] Failed to load secrets from Credential Store:', err.message);
    process.exit(1);
  });
