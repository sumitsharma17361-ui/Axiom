/* ============================================================
   AXIOM BACKEND v1.4 (AI Logic ported from BM App)
   ============================================================ */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ============ ENV ============
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'axiom_secret_key_123';

// Multi-key support from BM App
const GROQ_API_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());
const GEMINI_API_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

// Models from BM App
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODELS = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash';
const GEMINI_FALLBACK_MODELS = [process.env.GEMINI_MODEL_2 || 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-2.0-flash-exp'].filter(Boolean);
const GEMINI_GLOBAL_TIMEOUT_MS = 60000;

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }

// ============ MONGOOSE ============
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => { console.error('❌ MongoDB:', e.message); process.exit(1); });

const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Memory = mongoose.model('Memory', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  key: { type: String, required: true },
  value: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

// ============ RATE LIMIT ============
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 100 }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));

// ============ AUTH MIDDLEWARE ============
function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ============ AI PROVIDER (BM App Logic) ============
let groqKeyIndex = 0;
let geminiKeyIndex = 0;

function _hashThreadId(threadId, salt = '') { const s = salt + '|' + (threadId || 'default'); let hash = 0; for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0; } return Math.abs(hash); }
function getNextGroqKey(threadId = null, attempt = 0) { if (GROQ_API_KEYS.length === 0) return null; if (!threadId) { const key = GROQ_API_KEYS[groqKeyIndex % GROQ_API_KEYS.length]; groqKeyIndex = (groqKeyIndex + 1) % GROQ_API_KEYS.length; return key; } const start = _hashThreadId(threadId, 'groq') % GROQ_API_KEYS.length; return GROQ_API_KEYS[(start + attempt) % GROQ_API_KEYS.length]; }
function getNextGeminiKey(threadId = null, attempt = 0) { if (GEMINI_API_KEYS.length === 0) return null; if (!threadId) { const key = GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length]; geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length; return key; } const start = _hashThreadId(threadId, 'gemini') % GEMINI_API_KEYS.length; return GEMINI_API_KEYS[(start + attempt) % GEMINI_API_KEYS.length]; }

