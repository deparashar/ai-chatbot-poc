import { renderMarkdown } from './markdown.js';

const chatEl = document.getElementById('chat');

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Adds a chat message bubble to the chat area.
 * Returns the bubble element (useful for updating content later).
 */
export function addMessage(role, content, { isError = false, elapsed = null } = {}) {
  // Hide welcome screen on first message
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + role + (isError ? ' error' : '');

  const bubble = document.createElement('div');
  bubble.className = 'msg';

  if (role === 'bot' && !isError) {
    bubble.innerHTML = renderMarkdown(content);
    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });
    bubble.appendChild(copyBtn);
  } else {
    bubble.textContent = content;
  }

  // Metadata row: timestamp + elapsed time
  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const ts = document.createElement('span');
  ts.className = 'timestamp';
  ts.textContent = now();
  meta.appendChild(ts);

  if (elapsed !== null) {
    const el = document.createElement('span');
    el.className = 'elapsed';
    el.textContent = `(${elapsed}s)`;
    meta.appendChild(el);
  }

  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

/**
 * Adds the animated "thinking" dots indicator.
 * Returns the wrapper element so it can be removed when the response arrives.
 */
export function addThinking() {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap bot';
  const bubble = document.createElement('div');
  bubble.className = 'msg thinking-dots';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  bubble.setAttribute('aria-label', 'Thinking');
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return wrap;
}

/**
 * Shows the welcome screen with starter prompts.
 * @param {Function} onStarterClick — called with the chip text when a starter is clicked
 */
export function showWelcome(onStarterClick) {
  const existing = document.getElementById('welcome');
  if (existing) { existing.style.display = 'flex'; return; }

  const starters = [
    'What services are available?',
    'Show me 5 travel bookings',
    'List customers',
    'What entities does ZUI_RAP_TRAVEL have?',
  ];

  const welcome = document.createElement('div');
  welcome.id = 'welcome';

  welcome.innerHTML = `
    <div class="welcome-icon">S</div>
    <h2>SAP AI Assistant</h2>
    <p>Ask questions about your SAP data. I can discover services, explore entity schemas, and fetch live records from your BTP system.</p>
    <div id="starters">
      ${starters.map(s => `<button class="starter-chip">${s}</button>`).join('')}
    </div>
  `;

  // Wire starter chips
  welcome.querySelectorAll('.starter-chip').forEach(chip => {
    chip.addEventListener('click', () => onStarterClick(chip.textContent));
  });

  chatEl.appendChild(welcome);
}

/**
 * Clears all messages and shows the welcome screen.
 */
export function clearChat(onStarterClick) {
  chatEl.innerHTML = '';
  showWelcome(onStarterClick);
}

/**
 * Updates the turn counter display.
 */
export function updateTurnInfo(turnCount, maxTurns, tokenUsage) {
  const el = document.getElementById('turn-info');
  const remaining = maxTurns - turnCount;
  if (turnCount === 0) {
    el.textContent = '';
    el.className = '';
    return;
  }
  const tokens = tokenUsage && tokenUsage.total > 0
    ? ` · ${tokenUsage.total.toLocaleString()} tokens used`
    : '';
  el.textContent = `${remaining} message${remaining !== 1 ? 's' : ''} remaining${tokens}`;
  el.className = remaining <= 3 ? 'warn' : '';
}

/**
 * Sets up the scroll-to-bottom floating button.
 */
export function initScrollButton() {
  const btn = document.getElementById('scroll-bottom');
  chatEl.addEventListener('scroll', () => {
    const distFromBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
    btn.classList.toggle('visible', distFromBottom > 200);
  });
  btn.addEventListener('click', () => {
    chatEl.scrollTop = chatEl.scrollHeight;
  });
}
