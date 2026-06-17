/* ============================================================
   OpenCode Web GUI — Application Logic
   ============================================================ */

class OpenCodeClient {
  constructor(baseURL = 'http://127.0.0.1:7899') {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.password = null;
  }

  async request(path, options = {}) {
    const url = `${this.baseURL}${path}`;
    const headers = { ...options.headers };
    if (this.password) {
      headers['Authorization'] = `Bearer ${this.password}`;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    if (ct.includes('text/event-stream')) return res;
    return res.text();
  }

  get(path, opts) { return this.request(path, { ...opts, method: 'GET' }); }
  post(path, body, opts) { return this.request(path, { ...opts, method: 'POST', body }); }
  put(path, body, opts) { return this.request(path, { ...opts, method: 'PUT', body }); }
  delete(path, opts) { return this.request(path, { ...opts, method: 'DELETE' }); }

  async health() { return this.get('/api/health'); }
  async getConfig() { return this.get('/config'); }
  async getGlobalConfig() { return this.get('/global/config'); }

  async listSessions() { return this.get('/session'); }
  async getSession(id) { return this.get(`/session/${encodeURIComponent(id)}`); }
  async createSession(data = {}) { return this.post('/session', data); }
  async deleteSession(id) { return this.delete(`/session/${encodeURIComponent(id)}`); }

  async getMessages(sessionID) { return this.get(`/session/${encodeURIComponent(sessionID)}/message`); }
  async sendMessage(sessionID, text) {
    return this.post(`/session/${encodeURIComponent(sessionID)}/message`, {
      parts: [{ type: 'text', text }]
    });
  }
  async deleteMessage(sessionID, messageID) {
    return this.delete(`/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`);
  }

  async getSessionTodos(sessionID) {
    return this.get(`/session/${encodeURIComponent(sessionID)}/todo`);
  }
  async getSessionDiff(sessionID) {
    return this.get(`/session/${encodeURIComponent(sessionID)}/diff`);
  }

  async listModels() { return this.get('/api/model'); }
  async listProviders() { return this.get('/api/provider'); }
  async listAgents() { return this.get('/api/agent'); }
  async getServerInfo() { return this.get('/').catch(() => null); }

  async getEvents(sessionID) {
    const url = `${this.baseURL}/event`;
    const headers = {};
    if (this.password) headers['Authorization'] = `Bearer ${this.password}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SSE error: ${res.status}`);
    return res;
  }

  setPassword(pwd) { this.password = pwd; }
}

// --- STATE ---
const state = {
  client: new OpenCodeClient(),
  sessions: [],
  currentSessionID: null,
  messages: [],
  models: [],
  providers: [],
  agents: [],
  config: null,
  sending: false,
  loadingMessages: false,
  currentAgent: null,
  currentModel: null,
  currentModelProvider: '',
  eventSource: null,
  connectionCheckInterval: null,
  wasConnected: false,
  theme: localStorage.getItem('oc-web-theme') || 'light',
  fontZoom: parseInt(localStorage.getItem('oc-web-font-size')) || 16,
  streamingMessageID: null,
  streamingText: '',
  streamingElement: null,
  serverURL: localStorage.getItem('oc-web-server') || 'http://127.0.0.1:7899',
  interval: null,
};

// --- DOM REFS ---
const $ = (id) => document.getElementById(id);
const dom = {};

function cacheDOM() {
  const ids = [
    'loading-screen', 'main-layout', 'sidebar', 'context-panel',
    'welcome-screen', 'chat-screen', 'session-list', 'session-search',
    'message-input', 'send-btn', 'messages-list', 'messages-scroll',
    'typing-indicator', 'chat-title', 'chat-agent', 'model-select',
    'new-session-btn', 'welcome-new-session', 'delete-session-btn',
    'sidebar-toggle', 'close-panel-btn', 'settings-btn', 'theme-toggle',
    'settings-modal', 'connection-dot', 'connection-status',
    'panel-agent', 'panel-todos', 'panel-files', 'session-info',
    'models-list', 'providers-list', 'server-url', 'server-connect-btn',
    'server-status-display', 'server-version', 'font-size-select',
    'toast-container', 'settings-models', 'settings-providers',
    'settings-general', 'settings-server', 'panel-toggle',
    'connection-area', 'reconnect-btn',
    'status-bar', 'status-bar-left', 'status-bar-right',
    'stream-bar',
  ];
  ids.forEach(id => { dom[id] = $(id); });
}