async function callGroqOnce({ prompt, systemPrompt = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 45000, model = null, apiKey = null, threadId = null, attempt = 0, forceJson = false }) {
  const useKey = apiKey || getNextGroqKey(threadId, attempt);
  if (!useKey) throw new Error('No Groq API key');
  const useModel = model || GROQ_MODEL;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (history && Array.isArray(history)) {
    const recent = history.slice(-6);
    for (const m of recent) { if (!m || !m.content) continue; messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }); }
  }
  messages.push({ role: 'user', content: prompt });
  const body = { model: useModel, messages, max_tokens: maxTokens, temperature, top_p: 0.95 };
  if (forceJson) body.response_format = { type: 'json_object' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${useKey}` }, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) { const errText = await response.text(); throw new Error(`Groq ${response.status}: ${errText.substring(0, 300)}`); }
    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty Groq response');
    return text;
  } catch (err) { clearTimeout(timeout); throw err; }
}

async function callGroq(args) {
  const modelsToTry = [args.model || GROQ_MODEL, ...GROQ_FALLBACK_MODELS];
  if (GROQ_API_KEYS.length === 0) throw new Error('No Groq API key');
  let lastError = null;
  for (const model of modelsToTry) {
    const apiKey = getNextGroqKey(args.threadId || null, 0);
    if (!apiKey) break;
    try { return await callGroqOnce({ ...args, model, apiKey, attempt: 0 }); }
    catch (err) { lastError = err; console.warn(`Groq [${model}] failed: ${err.message.slice(0, 50)}`); }
  }
  throw lastError || new Error('Groq failed');
}

function parseGeminiError(err) {
  const msg = err.message || String(err);
  if (msg.includes('429') || msg.toLowerCase().includes('quota')) return { code: 429, type: 'RATE_LIMIT' };
  if (msg.includes('503') || msg.toLowerCase().includes('high demand')) return { code: 503, type: 'OVERLOADED' };
  if (msg.includes('504') || msg.toLowerCase().includes('deadline')) return { code: 504, type: 'TIMEOUT' };
  if (msg.includes('404') || msg.toLowerCase().includes('not found')) return { code: 404, type: 'MODEL_NOT_FOUND' };
  return { code: 500, type: 'UNKNOWN' };
}

async function callGeminiOnce({ prompt, systemPrompt = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 60000, model = null, apiKey = null, threadId = null, attempt = 0 }) {
  const useKey = apiKey || getNextGeminiKey(threadId, attempt);
  if (!useKey) throw new Error('No Gemini API key');
  const useModel = model || GEMINI_MODEL;
  const contents = [];
  if (history && Array.isArray(history)) {
    const recent = history.slice(-6);
    for (const m of recent) { if (!m || !m.content) continue; contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); }
  }
  const userParts = [{ text: prompt }];
  contents.push({ role: 'user', parts: userParts });
  const payload = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.95 } };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${useKey}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) { const errText = await response.text(); throw new Error(`Gemini ${response.status}: ${errText.substring(0, 300)}`); }
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim();
    if (!text) throw new Error('Empty Gemini response');
    return text;
  } catch (err) { clearTimeout(timeout); throw err; }
}

async function callGemini(args) {
  if (GEMINI_API_KEYS.length === 0) throw new Error('No Gemini API key');
  const preferred = [args.model || GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean);
  const startTime = Date.now();
  let lastError = null;
  for (const model of preferred) {
    for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
      if (Date.now() - startTime > GEMINI_GLOBAL_TIMEOUT_MS) throw new Error('Gemini timeout');
      const apiKey = getNextGeminiKey(args.threadId || null, i);
      if (!apiKey) break;
      try { return await callGeminiOnce({ ...args, model, apiKey, attempt: i }); }
      catch (err) { lastError = err; const parsed = parseGeminiError(err); if (parsed.type === 'MODEL_NOT_FOUND') break; }
    }
  }
  throw lastError || new Error('All Gemini models failed.');
}

async function callAI(args) {
  const TOTAL_TIMEOUT = 90000;
  const startTime = Date.now();
  let groqError = null;
  if (GROQ_API_KEYS.length > 0) {
    try {
      const reply = await callGroq({ ...args, timeoutMs: Math.min(45000, TOTAL_TIMEOUT - (Date.now() - startTime)) });
      return { reply, provider: 'groq', model: GROQ_MODEL };
    } catch (err) { groqError = err; console.warn('Groq master failed, falling back to Gemini:', err.message); }
  }
  const remainingTime = TOTAL_TIMEOUT - (Date.now() - startTime);
  if (remainingTime <= 0) throw new Error('AI too slow.');
  try {
    const reply = await callGemini({ ...args });
    return { reply, provider: 'gemini', model: GEMINI_MODEL };
  } catch (geminiError) {
    throw new Error(`Both AI providers failed. Groq: ${groqError?.message.substring(0,80)} | Gemini: ${geminiError.message.substring(0,80)}`);
  }
}

// ============ TOOLS ============
async function webSearch(query) {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const data = await res.json();
    const out = [];
    if (data.AbstractText) out.push(data.AbstractText);
    if (data.AbstractURL) out.push(`Source: ${data.AbstractURL}`);
    (data.RelatedTopics || []).slice(0, 3).forEach(t => { if (t.Text) out.push('• ' + t.Text); });
    return out.length ? out.join('\n') : `No instant answer. Try: https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  } catch (e) { return 'Search failed: ' + e.message; }
}

async function getWeather(city) {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    if (!res.ok) throw new Error('Weather API error');
    const data = await res.json();
    const c = data.current_condition[0];
    return `${city}: ${c.temp_C}°C, ${c.weatherDesc[0].value}, Humidity ${c.humidity}%, Wind ${c.windspeedKmph} km/h`;
  } catch (e) { return 'Weather unavailable: ' + e.message; }
}

function calc(expr) {
  try {
    if (!/^[\d\s+\-*/().%]+$/.test(expr)) return 'Invalid expression';
    const r = Function('"use strict"; return (' + expr + ')')();
    return String(r);
  } catch (e) { return 'Calc error: ' + e.message; }
}

// ============ AUTH ROUTES ============
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
    const clean = email.toLowerCase().trim();
    if (await User.findOne({ email: clean })) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: clean, name: (name || clean.split('@')[0]).slice(0, 50), password: hash });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ============ CHAT ROUTE ============
