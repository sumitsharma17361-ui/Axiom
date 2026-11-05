/* ============================================================
   AXIOM BACKEND v3.0 (Robust Multi-Provider + Fallbacks)
   ============================================================ */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ============ ENV ============
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'axiom_secret_key_123';

// Multi-Key Support
const GROQ_API_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(k => k && k.trim().length > 5);
const GEMINI_API_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(k => k && k.trim().length > 5);

// Model Config & Fallbacks
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODELS = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
const GEMINI_FALLBACK_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'];

let groqKeyIndex = 0;
let geminiKeyIndex = 0;

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }

// ============ MONGOOSE ============
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => { console.error('❌ MongoDB:', e.message); process.exit(1); });

const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  fileName: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}));

const Memory = mongoose.model('Memory', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  key: { type: String, required: true },
  value: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}));

// ============ AUTH ============
function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

// ============ ROBUST AI PROVIDERS ============
function getNextGroqKey() {
  if (GROQ_API_KEYS.length === 0) return null;
  const key = GROQ_API_KEYS[groqKeyIndex % GROQ_API_KEYS.length];
  groqKeyIndex++;
  return key;
}

function getNextGeminiKey() {
  if (GEMINI_API_KEYS.length === 0) return null;
  const key = GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length];
  geminiKeyIndex++;
  return key;
}

async function callGroqOnce({ prompt, systemPrompt, history, timeoutMs = 45000, model, apiKey }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: 2000, temperature: 0.7 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Groq Error: ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function callGroq(args) {
  if (GROQ_API_KEYS.length === 0) throw new Error('No Groq API key');
  const modelsToTry = [args.model || GROQ_MODEL, ...GROQ_FALLBACK_MODELS];
  let lastError = null;

  for (const model of modelsToTry) {
    const apiKey = getNextGroqKey();
    if (!apiKey) break;
    try {
      return await callGroqOnce({ ...args, model, apiKey });
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Groq model ${model} failed, trying next...`);
    }
  }
  throw lastError || new Error('All Groq models failed');
}

async function callGeminiOnce({ prompt, systemPrompt, history, fileBase64, mimeType, timeoutMs = 60000, model, apiKey }) {
  const contents = [];
  if (history) {
    for (const msg of history) {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    }
  }
  const userParts = [{ text: prompt }];
  if (fileBase64 && mimeType) {
    userParts.push({ inline_data: { mime_type: mimeType, data: fileBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });

  const payload = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 2000 } };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function callGemini(args) {
  if (GEMINI_API_KEYS.length === 0) throw new Error('No Gemini API key');
  const modelsToTry = [args.model || GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  let lastError = null;

  for (const model of modelsToTry) {
    for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
      const apiKey = getNextGeminiKey();
      if (!apiKey) break;
      try {
        return await callGeminiOnce({ ...args, model, apiKey });
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ Gemini model ${model} failed, trying next...`);
      }
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

// Unified AI Caller
async function callAI(args) {
  const TOTAL_TIMEOUT = 90000;
  const startTime = Date.now();
  let groqError = null;

  // 1. Try Groq First (if no file is attached)
  if (!args.fileBase64 && GROQ_API_KEYS.length > 0) {
    try {
      const reply = await callGroq({ ...args, timeoutMs: 45000 });
      return { reply, provider: 'groq' };
    } catch (err) {
      groqError = err;
    }
  }

  // 2. Fallback to Gemini
  const remainingTime = TOTAL_TIMEOUT - (Date.now() - startTime);
  if (remainingTime <= 0) throw new Error('AI request timed out.');

  try {
    const reply = await callGemini({ ...args, timeoutMs: remainingTime });
    return { reply, provider: 'gemini' };
  } catch (geminiError) {
    throw new Error(`Both AI providers failed. Groq: ${groqError?.message || 'Skipped'} | Gemini: ${geminiError.message}`);
  }
}

// ============ ROUTES ============
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ error: 'Email exists' });
    const user = await User.create({ email, name, password: await bcrypt.hash(password, 10) });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email, name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', auth, async (req, res) => {
  try {
    const { message, provider, fileBase64, mimeType, fileName } = req.body;
    const user = await User.findById(req.userId);
    const recent = await Message.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(20).lean();
    recent.reverse();
    const memories = await Memory.find({ userId: req.userId }).lean();

    const memoryText = memories.map(m => `• ${m.key}: ${m.value}`).join('\n');
    const systemPrompt = `You are AXIOM, a personal AI for ${user.name}.\nMemory:\n${memoryText}\n\nIf user gives personal info, output JSON like {"tool":"remember","key":"...","value":"..."}`;

    const history = recent.map(m => ({ role: m.role, content: m.content }));
    
    await Message.create({ userId: req.userId, role: 'user', content: message || 'Uploaded a file', fileName });

    let reply = '';
    
    // Use the robust callAI wrapper
    const aiResult = await callAI({
      prompt: message,
      systemPrompt,
      history,
      fileBase64,
      mimeType
    });

    reply = aiResult.reply;

    // Memory extraction
    try {
      const match = reply.match(/\{"tool":"remember".*?\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        await Memory.create({ userId: req.userId, key: parsed.key, value: parsed.value });
        reply = reply.replace(match[0], '').trim(); 
        if (!reply) reply = "Got it. I'll remember that.";
      }
    } catch (e) {}

    await Message.create({ userId: req.userId, role: 'assistant', content: reply });
    res.json({ reply, provider: aiResult.provider });

  } catch (e) { 
    console.error("Chat Error:", e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.get('/api/history', auth, async (req, res) => {
  try {
    const msgs = await Message.find({ userId: req.userId }).sort({ createdAt: 1 }).lean();
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', groqKeys: GROQ_API_KEYS.length, geminiKeys: GEMINI_API_KEYS.length }));
app.get('/', (req, res) => res.send('AXIOM ONLINE'));

app.listen(PORT, () => console.log(`🚀 AXIOM v3.0 running on ${PORT}`));
