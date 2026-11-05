// backend/lib/salesforceDb.js — Database layer for Salesforce OAuth connections
// Uses Supabase Service-Role client exclusively with AES-256-GCM encrypted token storage.
import { supabaseAdmin } from './supabase.js';
import { encryptToken, decryptToken } from './cryptoUtils.js';

const TABLE = 'salesforce_connections';

/**
 * Save or update a Salesforce connection for a workspace.
 * Tokens are encrypted at rest with separate IV and authentication tags.
 * Only the Supabase service-role client is used.
 */
export async function saveSalesforceConnection({
  workspaceId,
  userId = null,
  orgId = null,
  instanceUrl,
  accessToken,
  refreshToken,
  tokenType = 'Bearer',
  issuedAt = null,
}) {
  if (!workspaceId) throw new Error('[SalesforceDB] workspaceId is required');
  if (!instanceUrl) throw new Error('[SalesforceDB] instanceUrl is required');
  if (!accessToken) throw new Error('[SalesforceDB] accessToken is required');
  if (!refreshToken) throw new Error('[SalesforceDB] refreshToken is required');

  const encryptedAccess = encryptToken(accessToken);
  const encryptedRefresh = encryptToken(refreshToken);
  const now = new Date().toISOString();

  const record = {
    workspace_id: workspaceId,
    user_id: userId,
    org_id: orgId,
    instance_url: instanceUrl,
    access_token_encrypted: encryptedAccess.ciphertext,
    refresh_token_encrypted: encryptedRefresh.ciphertext,
    access_token_iv: encryptedAccess.iv,
    access_token_tag: encryptedAccess.tag,
    refresh_token_iv: encryptedRefresh.iv,
    refresh_token_tag: encryptedRefresh.tag,
    token_type: tokenType,
    issued_at: issuedAt,
    status: 'connected',
    updated_at: now,
  };

  try {
    const { data: existing } = await supabaseAdmin
      .from(TABLE)
      .select('id')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update(record)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return sanitizeConnection(data);
    } else {
      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .insert({ ...record, connected_at: now })
        .select()
        .single();
      if (error) throw error;
      return sanitizeConnection(data);
    }
  } catch (err) {
    console.error('[SalesforceDB] saveSalesforceConnection error:', err.message);
    throw err;
  }
}

/**
 * Get the Salesforce connection status for a workspace.
 * Never returns decrypted tokens or IVs.
 */
export async function getSalesforceConnection(workspaceId) {
  if (!workspaceId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select('id, workspace_id, user_id, org_id, instance_url, token_type, status, connected_at, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'connected')
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (err) {
    console.error('[SalesforceDB] getSalesforceConnection error:', err.message);
    return null;
  }
}

/**
 * Get decrypted tokens for a workspace — SERVER-SIDE USE ONLY.
 * Never expose returned tokens to API responses or logs.
 */
export async function getSalesforceTokens(workspaceId) {
  if (!workspaceId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('status', 'connected')
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const accessToken = decryptToken({
      ciphertext: data.access_token_encrypted,
      iv: data.access_token_iv,
      tag: data.access_token_tag,
    });
    const refreshToken = decryptToken({
      ciphertext: data.refresh_token_encrypted,
      iv: data.refresh_token_iv,
      tag: data.refresh_token_tag,
    });
    return {
      accessToken,
      refreshToken,
      instanceUrl: data.instance_url,
      tokenType: data.token_type,
      orgId: data.org_id,
    };
  } catch (err) {
    console.error('[SalesforceDB] getSalesforceTokens error:', err.message);
    return null;
  }
}

/**
 * Update access token (and optional rotated refresh token) after a refresh operation.
 */
export async function updateSalesforceTokens(workspaceId, { accessToken, refreshToken = null, issuedAt = null }) {
  if (!workspaceId || !accessToken) return false;
  try {
    const encryptedAccess = encryptToken(accessToken);
    const updates = {
      access_token_encrypted: encryptedAccess.ciphertext,
      access_token_iv: encryptedAccess.iv,
      access_token_tag: encryptedAccess.tag,
      issued_at: issuedAt,
      updated_at: new Date().toISOString(),
    };

    if (refreshToken) {
      const encryptedRefresh = encryptToken(refreshToken);
      updates.refresh_token_encrypted = encryptedRefresh.ciphertext;
      updates.refresh_token_iv = encryptedRefresh.iv;
      updates.refresh_token_tag = encryptedRefresh.tag;
    }

    const { error } = await supabaseAdmin
      .from(TABLE)
      .update(updates)
      .eq('workspace_id', workspaceId)
      .eq('status', 'connected');
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('[SalesforceDB] updateSalesforceTokens error:', err.message);
    return false;
  }
}

/**
 * Backward compatibility alias for single token update.
 */
export async function updateSalesforceAccessToken(workspaceId, newAccessToken, issuedAt = null) {
  return updateSalesforceTokens(workspaceId, { accessToken: newAccessToken, issuedAt });
}

/**
 * Disconnect / revoke a Salesforce connection for a workspace.
 * Completely deletes the record from salesforce_connections to erase all stored credentials.
 */
export async function disconnectSalesforce(workspaceId) {
  if (!workspaceId) return false;
  try {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .delete()
      .eq('workspace_id', workspaceId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('[SalesforceDB] disconnectSalesforce error:', err.message);
    return false;
  }
}

function sanitizeConnection(record) {
  if (!record) return null;
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    orgId: record.org_id,
    instanceUrl: record.instance_url,
    status: record.status,
    connectedAt: record.connected_at,
    updatedAt: record.updated_at,
  };
}
