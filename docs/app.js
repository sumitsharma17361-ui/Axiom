const API = 'https://axiom-xh42.onrender.com';

let token = localStorage.getItem('axiom_token') || null;
let user = JSON.parse(localStorage.getItem('axiom_user') || 'null');
let isRegisterMode = false;

// Voice State
let recognition = null;
let isListening = false;
let isSpeaking = false;
let liveModeActive = false;

const $ = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', () => {
  if (token && user) { showStartScreen(); } 
  else { $('authScreen').classList.add('active'); }
});

// AUTH (Same as before)
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
  
  const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
  $('primaryBtn').disabled = true;

  try {
    const res = await fetch(API + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    
    token = data.token; user = data.user;
    localStorage.setItem('axiom_token', token);
    localStorage.setItem('axiom_user', JSON.stringify(user));
    
    $('authScreen').classList.remove('active');
    showStartScreen();
  } catch (e) { showAuthError(e.message); } 
  finally { $('primaryBtn').disabled = false; $('primaryBtn').textContent = isRegisterMode ? 'Create Account' : 'Sign In'; }
}

function showAuthError(msg) {
  const el = $('authError'); el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

// START & GREETING
function showStartScreen() {
  $('authScreen').classList.remove('active');
  $('chatScreen').classList.remove('active');
  $('startScreen').classList.add('active');
  
  const hour = new Date().getHours();
  let greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const userName = user.name ? user.name.split(' ')[0] : 'Sumit';
  $('startGreeting').textContent = `${greet}, ${userName}.`;
}

function startLiveMode() {
  // ★ FIX: Mobile browsers need a "dummy" speech to unlock TTS
  window.speechSynthesis.cancel();
  const unlockMsg = new SpeechSynthesisUtterance('');
  window.speechSynthesis.speak(unlockMsg); // Unlocks audio engine

  $('startScreen').classList.remove('active');
  $('chatScreen').classList.add('active');
  
  const hour = new Date().getHours();
  let greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const userName = user.name ? user.name.split(' ')[0] : 'Sumit';
  const welcomeMsg = `${greet} ${userName}. How can I help you today?`;
  
  appendMessage('bot', welcomeMsg);
  liveModeActive = true;
  
  // AI speaks, then waits for user to click Mic
  speakText(welcomeMsg);
}

function stopLiveMode() {
  liveModeActive = false;
  stopRecognition();
  window.speechSynthesis.cancel();
  showStartScreen();
}

// MIC CONTROL
function toggleMic() {
  if (isListening) {
    stopRecognition();
  } else if (isSpeaking) {
    window.speechSynthesis.cancel(); // Stop speaking if user wants to interrupt
    startListening();
  } else {
    startListening();
  }
}

function startListening() {
  if (!liveModeActive) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Voice not supported on this browser. Use Chrome.');

  stopRecognition(); 

  recognition = new SR();
  recognition.lang = 'en-IN';
  
  recognition.onstart = () => {
    isListening = true;
    $('voiceVisualizer').classList.add('active');
    $('statusText').textContent = '🎤 Listening... Speak now.';
    $('micButton').style.background = 'var(--danger)';
  };

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    if (transcript.trim()) {
      appendMessage('user', transcript);
      sendToAI(transcript);
    }
  };

  recognition.onend = () => {
    isListening = false;
    $('voiceVisualizer').classList.remove('active');
    $('micButton').style.background = 'var(--accent-gradient)';
    if (!isSpeaking) $('statusText').textContent = 'Tap mic to speak.';
  };

  try { recognition.start(); } catch (e) { console.error(e); }
}

function stopRecognition() {
  isListening = false;
  $('voiceVisualizer').classList.remove('active');
  $('micButton').style.background = 'var(--accent-gradient)';
  if (recognition) { try { recognition.abort(); } catch(e) {} recognition = null; }
}

// TTS (AI SPEAKING)
function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  
  stopRecognition(); 
  window.speechSynthesis.cancel();
  
  const cleanText = text.replace(/[*`#]/g, '').replace(/\n+/g, '. ');
  const u = new SpeechSynthesisUtterance(cleanText);
  u.lang = 'en-IN';
  u.rate = 1.0;
  
  isSpeaking = true;
  $('statusText').textContent = '🔊 AI is speaking...';
  $('voiceVisualizer').classList.add('active');
  
  u.onend = () => {
    isSpeaking = false;
    $('voiceVisualizer').classList.remove('active');
    // Auto-start mic after AI finishes speaking
    setTimeout(() => { if(liveModeActive) startListening(); }, 500); 
  };
  
  window.speechSynthesis.speak(u);
}

// CHAT API
async function sendToAI(text) {
  $('statusText').textContent = 'Thinking...';
  
  try {
    const res = await fetch(API + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ message: text })
    });
    
    if (res.status === 401) { localStorage.clear(); location.reload(); return; }
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    
    appendMessage('bot', data.reply);
    speakText(data.reply);
    
  } catch (e) {
    appendMessage('bot', '⚠️ ' + e.message);
    $('statusText').textContent = 'Error occurred.';
  }
}

function appendMessage(role, text) {
  const container = $('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const formatted = role === 'bot' ? text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') : text;
  div.innerHTML = `<div class="bubble">${formatted}</div><div class="meta">${time}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