app.post('/api/chat', auth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required' });
    if (message.length > 4000) return res.status(400).json({ error: 'Message too long' });

    const user = await User.findById(req.userId);
    const recent = await Message.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(20).lean();
    recent.reverse();
    const memories = await Memory.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(30).lean();

    const memoryText = memories.length
      ? `\n\n[Facts about the user]:\n${memories.map(m => `• ${m.key}: ${m.value}`).join('\n')}`
      : '';

    const systemPrompt = `You are AXIOM — a sharp, loyal, personal AI assistant.
Current date/time: ${new Date().toISOString()}
User: ${user.name}${memoryText}

TOOLS available (return ONLY the JSON object if you need one, nothing else):
- {"tool":"search","query":"..."}
- {"tool":"weather","city":"..."}
- {"tool":"calc","expr":"..."}
- {"tool":"remember","key":"...","value":"..."} → save a fact about the user
- {"tool":"forget","key":"..."}

RULES:
- If the user asks a factual/recent-events question, use the search tool.
- If the user asks weather, use weather tool.
- If user asks math, use calc.
- If user shares a personal fact ("my birthday is..."), save it via remember tool.
- Otherwise, respond naturally in plain conversational language.
- Be concise. No long preambles. Use emojis sparingly.
- Match the user's language (English / Hindi / Hinglish).`;

    await Message.create({ userId: req.userId, role: 'user', content: message });

    const { reply, provider } = await callAI({ 
      prompt: message, 
      systemPrompt, 
      history: recent.map(m => ({ role: m.role, content: m.content })),
      maxTokens: 1500,
      temperature: 0.7
    });
    
    let finalReply = reply;
    let toolUsed = null;

    // Detect tool call
    try {
      const m = reply.match(/\{[\s\S]*?\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.tool) {
          toolUsed = parsed.tool;
          let result;
          if (parsed.tool === 'search') result = await webSearch(parsed.query || '');
          else if (parsed.tool === 'weather') result = await getWeather(parsed.city || 'Delhi');
          else if (parsed.tool === 'calc') result = calc(parsed.expr || '');
          else if (parsed.tool === 'remember') {
            await Memory.deleteMany({ userId: req.userId, key: parsed.key });
            await Memory.create({ userId: req.userId, key: String(parsed.key).slice(0, 60), value: String(parsed.value).slice(0, 500) });
            result = `Saved: ${parsed.key} = ${parsed.value}`;
          } else if (parsed.tool === 'forget') {
            await Memory.deleteMany({ userId: req.userId, key: parsed.key });
            result = `Forgot: ${parsed.key}`;
          }
          if (result !== undefined) {
            const followUp = await callAI({
              prompt: `Tool "${parsed.tool}" returned:\n${result}\n\nNow answer the user naturally using this info. Do not mention "tool".`,
              systemPrompt,
              history: [...recent.map(m => ({ role: m.role, content: m.content })), { role: 'assistant', content: reply }]
            });
            finalReply = followUp.reply;
          }
        }
      }
    } catch (e) { /* not a tool call */ }

    await Message.create({ userId: req.userId, role: 'assistant', content: finalReply });

    res.json({ reply: finalReply, provider, toolUsed });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message || 'AI failed. Try again.' });
  }
});

// ============ HISTORY & MEMORY ============
app.get('/api/history', auth, async (req, res) => {
  const msgs = await Message.find({ userId: req.userId }).sort({ createdAt: 1 }).limit(300).lean();
  res.json(msgs.map(m => ({ role: m.role, content: m.content, at: m.createdAt })));
});

app.delete('/api/history', auth, async (req, res) => {
  await Message.deleteMany({ userId: req.userId });
  res.json({ ok: true });
});

app.get('/api/memory', auth, async (req, res) => {
  const m = await Memory.find({ userId: req.userId }).sort({ createdAt: -1 }).lean();
  res.json(m);
});

app.delete('/api/memory/:id', auth, async (req, res) => {
  await Memory.deleteOne({ _id: req.params.id, userId: req.userId });
  res.json({ ok: true });
});

// ============ HEALTH ============
app.get('/', (req, res) => res.send('AXIOM online 🚀'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai: { groq: GROQ_API_KEYS.length, gemini: GEMINI_API_KEYS.length },
  db: mongoose.connection.readyState === 1 ? 'connected' : 'down',
  version: '1.4.0'
}));

// ============ LISTEN ============
app.listen(PORT, () => {
  console.log(`🚀 AXIOM on port ${PORT}`);
  console.log(`🤖 AI: ${GROQ_API_KEYS.length} Groq key(s), ${GEMINI_API_KEYS.length} Gemini key(s)`);
});
