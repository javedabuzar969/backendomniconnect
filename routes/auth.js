// backend/routes/auth.js — Multi-tenant Authentication with Supabase & Google Login
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'omniconnect_secret_2026';

/**
 * Resolves or creates an isolated workspace for a user
 */
export async function resolveUserWorkspace(user) {
  if (!user?.id) return 'default_workspace';

  // Primary user gets their dedicated legacy/primary workspace
  if (user.email === 'javedabuzar969@gmail.com') {
    return '0fc2e913-0fb8-4525-880c-a51993317970';
  }

  try {
    // 1. Try finding workspace from workspace_members table
    const { data: member } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (member?.workspace_id) {
      return member.workspace_id;
    }

    // 2. Try finding workspace where user is owner
    const { data: ws } = await supabase
      .from('workspaces')
      .select('id')
      .eq('owner_id', user.id)
      .limit(1)
      .maybeSingle();

    if (ws?.id) {
      return ws.id;
    }

    // 3. Try creating a new isolated workspace for this user
    const wsName = `${(user.name || 'User').split(' ')[0]}'s Workspace`;
    const wsSlug = `ws_${user.id.slice(0, 8)}_${Date.now().toString(36)}`;

    const { data: createdWs, error: createErr } = await supabase
      .from('workspaces')
      .insert({
        name: wsName,
        slug: wsSlug,
        owner_id: user.id,
      })
      .select()
      .single();

    if (!createErr && createdWs?.id) {
      await supabase
        .from('workspace_members')
        .insert({
          workspace_id: createdWs.id,
          user_id: user.id,
          role: 'owner',
        });

      return createdWs.id;
    }
  } catch (err) {
    console.warn('[Auth Workspace Resolution]', err.message);
  }

  // Fallback: Each user's ID acts as their strict deterministic isolated workspace
  return user.id;
}

// ── Middleware: verify JWT & inject tenant context ─────────
export function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No authorization token provided. Please sign in.' });
  }
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.user = decoded;
    req.userId = decoded.userId;
    req.workspaceId = decoded.workspaceId || decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

// ── POST /api/auth/signup ────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name?.trim())
      return res.status(400).json({ error: 'Please enter your full name.' });

    if (!email?.trim())
      return res.status(400).json({ error: 'Please enter your email address.' });

    const cleanEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (!password)
      return res.status(400).json({ error: 'Please enter a password.' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });

    // 1. Check if user exists in Supabase
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const cleanName = name.trim();

    const newUser = {
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      plan: 'free',
      workspace: `${cleanName.split(' ')[0]}'s Workspace`,
      contacts: 0,
      created_at: now,
      updated_at: now,
    };

    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert(newUser)
      .select()
      .single();

    if (insErr) {
      throw new Error(insErr.message || 'Failed to create user account.');
    }

    const userObj = inserted || { ...newUser, id: `u_${Date.now()}` };
    const workspaceId = await resolveUserWorkspace(userObj);

    const token = jwt.sign(
      { userId: userObj.id, email: cleanEmail, name: userObj.name, workspaceId },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      token,
      user: {
        id: userObj.id,
        name: userObj.name,
        email: cleanEmail,
        plan: userObj.plan,
        workspace: userObj.workspace,
        workspaceId,
        createdAt: now,
      },
    });
  } catch (err) {
    console.error('[SIGNUP]', err);
    res.status(500).json({ error: err.message || 'Server error. Please try again later.' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email?.trim())
      return res.status(400).json({ error: 'Please enter your email address.' });

    if (!password)
      return res.status(400).json({ error: 'Please enter your password.' });

    const cleanEmail = email.toLowerCase().trim();

    // 1. Fetch user from Supabase
    const { data: user, error: selErr } = await supabase
      .from('users')
      .select('*')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (selErr) {
      throw new Error(selErr.message || 'Database connection error.');
    }

    if (!user) {
      return res.status(404).json({ error: 'No account found with this email. Please create an account.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    const workspaceId = await resolveUserWorkspace(user);

    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, workspaceId },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan || 'free',
        workspace: user.workspace || "My Workspace",
        workspaceId,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[LOGIN]', err);
    res.status(500).json({ error: err.message || 'Server error. Please try again later.' });
  }
});

// ── POST /api/auth/google ────────────────────────────────
// Bridge Google Login via Supabase Auth into isolated tenant session
router.post('/google', async (req, res) => {
  try {
    const { email, name, supabaseToken } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required from Google account.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    let verifiedName = name || cleanEmail.split('@')[0];

    // Verify token with Supabase Auth if provided
    if (supabaseToken) {
      try {
        const { data: sbUser } = await supabase.auth.getUser(supabaseToken);
        if (sbUser?.user?.email) {
          verifiedName = sbUser.user.user_metadata?.full_name || sbUser.user.user_metadata?.name || verifiedName;
        }
      } catch (_) {}
    }

    // 1. Check if user already exists
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (!user) {
      // Create user automatically for first-time Google sign-in
      const now = new Date().toISOString();
      const randomPassword = await bcrypt.hash(`google_${Date.now()}_${Math.random()}`, 10);
      const newUser = {
        name: verifiedName,
        email: cleanEmail,
        password: randomPassword,
        plan: 'free',
        workspace: `${verifiedName.split(' ')[0]}'s Workspace`,
        contacts: 0,
        created_at: now,
        updated_at: now,
      };

      const { data: createdUser, error: insErr } = await supabase
        .from('users')
        .insert(newUser)
        .select()
        .single();

      if (insErr) throw insErr;
      user = createdUser;
    }

    // 2. Resolve or create isolated workspace for this user
    const workspaceId = await resolveUserWorkspace(user);

    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, workspaceId },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan || 'free',
        workspace: user.workspace || `${user.name}'s Workspace`,
        workspaceId,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[GOOGLE AUTH]', err);
    res.status(500).json({ error: err.message || 'Failed to authenticate with Google.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, plan, workspace, contacts, created_at')
      .eq('id', userId)
      .maybeSingle();

    if (error || !user) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const workspaceId = req.workspaceId || (await resolveUserWorkspace(user));

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan || 'free',
        workspace: user.workspace,
        workspaceId,
        contacts: user.contacts || 0,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[ME]', err);
    res.status(500).json({ error: 'Server error retrieving profile.' });
  }
});

export default router;
