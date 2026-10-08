// backend/routes/auth.js — Authentication routes powered by Supabase
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'omniconnect_secret_2026';

// Seeded users cache to ensure instant login without database lag
const inMemoryUsers = new Map([
  ['javedabuzar969@gmail.com', {
    id: '6aa56cd8-e7e7-4889-ef9c-f17400000001',
    name: 'abuzar',
    email: 'javedabuzar969@gmail.com',
    password: '$2a$12$ZfZyxaH1Nj5u2pDKqUf1Y.zDJlVhmlJQwDYuoP7TWuYXc9QusLS4u',
    plan: 'free',
    workspace: "abuzar's Workspace",
    contacts: 0,
    createdAt: '2026-09-12T15:16:40.794Z',
  }],
  ['abuzarjaved@gmail.com', {
    id: '6aa68d75-1c87-a8a8-d547-150900000001',
    name: 'abzuar',
    email: 'abuzarjaved@gmail.com',
    password: '$2a$12$CzVUTOJo1no.P845AyERs.ROARRrPZlMQ7HN//yRyVBYRYceQPKKa',
    plan: 'free',
    workspace: "abzuar's Workspace",
    contacts: 0,
    createdAt: '2026-09-13T11:48:05.823Z',
  }]
]);

// ── Middleware: verify JWT ────────────────────────────────
export function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── POST /api/auth/signup ────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const cleanEmail = email.toLowerCase().trim();

    // 1. Check if user exists in Supabase
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (existingUser || inMemoryUsers.has(cleanEmail)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();

    const newUser = {
      name: name.trim(),
      email: cleanEmail,
      password: hashedPassword,
      plan: 'free',
      workspace: `${name.trim().split(' ')[0]}'s Workspace`,
      contacts: 0,
      created_at: now,
      updated_at: now,
    };

    let userId = null;

    // Try saving in Supabase
    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert(newUser)
      .select()
      .single();

    if (!insErr && inserted) {
      userId = inserted.id;
    } else {
      // Fallback to memory
      userId = `u_${Date.now()}`;
      inMemoryUsers.set(cleanEmail, { ...newUser, id: userId, createdAt: now });
    }

    const token = jwt.sign(
      { userId, email: cleanEmail, name: newUser.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      token,
      user: {
        id: userId,
        name: newUser.name,
        email: cleanEmail,
        plan: newUser.plan,
        workspace: newUser.workspace,
        createdAt: now,
      },
    });
  } catch (err) {
    console.error('[SIGNUP]', err);
    res.status(500).json({ error: err.message || 'Server error. Please try again.' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const cleanEmail = email.toLowerCase().trim();
    let user = null;

    // 1. Try Supabase
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', cleanEmail)
        .maybeSingle();

      if (!error && data) {
        user = data;
      }
    } catch {}

    // 2. Fallback to memory
    if (!user && inMemoryUsers.has(cleanEmail)) {
      user = inMemoryUsers.get(cleanEmail);
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id || user._id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id || user._id,
        name: user.name,
        email: user.email,
        plan: user.plan || 'free',
        workspace: user.workspace || "My Workspace",
        createdAt: user.created_at || user.createdAt,
      },
    });
  } catch (err) {
    console.error('[LOGIN]', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    let user = null;

    // 1. Try Supabase
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, email, plan, workspace, contacts, created_at')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data) {
        user = data;
      }
    } catch {}

    // 2. Fallback to memory
    if (!user) {
      for (const u of inMemoryUsers.values()) {
        if (u.id === userId || u.email === req.user.email) {
          user = u;
          break;
        }
      }
    }

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan || 'free',
        workspace: user.workspace,
        contacts: user.contacts || 0,
        createdAt: user.created_at || user.createdAt,
      },
    });
  } catch (err) {
    console.error('[ME]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
