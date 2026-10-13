// backend/lib/facebookDb.js — Database layer for Facebook Pages & OAuth Sessions
// Uses Supabase exclusively with in-memory caching for zero-latency lookups.
import { supabase } from './supabase.js';

// In-memory cache for fast webhook resolution without DB roundtrips
const memoryPages = new Map();
const memoryOAuthSessions = new Map();

/**
 * Save or update a connected Facebook Page / Instagram Account in Supabase
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
  metadata = {},
  linkedPageId = null,
  instagramBusinessAccountId = null,
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
  memoryPages.set(String(pageId), {
    ...pageRecord,
    metadata,
    linked_page_id: linkedPageId,
    instagram_business_account_id: instagramBusinessAccountId,
  });

  // Persist to Supabase
  try {
    const { data: existing, error: selErr } = await supabase
      .from('facebook_pages')
      .select('id')
      .eq('page_id', String(pageId))
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (!selErr) {
      // First attempt: try with enhanced columns (metadata, linked_page_id, instagram_business_account_id)
      const fullRecord = {
        ...pageRecord,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(linkedPageId ? { linked_page_id: linkedPageId } : {}),
        ...(instagramBusinessAccountId ? { instagram_business_account_id: instagramBusinessAccountId } : {}),
      };

      let saveResult;
      if (existing) {
        saveResult = await supabase
          .from('facebook_pages')
          .update(fullRecord)
          .eq('id', existing.id)
          .select()
          .single();
      } else {
        saveResult = await supabase
          .from('facebook_pages')
          .insert({ ...fullRecord, created_at: now })
          .select()
          .single();
      }

      // If failed due to missing migration columns, fallback to basic record without new columns
      if (saveResult.error && saveResult.error.message?.includes('column')) {
        console.warn('[FacebookDB] Metadata columns not yet present in DB. Saving standard fields. (Run migration 001 to enable full metadata columns)');
        if (existing) {
          saveResult = await supabase
            .from('facebook_pages')
            .update(pageRecord)
            .eq('id', existing.id)
            .select()
            .single();
        } else {
          saveResult = await supabase
            .from('facebook_pages')
            .insert({ ...pageRecord, created_at: now })
            .select()
            .single();
        }
      }

      if (!saveResult.error && saveResult.data) {
        return saveResult.data;
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
  } catch (err) {
    console.warn('[FacebookDB] Query connected pages warning:', err.message);
  }

  // 2. Fallback to memory cache
  const list = Array.from(memoryPages.values()).filter((p) => p.status === 'connected');
  if (workspaceId) {
    return list.filter((p) => p.workspace_id === workspaceId).map((p) => sanitizePage(p, includeTokens));
  }
  return list.map((p) => sanitizePage(p, includeTokens));
}

/**
 * Get a specific Facebook Page by Page ID
 * Resolves from memory cache or Supabase
 */
export async function getPageByPageId(pageId, includeToken = false) {
  if (!pageId) return null;
  const strId = String(pageId);

  // 1. Check in-memory cache first
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
  } catch (err) {
    console.warn('[FacebookDB] Get page error:', err.message);
  }

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
 * Save persistent OAuth session in Supabase & memory cache
 * Eliminates OAuth session loss on Vercel Serverless instances
 */
export async function saveOAuthSession(state, data) {
  const expiresAtMs = data?.expiresAt || (Date.now() + 15 * 60 * 1000); // 15 minutes default
  const expiresAt = new Date(expiresAtMs).toISOString();
  const payload = { ...data, state, expiresAt: expiresAtMs };

  // 1. Keep fast in-memory copy
  memoryOAuthSessions.set(state, payload);

  // 2. Persist to Supabase oauth_sessions table
  try {
    const { error } = await supabase
      .from('oauth_sessions')
      .upsert({
        state,
        session_type: data.type || 'facebook',
        workspace_id: data.workspaceId || 'default_workspace',
        redirect_uri: data.redirectUri || null,
        session_data: data,
        expires_at: expiresAt,
      }, { onConflict: 'state' });

    if (error && !error.message?.includes('does not exist') && !error.message?.includes('schema cache')) {
      console.warn('[FacebookDB] Supabase oauth_sessions save warning:', error.message);
    }
  } catch (err) {
    // If table doesn't exist yet, in-memory works as fallback
  }

  return payload;
}

/**
 * Retrieve and validate OAuth session across Vercel instances
 */
export async function getOAuthSession(state) {
  if (!state) return null;

  // 1. Try Supabase oauth_sessions table (cross-instance serverless support)
  try {
    const { data, error } = await supabase
      .from('oauth_sessions')
      .select('*')
      .eq('state', state)
      .maybeSingle();

    if (!error && data) {
      if (new Date(data.expires_at).getTime() < Date.now()) {
        // Expired session
        clearOAuthSession(state).catch(() => {});
        return null;
      }
      return {
        ...(data.session_data || {}),
        state: data.state,
        type: data.session_type,
        workspaceId: data.workspace_id,
        redirectUri: data.redirect_uri,
      };
    }
  } catch (err) {
    // Fall back to memory cache
  }

  // 2. Fallback to memory cache
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
 * Remove OAuth session after use (prevent replay attacks)
 */
export async function clearOAuthSession(state) {
  if (!state) return;
  memoryOAuthSessions.delete(state);

  try {
    await supabase.from('oauth_sessions').delete().eq('state', state);
  } catch (err) {
    // ignore
  }
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
    metadata: page.metadata || {},
    linkedPageId: page.linked_page_id || page.metadata?.linkedPageId || null,
    instagramBusinessAccountId: page.instagram_business_account_id || page.metadata?.igUserId || null,
  };

  if (includeToken) {
    copy.accessToken = page.access_token || page.accessToken;
  }

  return copy;
}
