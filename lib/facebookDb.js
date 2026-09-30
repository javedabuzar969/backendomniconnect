// backend/lib/facebookDb.js — Database layer for Facebook Pages & OAuth Sessions
// Seamlessly persists to Supabase (if facebook_pages table exists) with MongoDB fallback.
import { supabase } from './supabase.js';
import getClient from './mongodb.js';

const DB_NAME = 'omniconnect';
const MONGO_COLLECTION = 'facebook_pages';
const SESSIONS_COLLECTION = 'meta_oauth_sessions';

// In-memory cache for fast OAuth state resolution and pending pages
const memoryOAuthSessions = new Map();

/**
 * Save or update a connected Facebook Page
 */
export async function saveConnectedPage({
  pageId,
  pageName,
  category = 'Business',
  pictureUrl = null,
  accessToken,
  userId = null,
  workspaceId = 'default_workspace',
  status = 'connected',
  webhookStatus = 'subscribed',
}) {
  const now = new Date().toISOString();
  const pageRecord = {
    page_id: String(pageId),
    page_name: pageName,
    category,
    picture_url: pictureUrl,
    access_token: accessToken,
    user_id: userId,
    workspace_id: workspaceId,
    status,
    webhook_status: webhookStatus,
    updated_at: now,
  };

  // 1. Try Supabase
  try {
    const { data: existing, error: selErr } = await supabase
      .from('facebook_pages')
      .select('id')
      .eq('page_id', String(pageId))
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (!selErr) {
      if (existing) {
        const { data, error } = await supabase
          .from('facebook_pages')
          .update(pageRecord)
          .eq('id', existing.id)
          .select()
          .single();
        if (!error && data) return data;
      } else {
        const { data, error } = await supabase
          .from('facebook_pages')
          .insert({ ...pageRecord, created_at: now })
          .select()
          .single();
        if (!error && data) return data;
      }
    }
  } catch (err) {
    // Supabase table might not exist yet, fallback to MongoDB
  }

  // 2. Fallback to MongoDB
  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(MONGO_COLLECTION);
    await col.updateOne(
      { page_id: String(pageId), workspace_id: workspaceId },
      {
        $set: pageRecord,
        $setOnInsert: { created_at: now },
      },
      { upsert: true }
    );
    return pageRecord;
  } catch (mongoErr) {
    console.error('[FacebookDB] Error saving connected page in MongoDB:', mongoErr.message);
    throw mongoErr;
  }
}

/**
 * Get connected Facebook Pages for a workspace
 * Sensitive access_token is stripped by default
 */
export async function getConnectedPages(workspaceId = null, includeTokens = false) {
  // 1. Try Supabase
  try {
    let query = supabase.from('facebook_pages').select('*').eq('status', 'connected');
    if (workspaceId) query = query.eq('workspace_id', workspaceId);

    const { data, error } = await query;
    if (!error && Array.isArray(data)) {
      return data.map((p) => sanitizePage(p, includeTokens));
    }
  } catch {}

  // 2. Fallback to MongoDB
  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(MONGO_COLLECTION);
    const filter = { status: 'connected' };
    if (workspaceId) filter.workspace_id = workspaceId;

    const list = await col.find(filter).toArray();
    return list.map((p) => sanitizePage(p, includeTokens));
  } catch (mongoErr) {
    console.error('[FacebookDB] Error fetching connected pages:', mongoErr.message);
    return [];
  }
}

/**
 * Get a specific Facebook Page by Page ID
 */
export async function getPageByPageId(pageId, includeToken = false) {
  if (!pageId) return null;

  // 1. Try Supabase
  try {
    const { data, error } = await supabase
      .from('facebook_pages')
      .select('*')
      .eq('page_id', String(pageId))
      .maybeSingle();

    if (!error && data) {
      return sanitizePage(data, includeToken);
    }
  } catch {}

  // 2. Fallback to MongoDB
  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(MONGO_COLLECTION);
    const record = await col.findOne({ page_id: String(pageId) });
    if (record) return sanitizePage(record, includeToken);
  } catch (mongoErr) {
    console.error('[FacebookDB] Error finding page in MongoDB:', mongoErr.message);
  }

  return null;
}

/**
 * Disconnect a Facebook Page
 */
export async function disconnectPage(pageId, workspaceId = null) {
  const filter = { page_id: String(pageId) };
  if (workspaceId) filter.workspace_id = workspaceId;

  // 1. Try Supabase
  try {
    let query = supabase.from('facebook_pages').update({ status: 'disconnected' }).eq('page_id', String(pageId));
    if (workspaceId) query = query.eq('workspace_id', workspaceId);
    await query;
  } catch {}

  // 2. MongoDB
  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(MONGO_COLLECTION);
    await col.updateOne(filter, { $set: { status: 'disconnected', updated_at: new Date().toISOString() } });
    return true;
  } catch (err) {
    console.error('[FacebookDB] Disconnect error:', err.message);
    return false;
  }
}

/**
 * Save temporary OAuth session for state verification and pending page selection
 */
export async function saveOAuthSession(state, data) {
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
  const payload = { ...data, state, expiresAt };
  memoryOAuthSessions.set(state, payload);

  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(SESSIONS_COLLECTION);
    await col.updateOne({ state }, { $set: payload }, { upsert: true });
  } catch {}

  return payload;
}

/**
 * Retrieve and validate OAuth session
 */
export async function getOAuthSession(state) {
  if (!state) return null;

  // Check in-memory
  const mem = memoryOAuthSessions.get(state);
  if (mem) {
    if (Date.now() > mem.expiresAt) {
      memoryOAuthSessions.delete(state);
      return null;
    }
    return mem;
  }

  // Check MongoDB
  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(SESSIONS_COLLECTION);
    const session = await col.findOne({ state });
    if (session) {
      if (Date.now() > session.expiresAt) {
        await col.deleteOne({ state });
        return null;
      }
      return session;
    }
  } catch {}

  return null;
}

/**
 * Remove OAuth session after use
 */
export async function clearOAuthSession(state) {
  if (!state) return;
  memoryOAuthSessions.delete(state);
  try {
    const client = await getClient();
    const col = client.db(DB_NAME).collection(SESSIONS_COLLECTION);
    await col.deleteOne({ state });
  } catch {}
}

/**
 * Remove sensitive tokens from page object before sending to callers
 */
function sanitizePage(page, includeToken) {
  if (!page) return null;
  const copy = {
    id: page.page_id || page.id,
    pageId: page.page_id || page.id,
    name: page.page_name || page.name,
    category: page.category || 'Business',
    picture: page.picture_url || page.picture || null,
    status: page.status || 'connected',
    connected: page.status === 'connected',
    webhookStatus: page.webhook_status || 'subscribed',
    connectedAt: page.created_at || page.connectedAt || null,
  };

  if (includeToken) {
    copy.accessToken = page.access_token || page.accessToken;
  }

  return copy;
}
