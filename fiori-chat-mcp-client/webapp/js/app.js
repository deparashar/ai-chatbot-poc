import { addMessage, addThinking, showWelcome, clearChat, updateTurnInfo, initScrollButton } from './components.js';
import { sendMessage, resetSession, clearChatSession, getState } from './chat.js';
import { initLogsTab, destroyLogsTab } from './logs.js';

const inputEl   = document.getElementById('input');
const sendBtn   = document.getElementById('send');
const newChatBtn = document.getElementById('new-chat-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const themeBtn  = document.getElementById('theme-toggle');

/* ── Theme toggle ── */
function initTheme() {
  const saved = localStorage.getItem('theme') || 'auto';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const icons = { light: '\u2600', dark: '\u263E', auto: '\u25D0' };
  themeBtn.textContent = icons[theme] || icons.auto;
  themeBtn.title = `Theme: ${theme}`;
}

/* ── Send handler ── */
async function handleSend() {
  const text = inputEl.value.trim();
  if (!text || sendBtn.disabled) return;

  const { turnCount, MAX_TURNS } = getState();
  if (turnCount >= MAX_TURNS) {
    addMessage('bot', `You've reached the limit of ${MAX_TURNS} messages. Start a new chat to continue.`, { isError: true });
    return;
  }

  inputEl.value = '';
  inputEl.style.height = '44px';
  sendBtn.disabled = true;
  inputEl.disabled = true;

  addMessage('user', text);
  // turnCount incremented inside sendMessage, but we need to update UI after
  const thinkingEl = addThinking();

  try {
    const { reply, elapsed } = await sendMessage(text);
    thinkingEl.remove();
    addMessage('bot', reply, { elapsed });
  } catch (err) {
    thinkingEl.remove();
    addMessage('bot', err.message, { isError: true });
  } finally {
    const state = getState();
    updateTurnInfo(state.turnCount, state.MAX_TURNS, state.tokenUsage);
    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

/* ── New chat ── */
async function handleNewChat() {
  await resetSession();
  updateTurnInfo(0, getState().MAX_TURNS);
  clearChat(handleStarterClick);
  inputEl.focus();
}

/* ── Clear chat (keep session warm) ── */
async function handleClearChat() {
  await clearChatSession();
  updateTurnInfo(0, getState().MAX_TURNS);
  clearChat(handleStarterClick);
  inputEl.focus();
}

/* ── Starter chip click ── */
function handleStarterClick(text) {
  inputEl.value = text;
  inputEl.dispatchEvent(new Event('input'));
  handleSend();
}

/* ── Event listeners ── */
sendBtn.addEventListener('click', handleSend);
newChatBtn.addEventListener('click', handleNewChat);
clearChatBtn.addEventListener('click', handleClearChat);
themeBtn.addEventListener('click', toggleTheme);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

inputEl.addEventListener('input', function () {
  this.style.height = '44px';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

/* ── Tab switching ── */
let activeTab = 'chat';
let logsInitialized = false;

function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  if (tab === 'chat') {
    document.getElementById('chat-panel').classList.add('active');
    destroyLogsTab();
  } else if (tab === 'logs') {
    document.getElementById('logs-panel').classList.add('active');
    if (!logsInitialized) { initLogsTab(); logsInitialized = true; }
    else initLogsTab();
  }
}

document.getElementById('tab-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (btn) switchTab(btn.dataset.tab);
});

/* ── Admin role check — show Logs tab if user has admin scope ── */
async function checkAdmin() {
  try {
    const res = await fetch('/admin/user-info');
    if (!res.ok) return;
    const { isAdmin } = await res.json();
    if (isAdmin) {
      document.getElementById('logs-tab-btn').style.display = '';
    }
  } catch { /* not admin or not behind App Router */ }
}

/* ── Init ── */
initTheme();
initScrollButton();
showWelcome(handleStarterClick);
checkAdmin();
