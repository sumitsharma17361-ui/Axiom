/* ============================================================
   AXIOM FRONTEND v1.1 (Bulletproof Auth)
   ============================================================ */

// ★★★ AAPKA RENDER URL ★★★
const API = 'https://axiom-xh42.onrender.com';

// ============ STATE ============
let token = localStorage.getItem('axiom_token') || null;
let user = JSON.parse(localStorage.getItem('axiom_user') || 'null');
let isRegisterMode = false;
let voiceOutputEnabled = localStorage.getItem('axiom_voice') === '1';
let recognition = null;
let isListening = false;

// ============ DOM ============
const $ = (id) => document.getElementById(id);

// ============ INIT ============
window.addEventListener('DOMContentLoaded', () => {
  if (token && user) enterApp();
  updateVoiceBtn();
});

// ============ AUTH LOGIC ============
function toggleMode() {
  isRegisterMode = !isRegisterMode;
  $('nameGroup').style.display = isRegisterMode ? 'block' : 'none';
  $('primaryBtn').textContent = isRegisterMode ? 'Create Account' : 'Sign In';
  $('secondaryBtn').textContent = isRegisterMode ? 'Have an account? Sign in' : 'New here? Create account';
  $('authError').classList.remove('show');
}

async function submitAuth() {
  const email = $('email').value.trim();
  const password = $('password').value;
  const name = $('name').value.trim();
  
  // Validation
  if (!email || !password) return showAuthError('Email and password required');
  if (password.length < 6) return showAuthError('Password must be 6+ characters');
  if (isRegisterMode && !name) return showAuthError('Please enter your name');

  // API Endpoint set karo mode ke hisaab se
  const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';

  $('primaryBtn').disabled = true;
  $('primaryBtn').textContent = isRegisterMode ? 'Creating…' : 'Signing in…';

  try {
    const res = await fetch(API + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to authenticate');
    
    // Success
    token = data.token;
    user = data.user;
    localStorage.setItem('axiom_token', token);
    localStorage.setItem('axiom_user', JSON.stringify(user));
    enterApp();
    
  } catch (e) {
    showAuthError(e.message);
  } finally {
    $('primaryBtn').disabled = false;
    $('primaryBtn').textContent = isRegisterMode ? 'Create Account' : 'Sign In';
  }
}

function showAuthError(msg) {
  const el = $('authError');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function logout() {
  localStorage.removeItem('axiom_token');
  localStorage.removeItem('axiom_user');
  token = null; user = null;
  location.reload();
}

// ============ ENTER APP ============
function enterApp() {
  $('authScreen').classList.remove('active');
  $('chatScreen').classList.add('active');
  $('welcomeName').textContent = user.name?.split(' ')[0] || 'friend';
  $('menuName').textContent = user.name || 'User';
  $('menuEmail').textContent = user.email || '';
  $('menuAvatar').textContent = (user.name || 'U')[0].toUpperCase();
  loadHistory();
}

// ============ HISTORY ============
async function loadHistory() {
  try {
    const res = await fetch(API + '/api/history', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 401) return logout();
    const msgs = await res.json();
    if (!msgs.length) return;
    $('messages').innerHTML = '';
    msgs.forEach(m => appendMessage(m.role === 'user' ? 'user' : 'bot', m.content));
    scrollBottom();
  } catch (e) { /* ignore */ }
}

async function clearChat() {
  if (!confirm('Clear entire conversation?')) return;
  closeMenu();
  try {
    await fetch(API + '/api/history', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    location.reload();
  } catch (e) { toast('Failed to clear', 'error'); }
}

// ============ SEND MESSAGE ============
async function sendMessage(textOverride) {
  const input = $('input');
  const message = (textOverride || input.value).trim();
  if (!message) return;
  if (!textOverride) { input.value = ''; autosize(input); }

  const welcome = $('messages').querySelector('.welcome');
  if (welcome) welcome.remove();

  appendMessage('user', message);
  scrollBottom();
  const typingEl = showTyping();
  $('sendBtn').disabled = true;

  try {
    const res = await fetch(API + '/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ message })
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    typingEl.remove();
    if (!res.ok) throw new Error(data.error || 'AI failed to respond');
    
    appendMessage('bot', data.reply, data.toolUsed);
    scrollBottom();
    if (voiceOutputEnabled) speak(data.reply);
  } catch (e) {
    typingEl.remove();
    appendMessage('bot', '⚠️ ' + (e.message || 'Something went wrong. Please try again.'));
    scrollBottom();
  } finally {
    $('sendBtn').disabled = false;
  }
}

function quickAsk(q) {
  sendMessage(q);
}

// ============ MESSAGE RENDER ============
function appendMessage(role, text, toolUsed = null) {
  const container = $('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const formatted = role === 'bot' ? formatMarkdown(text) : escapeHtml(text);
  const toolBadge = toolUsed ? `<span style="background:rgba(56, 189, 248, 0.2);color:#38bdf8;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;">🔧 ${toolUsed}</span>` : '';
  div.innerHTML = `
    <div class="bubble">${formatted}</div>
    <div class="meta">${toolBadge} ${time}</div>
  `;
  container.appendChild(div);
}

function showTyping() {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
  $('messages').appendChild(div);
  return div;
}

function formatMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = String(t ?? '');
  return d.innerHTML;
}

function scrollBottom() {
  const m = $('messages');
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

// ============ INPUT HANDLING ============
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ============ VOICE INPUT (STT) ============
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice input not supported in this browser', 'error');

  if (isListening) { stopRecognition(); return; }

  recognition = new SR();
  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isListening = true;
    $('micBtn').classList.add('active');
    $('listeningBar').classList.remove('hidden');
  };

  recognition.onresult = (e) => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    $('input').value = transcript;
    autosize($('input'));
  };

  recognition.onerror = (e) => {
    if (e.error !== 'aborted' && e.error !== 'no-speech') {
      toast('Mic error: ' + e.error, 'error');
    }
    stopRecognition();
  };

  recognition.onend = () => {
    stopRecognition();
    if ($('input').value.trim()) sendMessage();
  };

  try { recognition.start(); } catch (e) { toast('Failed to start mic', 'error'); }
}

function stopRecognition() {
  isListening = false;
  $('micBtn').classList.remove('active');
  $('listeningBar').classList.add('hidden');
  if (recognition) { try { recognition.stop(); } catch(e) {} recognition = null; }
}

// ============ VOICE OUTPUT (TTS) ============
function toggleVoiceOutput() {
  voiceOutputEnabled = !voiceOutputEnabled;
  localStorage.setItem('axiom_voice', voiceOutputEnabled ? '1' : '0');
  updateVoiceBtn();
  toast(voiceOutputEnabled ? 'Voice output ON' : 'Voice output OFF', 'success');
}

function updateVoiceBtn() {
  const b = $('voiceOutBtn');
  if (!b) return;
  b.classList.toggle('active', voiceOutputEnabled);
  b.textContent = voiceOutputEnabled ? '🔊' : '🔇';
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/[*`#]/g, '').replace(/\n+/g, '. ');
  const u = new SpeechSynthesisUtterance(clean.slice(0, 500));
  u.lang = 'en-IN';
  u.rate = 1.05;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

// ============ MENU ============
function openMenu() {
  $('menuDrawer').classList.add('open');
  $('menuBackdrop').classList.add('show');
}
function closeMenu() {
  $('menuDrawer').classList.remove('open');
  $('menuBackdrop').classList.remove('show');
}

// ============ MEMORIES ============
async function showMemories() {
  closeMenu();
  $('memoryModal').classList.add('open');
  $('memoryList').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await fetch(API + '/api/memory', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const mems = await res.json();
    if (!mems.length) {
      $('memoryList').innerHTML = '<div class="empty">No memories yet. Tell AXIOM something about yourself, like "Remember my birthday is 15 August".</div>';
      return;
    }
    $('memoryList').innerHTML = mems.map(m => `
      <div class="memory-item">
        <div>
          <div class="m-key">${escapeHtml(m.key)}</div>
          <div class="m-val">${escapeHtml(m.value)}</div>
        </div>
        <button class="m-del" onclick="deleteMemory('${m._id}')">✕</button>
      </div>
    `).join('');
  } catch (e) {
    $('memoryList').innerHTML = '<div class="empty">Failed to load</div>';
  }
}

async function deleteMemory(id) {
  try {
    await fetch(API + '/api/memory/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    showMemories();
  } catch (e) {}
}

function closeMemories() {
  $('memoryModal').classList.remove('open');
}

// ============ TOAST ============
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}
