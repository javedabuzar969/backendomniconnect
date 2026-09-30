// backend/routes/auth.js — All auth routes
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import getClient from '../lib/mongodb.js';

const router = Router();
const DB_NAME = 'omniconnect';
const JWT_SECRET = process.env.JWT_SECRET || 'omniconnect_secret_2026';

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

    const client = await getClient();
    const users = client.db(DB_NAME).collection('users');

    const existing = await users.findOne({ email: email.toLowerCase().trim() });
    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const now = new Date();

    const newUser = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      plan: 'free',
      workspace: `${name.trim().split(' ')[0]}'s Workspace`,
      contacts: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await users.insertOne(newUser);

    const token = jwt.sign(
      { userId: result.insertedId.toString(), email: newUser.email, name: newUser.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      token,
      user: {
        id: result.insertedId.toString(),
        name: newUser.name,
        email: newUser.email,
        plan: newUser.plan,
        workspace: newUser.workspace,
        createdAt: newUser.createdAt,
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

    const client = await getClient();
    const users = client.db(DB_NAME).collection('users');

    const user = await users.findOne({ email: email.toLowerCase().trim() });
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        plan: user.plan,
        workspace: user.workspace,
        createdAt: user.createdAt,
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
    const client = await getClient();
    const users = client.db(DB_NAME).collection('users');

    const user = await users.findOne(
      { _id: new ObjectId(req.user.userId) },
      { projection: { password: 0 } }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        plan: user.plan,
        workspace: user.workspace,
        contacts: user.contacts || 0,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    console.error('[ME]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
