// backend/routes/salesforce.js — Salesforce OAuth 2.0 Authorization Code Flow
// Enterprise Security Hardened: Exact Origins, Mutual Token Revocation, Concurrent Refresh Locks
import { Router } from 'express';
import crypto from 'node:crypto';
import axios from 'axios';
import 'dotenv/config';
import { requireAuth } from './auth.js';
import { saveOAuthSession, getOAuthSession, clearOAuthSession } from '../lib/facebookDb.js';
import {
  saveSalesforceConnection,
  getSalesforceConnection,
  getSalesforceTokens,
  updateSalesforceTokens,
  disconnectSalesforce,
} from '../lib/salesforceDb.js';
import { validateEncryptionKey } from '../lib/cryptoUtils.js';

const router = Router();

// ── Environment validation ──────────────────────────────────────────────────
function validateEnv() {
  const required = [
    'SALESFORCE_CLIENT_ID',
    'SALESFORCE_CLIENT_SECRET',
    'SALESFORCE_CALLBACK_URL',
    'SALESFORCE_TOKEN_ENCRYPTION_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`[Salesforce] Missing required environment variables: ${missing.join(', ')}`);
  }
  if (!validateEncryptionKey()) {
    throw new Error('[Salesforce] SALESFORCE_TOKEN_ENCRYPTION_KEY is invalid (must decode to 32 bytes).');
  }
}

