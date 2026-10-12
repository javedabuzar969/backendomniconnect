// backend/server.js — Main Express Server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRouter from './routes/auth.js';
import whatsappRouter from './routes/whatsapp.js';
import integrationsRouter from './routes/integrations.js';
import conversationsRouter from './routes/conversations.js';
import facebookRouter from './routes/facebook.js';

const app = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ───────────────────────────────────────────
// Vercel serverless rewrite changes req.url to /server.js; restore original path
app.use((req, res, next) => {
  const original = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-now-route-matches'];
  if (original && (req.url === '/server.js' || req.url.startsWith('/server.js'))) {
    req.url = original;
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    // Allow all origins (localhost, Vercel preview, production domain)
    callback(null, true);
  },
  credentials: true,
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

// ── Health Check ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'OmniConnect Backend is running 🚀' });
});

// ── Routes ───────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/integrations/facebook', facebookRouter);
app.use('/api/conversations', conversationsRouter);

// ── 404 Handler ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Error Handler ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start (Local only — Vercel handles its own listener) ─────────────────────
// On Vercel, process.env.VERCEL is set — do NOT call listen() there.
// Vercel imports this file as a serverless function and uses the exported app.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  const server = app.listen(PORT, () => {
    console.log(`\n🚀 OmniConnect Backend running on http://localhost:${PORT}`);
    console.log(`📡 API endpoints:`);
    console.log(`   POST http://localhost:${PORT}/api/auth/signup`);
    console.log(`   POST http://localhost:${PORT}/api/auth/login`);
    console.log(`   GET  http://localhost:${PORT}/api/auth/me`);
    console.log(`   GET  http://localhost:${PORT}/api/health\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} is busy! Run: npx kill-port ${PORT}\n`);
      process.exit(1);
    }
  });
}

export default app;
