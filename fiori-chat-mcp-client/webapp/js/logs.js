/**
 * Admin log viewer — fetches and displays app logs in a readable table.
 */

let autoRefreshTimer = null;
let currentLevel = '';
let currentSearch = '';

const LEVEL_COLORS = {
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444',
};

export function initLogsTab() {
  const container = document.getElementById('logs-panel');
  container.innerHTML = `
    <div class="logs-toolbar">
      <div class="logs-filters">
        <select id="log-level-filter">
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <input id="log-search" type="text" placeholder="Search logs..." />
      </div>
      <div class="logs-actions">
        <span id="log-stats" class="log-stats"></span>
        <label class="auto-refresh-label">
          <input id="log-auto-refresh" type="checkbox" checked /> Auto-refresh
        </label>
        <button id="log-refresh-btn" class="header-btn">Refresh</button>
        <button id="log-clear-btn" class="header-btn header-btn-danger">Clear</button>
      </div>
    </div>
    <div id="logs-table-wrap">
      <table id="logs-table">
        <thead>
          <tr>
            <th class="col-ts">Timestamp</th>
            <th class="col-level">Level</th>
            <th class="col-msg">Message</th>
          </tr>
        </thead>
        <tbody id="logs-body"></tbody>
      </table>
    </div>
  `;

  document.getElementById('log-refresh-btn').addEventListener('click', fetchLogs);
  document.getElementById('log-clear-btn').addEventListener('click', clearAllLogs);
  document.getElementById('log-level-filter').addEventListener('change', (e) => {
    currentLevel = e.target.value;
    fetchLogs();
  });

  let searchTimeout;
  document.getElementById('log-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = e.target.value;
      fetchLogs();
    }, 300);
  });

  document.getElementById('log-auto-refresh').addEventListener('change', (e) => {
    if (e.target.checked) startAutoRefresh();
    else stopAutoRefresh();
  });

  fetchLogs();
  startAutoRefresh();
}

export function destroyLogsTab() {
  stopAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(fetchLogs, 5000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

async function fetchLogs() {
  try {
    const params = new URLSearchParams();
    if (currentLevel) params.set('level', currentLevel);
    if (currentSearch) params.set('search', currentSearch);
    params.set('limit', '300');

    const res = await fetch(`/admin/logs?${params}`);
    if (res.status === 403) {
      renderError('Access denied — admin role required.');
      return;
    }
    if (!res.ok) {
      renderError(`Failed to fetch logs: ${res.status}`);
      return;
    }

    const { logs, stats } = await res.json();
    renderLogs(logs);
    renderStats(stats);
  } catch (err) {
    renderError(`Network error: ${err.message}`);
  }
}

async function clearAllLogs() {
  if (!confirm('Clear all log entries?')) return;
  try {
    const res = await fetch('/admin/logs', { method: 'DELETE' });
    if (res.ok) fetchLogs();
  } catch (err) {
    renderError(`Failed to clear logs: ${err.message}`);
  }
}

function renderLogs(logs) {
  const tbody = document.getElementById('logs-body');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="logs-empty">No log entries found</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(entry => {
    const ts = formatTimestamp(entry.ts);
    const levelColor = LEVEL_COLORS[entry.level] || 'inherit';
    const msg = formatMessage(entry.message);
    const levelClass = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : '';
    return `<tr class="${levelClass}">
      <td class="col-ts">${ts}</td>
      <td class="col-level"><span class="log-badge" style="background:${levelColor}">${entry.level.toUpperCase()}</span></td>
      <td class="col-msg">${msg}</td>
    </tr>`;
  }).join('');

  // Auto-scroll to bottom
  const wrap = document.getElementById('logs-table-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

function renderStats(stats) {
  const el = document.getElementById('log-stats');
  const errStyle = stats.error > 0 ? `color:${LEVEL_COLORS.error};font-weight:600` : `color:${LEVEL_COLORS.error}`;
  const warnStyle = stats.warn > 0 ? `color:${LEVEL_COLORS.warn};font-weight:600` : `color:${LEVEL_COLORS.warn}`;
  el.innerHTML = `${stats.total}/${stats.max} &nbsp;<span style="${errStyle}">${stats.error} err</span> &middot; <span style="${warnStyle}">${stats.warn} warn</span>`;
}

function renderError(msg) {
  const tbody = document.getElementById('logs-body');
  tbody.innerHTML = `<tr><td colspan="3" class="logs-empty logs-error-msg">${escapeHtml(msg)}</td></tr>`;
}

/**
 * Format a log message for display:
 * - Escape HTML
 * - Shorten long URLs
 * - Highlight JSON objects inline
 * - Highlight key patterns like [MCP], [Chat], [Catalog], [LLM]
 */
function formatMessage(raw) {
  let msg = escapeHtml(raw);

  // Shorten long URLs — show just the path portion
  msg = msg.replace(/(https?:\/\/[^\s,&;]+)/g, (url) => {
    if (url.length < 60) return `<span class="log-url">${url}</span>`;
    try {
      const u = new URL(url.replace(/&amp;/g, '&'));
      const short = u.hostname.split('.')[0] + u.pathname;
      return `<span class="log-url" title="${url}">${short.length > 50 ? short.substring(0, 47) + '...' : short}</span>`;
    } catch { return `<span class="log-url">${url}</span>`; }
  });

  // Highlight bracketed tags like [MCP], [Chat], [Catalog], [LLM], [Auto-chain]
  msg = msg.replace(/\[([A-Za-z-]+)\]/g, '<span class="log-tag">[$1]</span>');

  // Highlight JSON-like objects {...} — collapse if very long
  msg = msg.replace(/(\{[^}]{2,}\})/g, (match) => {
    if (match.length > 120) {
      const preview = match.substring(0, 80) + '...}';
      return `<span class="log-json" title="${match}">${preview}</span>`;
    }
    return `<span class="log-json">${match}</span>`;
  });

  // Highlight quoted strings that look like serviceIds or tool names
  msg = msg.replace(/&quot;([A-Z_][A-Z0-9_]+(?:_\d+)?)&quot;/g, '<span class="log-id">"$1"</span>');

  // Highlight numeric values like response_time: 55.01s, status codes
  msg = msg.replace(/(\d+\.\d+s\b)/g, '<strong>$1</strong>');

  return msg;
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
  return `<span class="log-date">${date}</span> ${time}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
