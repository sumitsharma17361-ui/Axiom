const API = 'https://axiom-xh42.onrender.com';

let token = localStorage.getItem('axiom_token') || null;
let user = JSON.parse(localStorage.getItem('axiom_user') || 'null');
let isRegisterMode = false;

// Current State
let currentProvider = 'groq';
let pendingFile = null;

const $ = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', () => {
  if (token && user) enterApp();
  else $('authScreen').classList.add('active');
});

// AUTH
function toggleMode() {
  isRegisterMode = !isRegisterMode;
  $('nameGroup').style.display = isRegisterMode ? 'block' : 'none';
  $('primaryBtn').textContent = isRegisterMode ? 'Create Account' : 'Sign In';
  $('secondaryBtn').textContent = isRegisterMode ? 'Have an account? Sign in' : 'New here? Create account';
}

async function submitAuth() {
  const email = $('email').value.trim();
  const password = $('password').value;
  const name = $('name').value.trim();
  if (!email || !password) return showAuthError('Fill all fields');
  
  const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
  try {
    const res = await fetch(API + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    token = data.token; user = data.user;
    localStorage.setItem('axiom_token', token);
    localStorage.setItem('axiom_user', JSON.stringify(user));
    enterApp();
  } catch (e) { showAuthError(e.message); }
}

function showAuthError(msg) {
  $('authError').textContent = msg;
  $('authError').classList.add('show');
  setTimeout(() => $('authError').classList.remove('show'), 3000);
}

function logout() {
  localStorage.clear();
  location.reload();
}

// APP ENTRY
function enterApp() {
  $('authScreen').classList.remove('active');
  $('chatScreen').classList.add('active');
  loadHistory();
}

// PROVIDER TOGGLE
function setProvider(provider) {
  currentProvider = provider;
  if (provider === 'groq') {
    $('toggleGroq').classList.add('active');
    $('toggleGemini').classList.remove('active');
  } else {
    $('toggleGemini').classList.add('active');
    $('toggleGroq').classList.remove('active');
  }
}

// FILE HANDLING
function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  if (file.size > 15 * 1024 * 1024) {
    return toast('File too large. Max 15MB.', 'error');
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    const base64Data = ev.target.result.split(',')[1];
    pendingFile = {
      base64: base64Data,
      mimeType: file.type || 'application/octet-stream',
      name: file.name
    };
    $('fileName').textContent = file.name;
    $('filePreview').classList.remove('hidden');
    
    // Auto switch to Gemini for files
    setProvider('gemini');
    toast('File attached. Gemini activated.', 'success');
  };
  reader.readAsDataURL(file);
}

function clearFile() {
  pendingFile = null;
  $('fileInput').value = '';
  $('filePreview').classList.add('hidden');
}

// CHAT LOGIC
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

async function handleSend() {
  const text = $('input').value.trim();
  if (!text && !pendingFile) return;

  const userMsg = text || (pendingFile ? `[Uploaded: ${pendingFile.name}]` : '');
  appendMessage('user', userMsg);
  
  $('input').value = '';
  $('input').style.height = 'auto';
  
  const typingId = showTyping();
  
  const payload = {
    message: text || 'Analyze this file.',
    provider: currentProvider
  };
  
  if (pendingFile) {
    payload.fileBase64 = pendingFile.base64;
    payload.mimeType = pendingFile.mimeType;
    payload.fileName = pendingFile.name;
  }

  clearFile();

  try {
    const res = await fetch(API + '/api/chat', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token 
      },
      body: JSON.stringify(payload)
    });
    
    if (res.status === 401) return logout();
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    
    removeTyping(typingId);
    appendMessage('bot', data.reply);
    
  } catch (e) {
    removeTyping(typingId);
    appendMessage('bot', '⚠️ ' + e.message);
  }
}

// UI HELPERS
function appendMessage(role, text) {
  const container = $('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  
  let formatted = text;
  if (role === 'bot') {
    formatted = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }

  div.innerHTML = `<div class="bubble">${formatted}</div><div class="meta">${time}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = $('messages');
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.id = 'typing_' + Date.now();
  div.innerHTML = `<div class="bubble" style="color:var(--accent)">Thinking...</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div.id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

async function loadHistory() {
  try {
    const res = await fetch(API + '/api/history', { headers: { 'Authorization': 'Bearer ' + token } });
    const msgs = await res.json();
    if (!msgs.length) {
      appendMessage('bot', `Hello ${user.name}! I am AXIOM. You can switch between Groq and Gemini, or upload files for me to analyze.`);
      return;
    }
    msgs.forEach(m => appendMessage(m.role === 'user' ? 'user' : 'bot', m.content));
  } catch (e) {}
}

function toast(msg, type='') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}
