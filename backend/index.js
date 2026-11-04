/* ============================================================
   AXIOM BACKEND v1.2 — Stable AI Fallback
   ============================================================ */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// ============ ENV ============
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(k => k && k.length > 5);
const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(k => k && k.length > 5);

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }
if (!GROQ_KEYS.length && !GEMINI_KEYS.length) console.warn('⚠️ No AI keys — chat will fail');

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

// ============================================================
//  AI PROVIDERS (FIXED)
// ============================================================

// 1. Groq Call
async function callGroq(messages, key, model = 'llama-3.3-70b-versatile') {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.7 })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Groq ${res.status}: ${t.slice(0, 100)}`); }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty Groq response');
  return text;
}

// 2. Gemini Call
async function callGemini(messages, key, model = 'gemini-1.5-flash') {
  const system = messages.find(m => m.role === 'system');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  
  const body = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 1500 } };
  if (system) body.systemInstruction = { parts: [{ text: system.content }] };
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${t.slice(0, 100)}`); }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

// 3. Master Caller (Groq -> Groq Fallback -> Gemini -> Gemini Fallback)
async function callAI(messages) {
  let lastErr = null;
  
  // Try Groq Models
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of groqModels) {
    for (const key of GROQ_KEYS) {
      try { 
        return { reply: await callGroq(messages, key, model), provider: 'groq' }; 
      } catch (e) { 
        lastErr = e; 
        console.warn(`Groq [${model}] failed: ${e.message.slice(0, 60)}...`); 
      }
    }
  }
  
  // Try Gemini Models
  const geminiModels = ['gemini-1.5-flash', 'gemini-1.5-pro'];
  for (const model of geminiModels) {
    for (const key of GEMINI_KEYS) {
      try { 
        return { reply: await callGemini(messages, key, model), provider: 'gemini' }; 
      } catch (e) { 
        lastErr = e; 
        console.warn(`Gemini [${model}] failed: ${e.message.slice(0, 60)}...`); 
      }
    }
  }
  
  throw lastErr || new Error('All AI providers failed. Please try again later.');
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

    const messages = [
      { role: 'system', content: systemPrompt },
      ...recent.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    await Message.create({ userId: req.userId, role: 'user', content: message });

    const { reply, provider } = await callAI(messages);
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
            const followUp = await callAI([
              ...messages,
              { role: 'assistant', content: reply },
              { role: 'user', content: `Tool "${parsed.tool}" returned:\n${result}\n\nNow answer the user naturally using this info. Do not mention "tool".` }
            ]);
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
  ai: { groq: GROQ_KEYS.length, gemini: GEMINI_KEYS.length },
  db: mongoose.connection.readyState === 1 ? 'connected' : 'down',
  version: '1.2.0'
}));

// ============ LISTEN ============
app.listen(PORT, () => {
  console.log(`🚀 AXIOM on port ${PORT}`);
  console.log(`🤖 AI: ${GROQ_KEYS.length} Groq key(s), ${GEMINI_KEYS.length} Gemini key(s)`);
});