// --- THEME ---
function applyTheme(theme) {
  state.theme = theme;
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.colorScheme = resolved;
  localStorage.setItem('oc-web-theme', theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#1C1C1E' : '#F5F5F7';

  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });
}

function toggleTheme() {
  const themes = ['light', 'dark', 'system'];
  const idx = themes.indexOf(state.theme);
  applyTheme(themes[(idx + 1) % themes.length]);
}

// --- FONT SIZE ---
function applyFontSize(size) {
  state.fontZoom = size;
  document.documentElement.style.fontSize = `${size}px`;
  localStorage.setItem('oc-web-font-size', size);
  if (dom['font-size-select']) dom['font-size-select'].value = size;
}

// --- TOAST ---
function toast(message, type = 'info') {
  const icons = {
    success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <svg class="toast-icon ${type}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[type]}</svg>
    <span>${message}</span>
  `;
  dom['toast-container'].appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    el.style.transition = 'opacity 300ms, transform 300ms';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// --- DATE FORMATTING ---
function parseTS(ts) {
  if (!ts) return null;
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!isNaN(n)) return new Date(n);
  return new Date(ts);
}

function formatTime(ts) {
  if (!ts) return '';
  const d = parseTS(ts);
  if (!d || isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatFullTime(ts) {
  if (!ts) return '';
  const d = parseTS(ts);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// --- RENDER ---
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdown(text) {
  if (!text) return '';

  // Extract and protect code blocks first
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const langClass = lang ? ` class="language-${escapeHTML(lang)}"` : '';
    codeBlocks.push(`<pre><code${langClass}>${escapeHTML(code.trim())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Escape remaining HTML
  html = escapeHTML(html);

  // Restore code blocks
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, n) => codeBlocks[parseInt(n)] || '');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  // Headings
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered lists
  html = html.replace(/^[\s]*[-*+] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(?:\n?))/g, (m) => {
    if (m.includes('<ul>')) return m;
    return '<ul>' + m + '</ul>';
  });
  // Ordered lists
  html = html.replace(/^[\s]*\d+\. (.+)$/gm, '<li>$1</li>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:8px 0">');
  // Paragraphs
  const blocks = html.split(/\n\n+/);
  html = blocks.map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h[1-6]|p|ul|ol|li|pre|blockquote|hr|div|table|img)/i.test(t)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  return html;
}

function getMessageText(msg) {
  if (msg.text) return msg.text;
  if (msg.content) return msg.content;
  if (msg.message) return msg.message;
  if (msg.parts && Array.isArray(msg.parts)) {
    const textParts = msg.parts
      .filter(p => (p.type === 'text' || p.type === 'reasoning') && !p.ignored)
      .map(p => p.text || p.content || '');
    if (textParts.length > 0) return textParts.join('\n');
  }
  // Fallback for info wrapper
  if (msg.info && msg.info.text) return msg.info.text;
  if (msg.info && msg.info.content) return msg.info.content;
  return '';
}

function getMessageRole(msg) {
  if (msg.role) return msg.role;
  if (msg.info && msg.info.role) return msg.info.role;
  if (msg.type === 'user' || msg.type === 'assistant') return msg.type;
  return 'assistant';
}

function getMessageID(msg) {
  return msg.id || msg.messageID || (msg.info && msg.info.id) || '';
}

function getMessageTime(msg) {
  if (msg.createdAt) return msg.createdAt;
  if (msg.timestamp) return msg.timestamp;
  const t = msg.time || (msg.info && msg.info.time);
  if (t) {
    if (typeof t === 'number') return t;
    return t.created || t.completed || (t.start) || null;
  }
  if (msg.info && msg.info.createdAt) return msg.info.createdAt;
  return null;
}

