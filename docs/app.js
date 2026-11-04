/* ============================================================
   AXIOM FRONTEND v2.0 (JARVIS Live Voice Mode)
   ============================================================ */

// ★★★ AAPKA RENDER URL ★★★
const API = 'https://axiom-xh42.onrender.com';

let token = localStorage.getItem('axiom_token') || null;
let user = JSON.parse(localStorage.getItem('axiom_user') || 'null');
let isRegisterMode = false;

// Voice Variables
let recognition = null;
let isListening = false;
let isSpeaking = false;
let liveModeActive = false;

const $ = (id) => document.getElementById(id);

// ============ INIT ============
window.addEventListener('DOMContentLoaded', () => {
  if (token && user) {
    showStartScreen();
  } else {
    $('authScreen').classList.add('active');
  }
});

// ============ AUTH ============
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
  
  if (!email || !password) return showAuthError('Email and password required');
  if (password.length < 6) return showAuthError('Password must be 6+ characters');
  if (isRegisterMode && !name) return showAuthError('Please enter your name');

  const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
  $('primaryBtn').disabled = true;
  $('primaryBtn').textContent = 'Please wait...';

  try {
    const res = await fetch(API + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    
    token = data.token;
    user = data.user;
    localStorage.setItem('axiom_token', token);
    localStorage.setItem('axiom_user', JSON.stringify(user));
    
    // Go to Start Screen
    $('authScreen').classList.remove('active');
    showStartScreen();
    
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

// ============ START SCREEN & GREETING ============
function showStartScreen() {
  $('authScreen').classList.remove('active');
  $('chatScreen').classList.remove('active');
  $('startScreen').classList.add('active');
  
  // Time-based Greeting Text
  const hour = new Date().getHours();
  let greet = 'Hello';
  if (hour < 12) greet = 'Good morning';
  else if (hour < 18) greet = 'Good afternoon';
  else greet = 'Good evening';
  
  const userName = user.name ? user.name.split(' ')[0] : 'Sumit';
  $('startGreeting').textContent = `${greet}, ${userName}. Tap below to start.`;
}

function startLiveMode() {
  $('startScreen').classList.remove('active');
  $('chatScreen').classList.add('active');
  
  // Initial Greeting from AI
  const hour = new Date().getHours();
  let greet = 'Hello';
  if (hour < 12) greet = 'Good morning';
  else if (hour < 18) greet = 'Good afternoon';
  else greet = 'Good evening';
  
  const userName = user.name ? user.name.split(' ')[0] : 'Sumit';
  const welcomeMsg = `${greet} ${userName}. How can I help you today?`;
  
  appendMessage('bot', welcomeMsg);
  liveModeActive = true;
  
  // AI will speak first, then start listening
  speakText(welcomeMsg, () => {
    startListening();
  });
}

function stopLiveMode() {
  liveModeActive = false;
  stopRecognition();
  window.speechSynthesis.cancel();
  showStartScreen();
}

// ============ VOICE RECOGNITION (STT) ============
function startListening() {
  if (!liveModeActive) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice not supported on this browser', 'error');

  if (isListening || isSpeaking) return;

  recognition = new SR();
  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    isListening = true;
    $('voiceVisualizer').classList.add('active');
    $('statusText').textContent = 'Listening...';
  };

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    if (transcript.trim()) {
      $('input').value = transcript;
      handleManualText();
    }
  };

  recognition.onerror = (e) => {
    if (e.error !== 'aborted' && e.error !== 'no-speech') {
      $('statusText').textContent = 'Mic error. Please allow mic permissions.';
    }
  };

  recognition.onend = () => {
    isListening = false;
    $('voiceVisualizer').classList.remove('active');
    if (liveModeActive && !isSpeaking) {
       $('statusText').textContent = 'Tap mic to speak...';
    }
  };

  try { recognition.start(); } catch (e) { console.error(e); }
}

function stopRecognition() {
  isListening = false;
  $('voiceVisualizer').classList.remove('active');
  if (recognition) { try { recognition.stop(); } catch(e) {} recognition = null; }
}

// ============ VOICE SYNTHESIS (TTS) ============
function speakText(text, callback) {
  if (!('speechSynthesis' in window)) {
    if (callback) callback();
    return;
  }
  
  stopRecognition(); // Stop listening while speaking
  window.speechSynthesis.cancel();
  
  const cleanText = text.replace(/[*`#]/g, '').replace(/\n+/g, '. ');
  const u = new SpeechSynthesisUtterance(cleanText);
  u.lang = 'en-IN';
  u.rate = 1.05;
  u.pitch = 1.0;
  
  isSpeaking = true;
  $('statusText').textContent = 'Speaking...';
  $('voiceVisualizer').classList.add('active');
  
  u.onend = () => {
    isSpeaking = false;
    $('voiceVisualizer').classList.remove('active');
    if (callback) callback(); // Start listening again
  };
  
  window.speechSynthesis.speak(u);
}

// ============ CHAT LOGIC ============
async function handleManualText() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  
  appendMessage('user', text);
  $('statusText').textContent = 'Thinking...';
  
  try {
    const res = await fetch(API + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ message: text })
    });
    
    if (res.status === 401) {
      localStorage.clear();
      location.reload();
      return;
    }
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    
    appendMessage('bot', data.reply);
    
    // Auto-speak AI reply, then start listening again
    if (liveModeActive) {
      speakText(data.reply, () => {
        // Add a small delay before listening to avoid hearing its own voice
        setTimeout(startListening, 500);
      });
    }
    
  } catch (e) {
    appendMessage('bot', '⚠️ ' + e.message);
    if (liveModeActive) setTimeout(startListening, 1000);
  }
}

function handleKey(e) {
  if (e.key === 'Enter') handleManualText();
}

function appendMessage(role, text) {
  const container = $('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const formatted = role === 'bot' ? formatMarkdown(text) : escapeHtml(text);
  
  div.innerHTML = `
    <div class="bubble">${formatted}</div>
    <div class="meta">${time}</div>
  `;
  container.appendChild(div);
  
  // Scroll to bottom
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
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

function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}
