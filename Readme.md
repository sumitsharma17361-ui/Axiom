# AXIOM — Your Personal AI Agent

A futuristic AI assistant with voice, memory, and tools.

## Stack
- **Backend:** Node.js + Express + MongoDB
- **AI:** Groq (primary) + Gemini (fallback)
- **Frontend:** Vanilla JS PWA
- **Deploy:** Render + MongoDB Atlas
- **APK:** Median.co

## Quick Deploy

1. Push to GitHub
2. Render: New Web Service → root dir `backend/` → add env vars
3. Set `API` constant in `frontend/app.js` to your Render URL
4. Deploy frontend to GitHub Pages
5. Wrap via Median.co

## Env Vars (backend)
- `MONGO_URI`
- `JWT_SECRET`
- `GROQ_API_KEY`
- `GEMINI_API_KEY`
