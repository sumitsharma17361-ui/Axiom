/* ============================================================
   AXIOM BACKEND v2.0 (Multi-Provider + Multimodal Files)
   ============================================================ */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' })); // Increased limit for file uploads
app.use(cors());

// ============ ENV ============
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'axiom_secret_key_123';

const GROQ_API_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());
const GEMINI_API_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(k => k && k.trim() && k.trim().length > 5).map(k => k.trim());

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_FALLBACK_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
const GEMINI_FALLBACK_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'];

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
  fileName: { type: String, default: null }, // To show file icon in chat
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

// ============ AI PROVIDERS ============
async function callGroq(prompt, systemPrompt, history) {
  if (GROQ_API_KEYS.length === 0) throw new Error('No Groq API key');
  const key = GROQ_API_KEYS[0]; // Simplified for this version
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 2000 })
  });
  if (!res.ok) throw new Error(`Groq Error: ${res.statusText}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGemini(prompt, systemPrompt, history, fileBase64, mimeType) {
  if (GEMINI_API_KEYS.length === 0) throw new Error('No Gemini API key');
  const key = GEMINI_API_KEYS[0];
  
  const contents = [];
  if (history) {
    // Convert standard history to Gemini format
    for (const msg of history) {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    }
  }

  const userParts = [{ text: prompt }];
  if (fileBase64 && mimeType) {
    userParts.push({ inline_data: { mime_type: mimeType, data: fileBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });

  const payload = { contents };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Gemini Error: ${err}`); }
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
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
    
    // Save user message first
    await Message.create({ userId: req.userId, role: 'user', content: message || 'Uploaded a file', fileName });

    let reply = '';
    
    // If file is present, force Gemini (as Groq doesn't read files)
    const useGemini = !!fileBase64 || provider === 'gemini';

    try {
      if (useGemini) {
        reply = await callGemini(message, systemPrompt, history, fileBase64, mimeType);
      } else {
        reply = await callGroq(message, systemPrompt, history);
      }
    } catch (err) {
      // Fallback
      reply = await callGemini(message, systemPrompt, history, fileBase64, mimeType);
    }

    // Simple memory extraction logic
    try {
      const match = reply.match(/\{"tool":"remember".*?\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        await Memory.create({ userId: req.userId, key: parsed.key, value: parsed.value });
        reply = reply.replace(match[0], '').trim(); // remove JSON from reply
        if (!reply) reply = "Got it. I'll remember that.";
      }
    } catch (e) {}

    await Message.create({ userId: req.userId, role: 'assistant', content: reply });
    res.json({ reply });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', auth, async (req, res) => {
  const msgs = await Message.find({ userId: req.userId }).sort({ createdAt: 1 }).lean();
  res.json(msgs);
});

app.get('/', (req, res) => res.send('AXIOM ONLINE'));
app.listen(PORT, () => console.log(`🚀 AXIOM on ${PORT}`));
