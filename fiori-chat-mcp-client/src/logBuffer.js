'use strict';

/**
 * Ring buffer that captures console.log / console.error / console.warn output.
 * Stores the last MAX_ENTRIES log lines with timestamp, level, and message.
 */

const MAX_ENTRIES = 500;
const buffer = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function push(level, args) {
  const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const entry = { ts: new Date().toISOString(), level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

console.log = (...args) => { push('info', args); originalLog.apply(console, args); };
console.error = (...args) => { push('error', args); originalError.apply(console, args); };
console.warn = (...args) => { push('warn', args); originalWarn.apply(console, args); };

/**
 * Returns recent log entries.
 * @param {Object} opts
 * @param {string} [opts.level] - Filter by level (info, warn, error)
 * @param {string} [opts.search] - Filter by substring match
 * @param {number} [opts.limit=200] - Max entries to return
 */
function getLogs({ level, search, limit = 200 } = {}) {
  let result = buffer;
  if (level) result = result.filter(e => e.level === level);
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(e => e.message.toLowerCase().includes(q));
  }
  return result.slice(-limit);
}

function getStats() {
  const counts = { info: 0, warn: 0, error: 0 };
  for (const e of buffer) counts[e.level] = (counts[e.level] || 0) + 1;
  return { total: buffer.length, max: MAX_ENTRIES, ...counts };
}

function clearLogs() {
  buffer.length = 0;
}

module.exports = { getLogs, getStats, clearLogs };
