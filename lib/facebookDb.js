// backend/lib/facebookDb.js — Database layer for Facebook Pages & OAuth Sessions
// Uses Supabase exclusively with in-memory caching for zero-latency serverless lookups.
import { supabase } from './supabase.js';

// In-memory cache for ultra-fast webhook resolution without DB roundtrips
const memoryPages = new Map();
const memoryOAuthSessions = new Map();

// Seed known connected page into memory cache as fallback
memoryPages.set('1297933293411171', {
  page_id: '1297933293411171',
  page_name: 'Omniconnect',
  category: 'Business',
  picture_url: null,
  access_token: 'EAAZApxiiwRtkBSiYCRjfjR8ysjiTnROfuiwxndx3aNqXeHFZCY2ObJO5T6Tc7XUr6KJr6cHP5ROsEIYyZADr2ZAhdGtZCF5TD0iB96ExwM6fktIv5CTZAZBTMadQKEqxJHDAJj3O7yearVwFuTQwCZB2Xrg9SC9ZBt37inaKkPk4Y5yRyUctjKZBAn4GoB7We98hMuC4lY',
  workspace_id: 'default_workspace',
  status: 'connected',
  webhook_status: 'subscribed',
  created_at: '2026-10-08T00:35:15.903Z',
  updated_at: new Date().toISOString(),
});

/**
 * Save or update a connected Facebook Page in Supabase
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

  // Cache in memory immediately
  memoryPages.set(String(pageId), pageRecord);

  // Persist to Supabase
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
    console.warn('[FacebookDB] Supabase save warning:', err.message);
  }

  return pageRecord;
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
    if (!error && Array.isArray(data) && data.length > 0) {
      data.forEach((p) => memoryPages.set(String(p.page_id), p));
      return data.map((p) => sanitizePage(p, includeTokens));
    }
  } catch {}

  // 2. Fallback to memory cache
  const list = Array.from(memoryPages.values()).filter((p) => p.status === 'connected');
  if (workspaceId) {
    return list.filter((p) => p.workspace_id === workspaceId).map((p) => sanitizePage(p, includeTokens));
  }
  return list.map((p) => sanitizePage(p, includeTokens));
}

/**
 * Get a specific Facebook Page by Page ID
 * Resolves in microseconds from memory cache or Supabase
 */
export async function getPageByPageId(pageId, includeToken = false) {
  if (!pageId) return null;
  const strId = String(pageId);

  // 1. Check in-memory cache first (instant response)
  const cached = memoryPages.get(strId);
  if (cached) {
    return sanitizePage(cached, includeToken);
  }

  // 2. Query Supabase
  try {
    const { data, error } = await supabase
      .from('facebook_pages')
      .select('*')
      .eq('page_id', strId)
      .maybeSingle();

    if (!error && data) {
      memoryPages.set(strId, data);
      return sanitizePage(data, includeToken);
    }
  } catch {}

  return null;
}

/**
 * Disconnect a Facebook Page
 */
export async function disconnectPage(pageId, workspaceId = null) {
  const strId = String(pageId);
  const mem = memoryPages.get(strId);
  if (mem) {
    mem.status = 'disconnected';
    mem.updated_at = new Date().toISOString();
  }

  try {
    let query = supabase.from('facebook_pages').update({ status: 'disconnected' }).eq('page_id', strId);
    if (workspaceId) query = query.eq('workspace_id', workspaceId);
    await query;
    return true;
  } catch (err) {
    console.error('[FacebookDB] Supabase disconnect error:', err.message);
    return false;
  }
}

/**
 * Save temporary OAuth session for state verification
 */
export async function saveOAuthSession(state, data) {
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
  const payload = { ...data, state, expiresAt };
  memoryOAuthSessions.set(state, payload);
  return payload;
}

/**
 * Retrieve and validate OAuth session
 */
export async function getOAuthSession(state) {
  if (!state) return null;
  const mem = memoryOAuthSessions.get(state);
  if (mem) {
    if (Date.now() > mem.expiresAt) {
      memoryOAuthSessions.delete(state);
      return null;
    }
    return mem;
  }
  return null;
}

/**
 * Remove OAuth session after use
 */
export async function clearOAuthSession(state) {
  if (!state) return;
  memoryOAuthSessions.delete(state);
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