function createMessageElement(msg, role) {
  const isStreaming = msg.streaming;
  const div = document.createElement('div');
  div.className = `message ${role}${isStreaming ? ' streaming' : ''}`;
  div.dataset.messageId = getMessageID(msg);

  const avatar = document.createElement('div');
  avatar.className = `message-avatar ${role}`;
  avatar.textContent = role === 'user' ? 'U' : role === 'assistant' ? 'O' : 'S';

  const body = document.createElement('div');
  body.className = 'message-body';

  const header = document.createElement('div');
  header.className = 'message-header';
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'OpenCode' : 'System';
  header.appendChild(label);

  if (!isStreaming) {
    const time = document.createElement('span');
    time.className = 'message-time';
    const t = getMessageTime(msg.info || msg);
    time.textContent = t ? formatFullTime(t) : '';
    header.appendChild(time);
  }
  body.appendChild(header);

  const content = document.createElement('div');
  content.className = 'message-content';
  const text = getMessageText(msg);
  if (text) {
    content.innerHTML = renderMarkdown(text);
  }
  body.appendChild(content);

  if (!isStreaming) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.appendChild(createCopyButton(content));
    body.appendChild(actions);
  }

  div.appendChild(avatar);
  div.appendChild(body);
  return div;
}

function createCopyButton(contentEl) {
  const copyBtn = document.createElement('button');
  copyBtn.className = 'message-action-btn';
  copyBtn.title = 'Copy';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(contentEl.textContent);
    toast('Copied to clipboard', 'success');
  });
  return copyBtn;
}

function renderMessages(messages) {
  const list = dom['messages-list'];
  list.innerHTML = '';
  if (!messages || messages.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-tertiary);font-size:13px;">No messages yet. Start a conversation!</div>';
    return;
  }
  messages.forEach(msg => {
    const role = getMessageRole(msg);
    if (role === 'system') {
      const el = createMessageElement(msg, 'system');
      list.appendChild(el);
    } else {
      const el = createMessageElement(msg, role);
      list.appendChild(el);
    }
  });
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom['messages-scroll'].scrollTop = dom['messages-scroll'].scrollHeight;
  });
}

function appendMessage(msg, role) {
  const el = createMessageElement(msg, role);
  dom['messages-list'].appendChild(el);
  scrollToBottom();
  return el;
}

function showTyping() { dom['typing-indicator'].classList.remove('hidden'); }
function hideTyping() { dom['typing-indicator'].classList.add('hidden'); }

function getSessionTitle(s) {
  return s.title || s.name || 'Untitled';
}

function getSessionSubtitle(s) {
  const agent = s.agent || '';
  const model = s.model ? (s.model.id || '') : (s.modelID || '');
  return [agent, model].filter(Boolean).join(' · ') || s.slug || (s.id ? s.id.slice(0, 12) : '');
}

function getSessionTime(s) {
  const t = s.updatedAt || s.createdAt || s.timestamp;
  if (t) return t;
  if (s.time) {
    if (typeof s.time === 'number') return s.time;
    return s.time.updated || s.time.created;
  }
  return null;
}