// Allowed frontend origins for secure postMessage communication (NO wildcard *)
function resolveTrustedOrigin(req, session = null) {
  const allowed = [
    process.env.FRONTEND_URL,
    'https://backendomniconnect.vercel.app',
    'https://omniconnect.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ].filter(Boolean).map((u) => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  }).filter(Boolean);

  // 1. If origin was captured during the initiating /connect request
  if (session?.clientOrigin && allowed.includes(session.clientOrigin)) {
    return session.clientOrigin;
  }

  // 2. If present in current request headers
  const reqOrigin = req.headers?.origin || (req.headers?.referer ? new URL(req.headers.referer).origin : null);
  if (reqOrigin && allowed.includes(reqOrigin)) {
    return reqOrigin;
  }

  // 3. Fallback to FRONTEND_URL or default production domain
  if (process.env.FRONTEND_URL) {
    try {
      return new URL(process.env.FRONTEND_URL).origin;
    } catch {}
  }

  return 'https://backendomniconnect.vercel.app';
}

// Salesforce OAuth endpoints — support both production and sandbox
const getSalesforceLoginUrl = () => {
  return process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
};

// ── GET /api/integrations/salesforce/connect ────────────────────────────────
// Initiates Salesforce OAuth. Only authenticated users may start OAuth.
// workspaceId is taken exclusively from verified JWT (req.workspaceId).
router.get('/connect', requireAuth, async (req, res) => {
  try {
    validateEnv();

    const workspaceId = req.workspaceId;
    const userId = req.userId;

    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'Workspace context could not be resolved from session.' });
    }

    // Determine trusted frontend origin initiating this OAuth request
    const clientOrigin = resolveTrustedOrigin(req);

    // Generate cryptographically secure CSRF state token
    const state = crypto.randomBytes(24).toString('hex');
    const callbackUrl = process.env.SALESFORCE_CALLBACK_URL.trim();

    // Persist OAuth session in Supabase (survives Vercel cold starts)
    await saveOAuthSession(state, {
      workspaceId,
      userId,
      clientOrigin,
      type: 'salesforce',
      redirectUri: callbackUrl,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    const loginUrl = getSalesforceLoginUrl();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.SALESFORCE_CLIENT_ID.trim(),
      redirect_uri: callbackUrl,
      state,
      scope: 'api refresh_token offline_access',
    });

    const oauthUrl = `${loginUrl}/services/oauth2/authorize?${params.toString()}`;

    // Return JSON for popup-based flows; redirect for direct flows
    if (req.headers.accept?.includes('application/json') || req.query.format === 'json') {
      return res.json({ success: true, oauthUrl, state });
    }

    res.redirect(oauthUrl);
  } catch (err) {
    console.error('[Salesforce OAuth Connect]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/integrations/salesforce/oauth/callback ─────────────────────────
// Public endpoint. Salesforce redirects here with ?code=&state=
// Validates state (CSRF), exchanges code for tokens, stores encrypted tokens.
// Cannot accept an arbitrary workspace ID: workspaceId is strictly read from verified state session.
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Handle user cancellation or Salesforce errors before state check
  if (error || !code) {
    console.warn('[Salesforce OAuth Cancelled]:', error, error_description);
    const targetOrigin = resolveTrustedOrigin(req);
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Salesforce Connection Failed</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h3>Salesforce Connection Cancelled</h3>
          <p style="color:#64748b;">${error_description || 'Authorization was cancelled or denied.'}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'SALESFORCE_AUTH_ERROR', error: '${error || 'cancelled'}' }, '${targetOrigin}');
              setTimeout(() => window.close(), 1500);
            } else {
              window.location.href = '${targetOrigin}/settings?tab=integrations&error=sf_cancelled';
            }
          </script>
        </body>
      </html>
    `);
  }

  // ── Validate CSRF state ──────────────────────────────────────────────────
  if (!state) {
    return res.status(400).send('Missing OAuth state parameter.');
  }

  const session = await getOAuthSession(state);
  if (!session) {
    console.error('[Salesforce OAuth] Invalid or expired state parameter:', state);
    return res.status(400).send('Invalid or expired OAuth session. Please try connecting again.');
  }

  if (session.type !== 'salesforce') {
    return res.status(400).send('OAuth session type mismatch.');
  }

  // Workspace ID is strictly bound to the session created by authenticated user
  const workspaceId = session.workspaceId;
  const userId = session.userId;
  const targetOrigin = resolveTrustedOrigin(req, session);

  try {
    validateEnv();

    const loginUrl = getSalesforceLoginUrl();
    const callbackUrl = process.env.SALESFORCE_CALLBACK_URL.trim();

    // ── Exchange authorization code for tokens (server-side only) ───────────
    const tokenResponse = await axios.post(
      `${loginUrl}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.SALESFORCE_CLIENT_ID.trim(),
        client_secret: process.env.SALESFORCE_CLIENT_SECRET.trim(),
        redirect_uri: callbackUrl,
        code,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      instance_url: instanceUrl,
      token_type: tokenType,
      issued_at: issuedAt,
      id: identityUrl,
    } = tokenResponse.data;

    if (!accessToken || !refreshToken) {
      throw new Error('Salesforce did not return both access_token and refresh_token. Ensure offline_access scope is enabled.');
    }

    // ── Verify Salesforce identity and retrieve org info ─────────────────────
    let orgId = null;
    try {
      const identityRes = await axios.get(identityUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      });
      orgId = identityRes.data?.organization_id || null;
    } catch (idErr) {
      console.warn('[Salesforce] Could not fetch org identity:', idErr.message);
    }

    // ── Consume OAuth session (strictly single-use to prevent replay attacks) ─
    await clearOAuthSession(state);

    // ── Store encrypted tokens in Supabase via service-role client ────────────
    await saveSalesforceConnection({
      workspaceId,
      userId,
      orgId,
      instanceUrl,
      accessToken,
      refreshToken,
      tokenType: tokenType || 'Bearer',
      issuedAt: issuedAt ? String(issuedAt) : null,
    });

    console.log(`[Salesforce] Connected workspace ${workspaceId} to org ${orgId || 'unknown'} at ${instanceUrl}`);

    // ── Return success page that postMessages strictly to targetOrigin ────────
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Salesforce Connected</title>
          <style>
            body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;}
            .card{background:white;padding:28px;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.08);text-align:center;max-width:380px;}
            .icon{font-size:40px;margin-bottom:12px;}
            h3{margin:0 0 8px;font-size:16px;color:#0f172a;}
            p{margin:0;font-size:13px;color:#64748b;}
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">☁️</div>
            <h3>Salesforce Connected!</h3>
            <p>Your Salesforce CRM has been successfully connected to OmniConnect.</p>
          </div>
          <script>
            const payload = {
              type: 'SALESFORCE_CONNECTED',
              orgId: '${orgId || ''}',
              instanceUrl: '${instanceUrl}',
            };
            if (window.opener) {
              try { window.opener.postMessage(payload, '${targetOrigin}'); } catch(e) {}
              setTimeout(() => window.close(), 1800);
            } else {
              setTimeout(() => {
                window.location.href = '${targetOrigin}/settings?tab=integrations&sf=connected';
              }, 1800);
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Salesforce OAuth Callback Error]:', err.response?.data || err.message);
    await clearOAuthSession(state).catch(() => {});

    const errMsg = err.response?.data?.error_description || err.message || 'Authorization failed';
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Salesforce Connection Failed</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h3 style="color:#dc2626;">Connection Failed</h3>
          <p style="color:#64748b;">${errMsg}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'SALESFORCE_AUTH_ERROR', error: 'token_exchange_failed' }, '${targetOrigin}');
              setTimeout(() => window.close(), 2000);
            } else {
              window.location.href = '${targetOrigin}/settings?tab=integrations&error=sf_failed';
            }
          </script>
        </body>
      </html>
    `);
  }
});

// ── GET /api/integrations/salesforce/status ─────────────────────────────────
// Returns connection status for the authenticated workspace.
// Never returns tokens or cryptographic materials.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const connection = await getSalesforceConnection(workspaceId);

    if (!connection) {
      return res.json({ success: true, connected: false });
    }

    return res.json({
      success: true,
      connected: true,
      orgId: connection.org_id,
      instanceUrl: connection.instance_url,
      connectedAt: connection.connected_at,
    });
  } catch (err) {
    console.error('[Salesforce Status]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve Salesforce connection status.' });
  }
});

// ── POST /api/integrations/salesforce/disconnect ─────────────────────────────
// Revokes Salesforce connection for the authenticated workspace only.
// Revokes refresh_token (which revokes full grant on Salesforce) and deletes stored credentials.
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    validateEnv();
    const workspaceId = req.workspaceId;

    const existing = await getSalesforceConnection(workspaceId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'No active Salesforce connection found for this workspace.' });
    }

    // Revoke refresh token (revokes entire OAuth session at Salesforce)
    try {
      const tokens = await getSalesforceTokens(workspaceId);
      const tokenToRevoke = tokens?.refreshToken || tokens?.accessToken;
      if (tokenToRevoke) {
        const loginUrl = getSalesforceLoginUrl();
        await axios.post(
          `${loginUrl}/services/oauth2/revoke`,
          new URLSearchParams({ token: tokenToRevoke }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
        );
        console.log(`[Salesforce] Revoked grant on Salesforce for workspace ${workspaceId}`);
      }
    } catch (revokeErr) {
      console.warn('[Salesforce] Token revocation warning (non-fatal):', revokeErr.message);
    }

    // Completely remove stored credentials from database
    const success = await disconnectSalesforce(workspaceId);
    if (!success) {
      throw new Error('Failed to remove Salesforce connection from database.');
    }

    return res.json({ success: true, message: 'Salesforce CRM disconnected and credentials erased.' });
  } catch (err) {
    console.error('[Salesforce Disconnect]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Internal Token Refresh with Concurrent Lock Protection ──────────────────
const refreshLocks = new Map();

/**
 * Refresh Salesforce access token using stored refresh token.
 * Protected against race conditions using per-workspace refresh deduplication lock.
 */
export async function refreshSalesforceToken(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId required for token refresh');

  if (refreshLocks.has(workspaceId)) {
    return refreshLocks.get(workspaceId);
  }

  const refreshPromise = (async () => {
    try {
      const tokens = await getSalesforceTokens(workspaceId);
      if (!tokens?.refreshToken) {
        throw new Error('No refresh token available. User must reconnect Salesforce.');
      }

      validateEnv();
      const loginUrl = getSalesforceLoginUrl();

      const response = await axios.post(
        `${loginUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.SALESFORCE_CLIENT_ID.trim(),
          client_secret: process.env.SALESFORCE_CLIENT_SECRET.trim(),
          refresh_token: tokens.refreshToken,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        }
      );

      const { access_token: newAccessToken, refresh_token: newRefreshToken, issued_at: issuedAt } = response.data;
      if (!newAccessToken) throw new Error('Salesforce token refresh did not return a new access token.');

      // Update access token and rotated refresh token if provided
      await updateSalesforceTokens(workspaceId, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken || null,
        issuedAt: issuedAt ? String(issuedAt) : null,
      });

      console.log(`[Salesforce] Token refreshed for workspace ${workspaceId}`);
      return newAccessToken;
    } finally {
      refreshLocks.delete(workspaceId);
    }
  })();

  refreshLocks.set(workspaceId, refreshPromise);
  return refreshPromise;
}

export default router;