function renderSessions(sessions) {
  const list = dom['session-list'];
  const search = dom['session-search'].value.toLowerCase().trim();
  list.innerHTML = '';

  const filtered = sessions.filter(s => {
    if (!search) return true;
    const title = getSessionTitle(s).toLowerCase();
    return title.includes(search);
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-sessions">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div>${search ? 'No sessions match your search' : 'No sessions yet'}</div>
        ${search ? '' : '<div style="margin-top:8px;font-size:11px;">Create one with <kbd>Cmd+N</kbd></div>'}
      </div>`;
    return;
  }

  filtered.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = s.id;
    if (s.id === state.currentSessionID) item.classList.add('active');

    const indicator = document.createElement('div');
    indicator.className = 'session-item-indicator';
    item.appendChild(indicator);

    const content = document.createElement('div');
    content.className = 'session-item-content';

    const title = document.createElement('div');
    title.className = 'session-item-title';
    title.textContent = getSessionTitle(s);
    content.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'session-item-subtitle';
    subtitle.textContent = getSessionSubtitle(s);
    content.appendChild(subtitle);

    item.appendChild(content);

    const time = document.createElement('div');
    time.className = 'session-item-time';
    time.textContent = formatTime(getSessionTime(s));
    item.appendChild(time);

    item.addEventListener('click', () => selectSession(s.id));
    list.appendChild(item);
  });
}

function renderSessionPanel(session) {
  if (!session) {
    dom['session-info'].innerHTML = '<div class="info-item"><span class="info-label">No session</span></div>';
    dom['panel-agent'].innerHTML = '';
    dom['panel-todos'].innerHTML = '';
    dom['panel-files'].innerHTML = '';
    return;
  }

  const modelStr = session.model ? (session.model.id || '') : (session.modelID || '-');
  const tokens = session.tokens || {};
  const tokenTotal = (tokens.input || 0) + (tokens.output || 0);
  const cost = session.cost || 0;

  dom['session-info'].innerHTML = `
    <div class="info-item"><span class="info-label">ID</span><span class="info-value" style="font-family:var(--font-mono);font-size:10px;">${escapeHTML((session.id || '').slice(0, 16))}</span></div>
    <div class="info-item"><span class="info-label">Created</span><span class="info-value">${formatTime(getSessionTime(session))}</span></div>
    <div class="info-item"><span class="info-label">Messages</span><span class="info-value">${state.messages.length}</span></div>
    <div class="info-item"><span class="info-label">Model</span><span class="info-value">${escapeHTML(modelStr)}</span></div>
    <div class="info-item"><span class="info-label">Tokens</span><span class="info-value">${tokenTotal.toLocaleString()}</span></div>
    ${cost ? `<div class="info-item"><span class="info-label">Cost</span><span class="info-value">$${cost.toFixed(4)}</span></div>` : ''}
  `;

  const agent = session.agent || state.currentAgent || 'build';
  dom['panel-agent'].innerHTML = `
    <div class="info-item"><span class="info-label">Agent</span><span class="info-value" style="text-transform:capitalize">${escapeHTML(agent)}</span></div>
  `;

  loadSessionTodos(session.id);
  loadSessionFiles(session.id);
}

function renderModels(models) {
  const grid = dom['models-list'] || dom['models-list'];
  if (!grid) return;
  grid.innerHTML = models.map(m => `
    <div class="model-card">
      <div>
        <div>${escapeHTML(m.id || m.name || m.model || '')}</div>
        <div class="model-card-provider">${escapeHTML(m.provider || m.providerID || '')}</div>
      </div>
    </div>
  `).join('');
}

function renderProviders(providers) {
  const list = dom['providers-list'];
  if (!list) return;
  list.innerHTML = (providers && providers.length > 0 ? providers : []).map(p => {
    return `
      <div class="provider-item">
        <div>
          <div class="provider-name">${escapeHTML(p.id || p.name || p.providerID || p.provider || '')}</div>
        </div>
        <span class="provider-status configured">
          Available
        </span>
      </div>
    `;
  }).join('') || '<div style="font-size:12px;color:var(--text-tertiary);padding:8px 0;">No providers found</div>';
}

// --- STATUS BAR ---
function updateStatusBar(session) {
  const bar = dom['status-bar'];
  const left = dom['status-bar-left'];
  const right = dom['status-bar-right'];
  if (!session) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const title = getSessionTitle(session);
  left.innerHTML = `<span class="session-badge" title="${escapeHTML(title)}">${escapeHTML(title)}</span>`;
  const modelLabel = session.model && session.model.id ? session.model.id : '';
  const providerLabel = session.model && session.model.providerID ? session.model.providerID : '';
  const parts = [];
  if (modelLabel) parts.push(`<span class="model-badge">${escapeHTML(modelLabel)}</span>`);
  if (providerLabel) parts.push(`<span>via ${escapeHTML(providerLabel)}</span>`);
  if (state.messages.length > 0) parts.push(`<span>${state.messages.length} messages</span>`);
  right.innerHTML = parts.join('');
}

// --- SESSION SELECTION ---
async function selectSession(id) {
  if (!id || id === state.currentSessionID) return;
  state.currentSessionID = id;
  state.messages = [];

  dom['welcome-screen'].classList.add('hidden');
  dom['chat-screen'].classList.remove('hidden');

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', false);
  });

  dom['chat-title'].textContent = 'Loading...';
  hideTyping();
  dom['messages-list'].innerHTML = '';

  try {
    const session = await state.client.getSession(id);
    dom['chat-title'].textContent = getSessionTitle(session);
    const agentName = session.agent || '';
    state.currentAgent = agentName;
    if (agentName) {
      dom['chat-agent'].textContent = agentName;
      dom['chat-agent'].classList.remove('hidden');
    } else {
      dom['chat-agent'].classList.add('hidden');
    }

    renderSessionPanel(session);
    renderSessions(state.sessions);

    // Sync model selector with session's model
    if (session.model && session.model.id && dom['model-select']) {
      const select = dom['model-select'];
      const modelId = session.model.id;
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === modelId) {
          select.selectedIndex = i;
          state.currentModel = modelId;
          state.currentModelProvider = session.model.providerID || select.options[i].dataset.provider || '';
          break;
        }
      }
    }

    state.loadingMessages = true;
    const messages = await state.client.getMessages(id) || [];
    state.messages = Array.isArray(messages) ? messages : [];
    renderMessages(state.messages);
    state.loadingMessages = false;

    updateStatusBar(session);
    subscribeToSessionEvents();
    dom['message-input'].focus();
  } catch (err) {
    console.error('Failed to load session:', err);
    toast('Failed to load session', 'error');
    state.loadingMessages = false;
  }
}

async function loadSessionTodos(sessionID) {
  try {
    const todos = await state.client.getSessionTodos(sessionID);
    const list = dom['panel-todos'];
    if (!todos || !Array.isArray(todos) || todos.length === 0) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);padding:4px 0;">No todos</div>';
      return;
    }
    list.innerHTML = todos.map(t => {
      const done = t.done || t.status === 'completed' || t.status === 'done';
      return `
      <div class="todo-item ${done ? 'done' : ''}">
        <div class="todo-checkbox"></div>
        <div class="todo-text">${escapeHTML(t.text || t.content || t.description || '')}</div>
      </div>`;
    }).join('');
  } catch (e) {
    dom['panel-todos'].innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">Unable to load todos</div>';
  }
}

async function loadSessionFiles(sessionID) {
  try {
    const diff = await state.client.getSessionDiff(sessionID);
    const list = dom['panel-files'];
    if (!diff || (typeof diff === 'object' && Object.keys(diff).length === 0)) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);padding:4px 0;">No changes</div>';
      return;
    }
    const files = Array.isArray(diff) ? diff : (diff.files || []);
    if (files.length === 0) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);padding:4px 0;">No changes</div>';
      return;
    }
    list.innerHTML = files.map(f => {
      const path = f.path || f.file || f.name || '';
      const status = f.status || f.type || 'modified';
      return `
        <div class="file-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          <span>${escapeHTML(path.split('/').pop())}</span>
          <span class="file-status">${escapeHTML(status)}</span>
        </div>
      `;
    }).join('');
  } catch (e) {
    dom['panel-files'].innerHTML = '<div style="font-size:11px;color:var(--text-tertiary);">Unable to load changes</div>';
  }
}

// --- SSE EVENTS ---
function subscribeToSessionEvents() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  try {
    const es = new EventSource(`${state.client.baseURL}/event`);
    state.eventSource = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleSSEEvent(data);
      } catch (err) {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE connection lost - will reconnect automatically
    };
  } catch (err) {
    // SSE not available, will fall back to polling
  }
}

function handleSSEEvent(data) {
  const type = data.type;
  const props = data.properties || {};

  switch (type) {
    case 'message.updated': {
      const info = props.info || {};
      if (info.role === 'user') {
        // Replace temp user message with real one
        const tempEl = dom['messages-list'].querySelector('.message.user[data-message-id^="temp-"]');
        if (tempEl) {
          tempEl.dataset.messageId = info.id;
          tempEl.querySelector('.message-time').textContent = formatFullTime(info.time?.created || Date.now());
        }
      }
      if (info.role === 'assistant') {
        if (!state.streamingMessageID || state.streamingMessageID !== info.id) {
          state.streamingMessageID = info.id;
          state.streamingText = '';
          const msgEl = appendMessage({
            id: info.id,
            text: '',
            streaming: true
          }, 'assistant');
          if (msgEl) {
            state.streamingElement = msgEl.querySelector('.message-content');
          }
          hideTyping();
          dom['stream-bar'].classList.remove('hidden');
        }
      }
      break;
    }
    case 'message.part.updated': {
      const part = props.part || {};
      if (part.type === 'text' && state.streamingElement) {
        const newText = part.text || '';
        if (newText.length > (state.streamingText || '').length) {
          state.streamingText = newText;
          state.streamingElement.innerHTML = renderMarkdown(newText);
          scrollToBottom();
        }
      }
      break;
    }
    case 'session.status': {
      const status = props.status || {};
      if (status.type === 'idle' && state.streamingMessageID) {
        finalizeStream();
      }
      break;
    }
    case 'session.idle': {
      if (state.streamingMessageID) {
        finalizeStream();
      }
      break;
    }
    case 'session.error': {
      const error = props.error || {};
      if (state.streamingElement && state.streamingText) {
        state.streamingElement.innerHTML = renderMarkdown(state.streamingText);
      }
      if (state.streamingMessageID) {
        finalizeStream();
      }
      if (error.data && error.data.message) {
        toast(`Error: ${error.data.message}`, 'error');
      }
      break;
    }
  }
}

function finalizeStream() {
  dom['stream-bar'].classList.add('hidden');
  if (state.streamingMessageID && state.streamingText) {
    state.messages.push({
      id: state.streamingMessageID,
      text: state.streamingText,
      role: 'assistant'
    });
    // Add copy button and timestamp to the completed streaming element
    if (state.streamingElement) {
      const msgBody = state.streamingElement.closest('.message-body');
      if (msgBody) {
        // Add timestamp to header
        const header = msgBody.querySelector('.message-header');
        if (header && !header.querySelector('.message-time')) {
          const time = document.createElement('span');
          time.className = 'message-time';
          time.textContent = formatFullTime(Date.now());
          header.appendChild(time);
        }
        // Add copy button
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.appendChild(createCopyButton(state.streamingElement));
        msgBody.appendChild(actions);
      }
      const msgDiv = state.streamingElement.closest('.message');
      if (msgDiv) msgDiv.classList.remove('streaming');
    }
  }
  state.streamingMessageID = null;
  state.streamingText = '';
  state.streamingElement = null;
  state.sending = false;
  dom['send-btn'].disabled = false;
  dom['send-btn'].classList.remove('sending');
  dom['message-input'].focus();

  // Refresh session info
  if (state.currentSessionID) {
    state.client.getSession(state.currentSessionID).then(session => {
      dom['chat-title'].textContent = getSessionTitle(session);
      renderSessionPanel(session);
      updateStatusBar(session);
    }).catch(() => {});
  }
}

// --- SEND MESSAGE ---
async function sendMessage() {
  const input = dom['message-input'];
  const text = input.value.trim();
  if (!text || !state.currentSessionID || state.sending) return;

  state.sending = true;
  dom['send-btn'].disabled = true;
  dom['send-btn'].classList.add('sending');
  const inputText = input.value;
  input.value = '';
  input.style.height = 'auto';

  appendMessage({ text: inputText, id: `temp-${Date.now()}`, createdAt: new Date().toISOString() }, 'user');
  showTyping();
  scrollToBottom();

  try {
    await state.client.sendMessage(state.currentSessionID, inputText);
  } catch (err) {
    console.error('Send error:', err);
    hideTyping();
    // Try to reload what we have
    try {
      const messages = await state.client.getMessages(state.currentSessionID) || [];
      state.messages = Array.isArray(messages) ? messages : [];
      if (state.messages.length > 0) renderMessages(state.messages);
    } catch (e2) { /* ignore */ }
    toast(`Error: ${err.message}`, 'error');
    state.sending = false;
    dom['send-btn'].disabled = false;
    dom['send-btn'].classList.remove('sending');
    dom['message-input'].focus();
  }
}

// --- SESSION MANAGEMENT ---
async function loadSessions() {
  try {
    const sessions = await state.client.listSessions();
    state.sessions = Array.isArray(sessions) ? sessions : [];
    renderSessions(state.sessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

async function createNewSession() {
  try {
    const data = {};
    if (state.currentAgent) data.agent = state.currentAgent;
    if (state.currentModel) data.model = { id: state.currentModel, providerID: state.currentModelProvider };

    const session = await state.client.createSession(data);
    const id = session.id || session.sessionID || '';
    if (id) {
      await loadSessions();
      await selectSession(id);
      toast('New session created', 'success');
    }
  } catch (err) {
    console.error('Failed to create session:', err);
    toast('Failed to create session', 'error');
  }
}

async function deleteCurrentSession() {
  if (!state.currentSessionID) return;
  if (!confirm('Delete this session? This cannot be undone.')) return;

  try {
    await state.client.deleteSession(state.currentSessionID);
    state.currentSessionID = null;
    state.messages = [];
    dom['chat-screen'].classList.add('hidden');
    dom['welcome-screen'].classList.remove('hidden');
    dom['status-bar'].classList.add('hidden');
    dom['stream-bar'].classList.add('hidden');
    await loadSessions();
    toast('Session deleted', 'success');
  } catch (err) {
    toast('Failed to delete session', 'error');
  }
}

// --- CONNECTION ---
async function checkConnection() {
  const dot = dom['connection-dot'];
  const status = dom['connection-status'];
  try {
    dot.className = 'connection-dot connecting';
    status.textContent = 'Connecting...';

    const health = await state.client.health();
    if (health && health.healthy) {
      dot.className = 'connection-dot connected';
      status.textContent = 'Connected';
      if (dom['reconnect-btn']) dom['reconnect-btn'].classList.add('hidden');
      return true;
    }
    throw new Error('Unhealthy');
  } catch (err) {
    dot.className = 'connection-dot';
    status.textContent = 'Disconnected';
    if (dom['reconnect-btn']) dom['reconnect-btn'].classList.remove('hidden');
    if (state.wasConnected) {
      toast('Connection to server lost', 'error');
    }
    state.wasConnected = false;
    return false;
  }
}

async function connectToServer() {
  const url = dom['server-url'].value.trim();
  if (!url) return;

  state.client = new OpenCodeClient(url);
  state.serverURL = url;
  localStorage.setItem('oc-web-server', url);

  const connected = await checkConnection();
  if (!connected) {
    dom['server-status-display'].className = 'server-status disconnected';
    dom['server-status-display'].textContent = 'Disconnected';
    throw new Error('Connection failed');
  }

  dom['server-status-display'].className = 'server-status connected';
  dom['server-status-display'].textContent = 'Connected';
  state.wasConnected = true;
  toast('Connected to server', 'success');

  await initializeApp();

  dom['loading-screen'].classList.add('fade-out');
  setTimeout(() => {
    dom['loading-screen'].classList.add('hidden');
    dom['main-layout'].classList.remove('hidden');
  }, 400);

  if (state.interval) clearInterval(state.interval);
  state.interval = setInterval(checkConnection, 15000);
}

async function initializeApp() {
  try {
    const modelsResp = await state.client.listModels() || {};
    state.models = modelsResp && modelsResp.data ? modelsResp.data : (Array.isArray(modelsResp) ? modelsResp : []);

    const provResp = await state.client.listProviders() || {};
    state.providers = provResp && provResp.data ? provResp.data : (Array.isArray(provResp) ? provResp : []);

    const agentResp = await state.client.listAgents() || {};
    state.agents = agentResp && agentResp.data ? agentResp.data : (Array.isArray(agentResp) ? agentResp : []);

    state.config = await state.client.getConfig().catch(() => null);

    renderModels(state.models);
    renderProviders(state.providers);

    const select = dom['model-select'];
    select.innerHTML = '';
    if (state.models.length > 0) {
      state.models.forEach(m => {
        const opt = document.createElement('option');
        const val = m.id || m.name || m.model || m.modelID || '';
        opt.value = val;
        opt.dataset.provider = m.providerID || '';
        opt.textContent = val + (m.providerID ? ' (' + m.providerID + ')' : '');
        select.appendChild(opt);
      });
      const first = state.models[0];
      select.value = first.id || first.name || '';
      state.currentModel = select.value;
      state.currentModelProvider = first.providerID || '';
    } else {
      const opt = document.createElement('option');
      opt.value = 'default';
      opt.textContent = 'Default';
      select.appendChild(opt);
      state.currentModel = 'default';
      state.currentModelProvider = '';
    }
  } catch (e) {
    console.warn('Failed to load config:', e);
  }

  await loadSessions();

  try {
    const gcfg = await state.client.getGlobalConfig();
    dom['server-version'].textContent = gcfg?.version || gcfg?.appVersion || '1.17.7';
  } catch (e) {
    dom['server-version'].textContent = '1.17.7';
  }
}

// --- MODAL ---
function openSettings() {
  dom['settings-modal'].classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeSettings() {
  dom['settings-modal'].classList.add('hidden');
  document.body.style.overflow = '';
}

// --- TEXTAREA AUTO-RESIZE ---
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// --- INIT ---
function init() {
  cacheDOM();

  // Apply saved theme
  applyTheme(state.theme);

  // Apply saved font size
  applyFontSize(state.fontZoom);

  // Set server URL
  dom['server-url'].value = state.serverURL;

  // --- EVENT LISTENERS ---

  // Send message
  dom['send-btn'].addEventListener('click', sendMessage);

  // Textarea
  dom['message-input'].addEventListener('input', () => autoResize(dom['message-input']));
  dom['message-input'].addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // New session
  dom['new-session-btn'].addEventListener('click', createNewSession);
  dom['welcome-new-session'].addEventListener('click', createNewSession);

  // Delete session
  dom['delete-session-btn'].addEventListener('click', deleteCurrentSession);

  // Sidebar toggle
  dom['sidebar-toggle'].addEventListener('click', () => {
    dom['sidebar'].classList.toggle('collapsed');
    dom['sidebar-toggle'].classList.toggle('active');
  });

  // Context panel toggle
  const togglePanel = () => {
    dom['context-panel'].classList.toggle('collapsed');
  };
  dom['close-panel-btn'].addEventListener('click', togglePanel);
  dom['panel-toggle'] && dom['panel-toggle'].addEventListener('click', togglePanel);

  // Settings
  dom['settings-btn'].addEventListener('click', openSettings);
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', closeSettings);
  });
  dom['settings-modal'].addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeSettings();
  });

  // Theme toggle
  dom['theme-toggle'].addEventListener('click', toggleTheme);

  // Theme selection in settings
  document.querySelectorAll('.theme-option').forEach(el => {
    el.addEventListener('click', () => applyTheme(el.dataset.theme));
  });

  // Settings tabs
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(`settings-${tab.dataset.tab}`);
      if (panel) panel.classList.add('active');
    });
  });

  // Font size
  dom['font-size-select'].addEventListener('change', (e) => {
    applyFontSize(parseInt(e.target.value));
  });

  // Server connect
  dom['server-connect-btn'].addEventListener('click', connectToServer);
  dom['server-url'].addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectToServer();
  });

  // Model selection
  dom['model-select'].addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions && e.target.selectedOptions[0];
    state.currentModel = e.target.value;
    state.currentModelProvider = opt ? (opt.dataset.provider || '') : '';
    if (state.currentSessionID) {
      try {
        await state.client.post(`/session/${encodeURIComponent(state.currentSessionID)}`, {
          model: { id: state.currentModel, providerID: state.currentModelProvider }
        });
        toast('Model updated', 'success');
      } catch (err) {
        console.warn('Could not update model:', err);
      }
    }
  });

  // Connection area - click to reconnect
  dom['connection-area'].addEventListener('click', () => {
    dom['reconnect-btn'].classList.add('hidden');
    connectToServer().catch(() => {
      dom['reconnect-btn'].classList.remove('hidden');
    });
  });
  dom['reconnect-btn'].addEventListener('click', (e) => {
    e.stopPropagation();
    dom['reconnect-btn'].classList.add('hidden');
    connectToServer().catch(() => {
      dom['reconnect-btn'].classList.remove('hidden');
    });
  });

  // Session search
  dom['session-search'].addEventListener('input', () => renderSessions(state.sessions));

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + K: focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      dom['session-search'].focus();
    }
    // Cmd/Ctrl + N: new session
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      createNewSession();
    }
    // Cmd/Ctrl + , : settings
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      if (dom['settings-modal'].classList.contains('hidden')) openSettings();
      else closeSettings();
    }
    // Escape: close settings
    if (e.key === 'Escape' && !dom['settings-modal'].classList.contains('hidden')) {
      closeSettings();
    }
  });

  // Detect system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme('system');
  });

  // Attempt connection with retry
  async function tryConnect(attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        await connectToServer();
        return;
      } catch (e) {
        if (i < attempts - 1) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    dom['loading-screen'].classList.add('fade-out');
    setTimeout(() => {
      dom['loading-screen'].classList.add('hidden');
      dom['main-layout'].classList.remove('hidden');
      dom['server-status-display'].className = 'server-status disconnected';
      dom['server-status-display'].textContent = 'Disconnected';
    }, 400);
  }
  setTimeout(() => tryConnect(), 500);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
