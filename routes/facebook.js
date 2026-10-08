// backend/routes/facebook.js — Meta / Facebook + Instagram DM Integration Router
import { Router } from 'express';
import crypto from 'node:crypto';
import 'dotenv/config';
import {
  getOAuthAuthorizationUrl,
  getInstagramOAuthUrl,
  exchangeCodeForTokens,
  getUserAccounts,
  getInstagramAccounts,
  subscribePageToWebhooks,
  subscribeInstagramWebhooks,
  unsubscribePageFromWebhooks,
  getCustomerProfile,
  verifyWebhookSignature,
  sendMessengerText,
  sendInstagramDM,
  fetchPageConversations,
} from '../lib/metaGraph.js';
import {
  saveConnectedPage,
  getConnectedPages,
  getPageByPageId,
  disconnectPage,
  saveOAuthSession,
  getOAuthSession,
  clearOAuthSession,
} from '../lib/facebookDb.js';
import { supabase, upsertContact, saveMessage, updateMessageStatusByWamid } from '../lib/supabase.js';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_PORT = process.env.PORT || 5000;
const getRedirectUri = (req) => {
  if (process.env.META_OAUTH_REDIRECT_URI) {
    return process.env.META_OAUTH_REDIRECT_URI.trim();
  }
  const host = req?.get('x-forwarded-host') || req?.get('host') || `localhost:${BACKEND_PORT}`;
  const protocol = req?.get('x-forwarded-proto') || (req?.secure ? 'https' : 'http');
  return `${protocol}://${host}/api/integrations/facebook/oauth/callback`;
};

const WEBHOOK_VERIFY_TOKEN = (process.env.META_WEBHOOK_VERIFY_TOKEN || 'omniconnect_meta_verify_token_2026').trim();

/**
 * GET /api/integrations/facebook/config
 * Returns public Meta configuration (never exposes app secret or page tokens)
 */
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      appId: (process.env.META_APP_ID || '').trim() || null,
      redirectUri: getRedirectUri(req),
      webhookVerifyToken: WEBHOOK_VERIFY_TOKEN,
    },
  });
});

/**
 * GET /api/integrations/facebook/oauth/start
 * Generates secure CSRF state and returns official Meta OAuth authorization URL
 */
router.get('/oauth/start', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || 'default_workspace';
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = getRedirectUri(req);

    await saveOAuthSession(state, {
      workspaceId,
      redirectUri,
      createdAt: new Date().toISOString(),
    });

    const oauthUrl = getOAuthAuthorizationUrl({
      state,
      redirectUri,
    });

    if (req.headers.accept?.includes('application/json') || req.query.format === 'json') {
      return res.json({ success: true, oauthUrl, state });
    }

    res.redirect(oauthUrl);
  } catch (err) {
    console.error('[Meta OAuth Start Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/integrations/facebook/oauth/callback
 * Meta redirects here after user logs in and approves permissions
 */
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Handle user cancellation or Meta authorization errors
  if (error || !code) {
    console.warn('[Meta OAuth Cancelled/Error]:', error, error_description);
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Meta Authentication Failed</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h3>Meta Connection Cancelled</h3>
          <p style="color: #64748b;">${error_description || 'Authorization was cancelled or denied.'}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'META_AUTH_ERROR', error: '${error || 'cancelled'}' }, '*');
              setTimeout(() => window.close(), 1000);
            } else {
              window.location.href = '${FRONTEND_URL}/connect-facebook?error=cancelled';
            }
          </script>
        </body>
      </html>
    `);
  }

  // Validate CSRF state
  const session = await getOAuthSession(state);
  if (!session) {
    console.error('[Meta OAuth] Invalid or expired state parameter');
    return res.status(400).send('Invalid or expired OAuth session. Please try connecting again.');
  }

  try {
    // 1. Server-side exchange authorization code for long-lived user token
    const redirectUri = session.redirectUri || getRedirectUri(req);
    const tokenData = await exchangeCodeForTokens(code, redirectUri);
    const userAccessToken = tokenData.userAccessToken;

    // 2. Fetch real Facebook Pages accessible to this authorized user
    const realPages = await getUserAccounts(userAccessToken);
    console.log(`[Meta OAuth] Successfully authorized. User has ${realPages.length} accessible page(s).`);

    // 3. Store real pages and token securely in OAuth session for page selection
    await saveOAuthSession(state, {
      ...session,
      realPages,
      userAccessToken,
      authorizedAt: new Date().toISOString(),
    });

    // 4. Return HTML postMessage handler to notify popup opener or redirect
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Meta Authorization Success</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; }
            .card { background: white; padding: 28px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); text-align: center; max-width: 360px; }
            .spinner { width: 36px; height: 36px; border: 3px solid #e2e8f0; border-top-color: #0066ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
            @keyframes spin { to { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size: 44px; margin-bottom: 12px;">✅</div>
            <h3 style="margin: 0 0 8px; font-size: 18px; font-weight: 600;">Meta Connected Successfully!</h3>
            <p style="margin: 0 0 18px; font-size: 14px; color: #64748b;">Aapka Meta account link ho gaya hai.</p>
            <a id="continueBtn" href="${FRONTEND_URL}/connect-facebook?state=${state}&oauth=success"
               style="display: inline-block; background: #0066ff; color: #ffffff; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 14px;">
              Continue to OmniConnect ➔
            </a>
          </div>
          <script>
            try {
              if (window.opener) {
                window.opener.postMessage({
                  type: 'META_AUTH_SUCCESS',
                  state: '${state}',
                  pagesCount: ${realPages.length}
                }, '*');
                setTimeout(() => window.close(), 1000);
              }
            } catch (e) {}

            // Auto-redirect if popup wasn't closed by browser
            setTimeout(() => {
              try {
                if (window.opener) {
                  window.close();
                } else {
                  window.location.href = '${FRONTEND_URL}/connect-facebook?state=${state}&oauth=success';
                }
              } catch (err) {
                window.location.href = '${FRONTEND_URL}/connect-facebook?state=${state}&oauth=success';
              }
            }, 2000);
          </script>
        </body>
      </html>
    `);
  } catch (exchangeErr) {
    console.error('[Meta OAuth Token Exchange Error]:', exchangeErr.message);
    return res.status(500).send(`Authentication error: ${exchangeErr.message}`);
  }
});

/**
 * GET /api/integrations/facebook/pages
 * Retrieves connected Facebook Pages and/or available Pages from an active Meta OAuth session
 * Access tokens are NEVER exposed in response.
 */
router.get('/pages', async (req, res) => {
  try {
    const { state, workspaceId = 'default_workspace' } = req.query;

    // 1. Fetch connected pages from database
    const connectedPages = await getConnectedPages(workspaceId, false);

    // 2. If user just completed OAuth and passed state, fetch available real pages from session
    let availablePages = [];
    let hasOAuthSession = false;

    if (state) {
      const session = await getOAuthSession(state);
      if (session && Array.isArray(session.realPages)) {
        hasOAuthSession = true;
        availablePages = session.realPages.map((p) => {
          const isConnected = connectedPages.some((cp) => cp.pageId === p.id || cp.id === p.id);
          return {
            id: p.id,
            name: p.name,
            category: p.category,
            picture: p.picture,
            connected: isConnected,
          };
        });
      }
    }

    res.json({
      success: true,
      hasOAuthSession,
      connectedPages,
      availablePages,
      pages: availablePages.length > 0 ? availablePages : connectedPages,
      count: availablePages.length > 0 ? availablePages.length : connectedPages.length,
      connectedCount: connectedPages.length,
    });
  } catch (err) {
    console.error('[Facebook Get Pages Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/connect-page
 * Connects a selected real Facebook Page and subscribes it to Messenger webhooks
 * DOES NOT create fake contacts, conversations, or messages.
 */
router.post('/connect-page', async (req, res) => {
  try {
    const { pageId, state, workspaceId = 'default_workspace', userId = null } = req.body;

    if (!pageId) {
      return res.status(400).json({ success: false, error: 'pageId is required' });
    }

    // 1. Verify that the page exists in the active OAuth session or provided metadata
    let targetPage = null;
    let pageAccessToken = null;

    if (state) {
      const session = await getOAuthSession(state);
      if (session && Array.isArray(session.realPages)) {
        targetPage = session.realPages.find((p) => p.id === String(pageId));
        if (targetPage) {
          pageAccessToken = targetPage.accessToken;
        }
      }
    }

    // If no active session with this page, check if page is already known
    if (!targetPage) {
      const existing = await getPageByPageId(pageId, true);
      if (existing) {
        targetPage = existing;
        pageAccessToken = existing.accessToken;
      }
    }

    if (!targetPage || !pageAccessToken) {
      return res.status(400).json({
        success: false,
        error: 'Page access token not found. Please log in with Meta to connect this page.',
      });
    }

    // 2. Save page securely to database (token is encrypted/server-side only)
    const saved = await saveConnectedPage({
      pageId: targetPage.id || targetPage.pageId,
      pageName: targetPage.name,
      category: targetPage.category || 'Business',
      pictureUrl: targetPage.picture || targetPage.pictureUrl || null,
      accessToken: pageAccessToken,
      userId,
      workspaceId,
      status: 'connected',
      webhookStatus: 'subscribing',
    });

    // 3. Real Meta Webhook Subscription: Subscribe page to Messenger events
    const subRes = await subscribePageToWebhooks(targetPage.id || targetPage.pageId, pageAccessToken);
    const webhookStatus = subRes.success ? 'subscribed' : 'webhook_pending';

    // Update webhook status
    await saveConnectedPage({
      pageId: targetPage.id || targetPage.pageId,
      pageName: targetPage.name,
      accessToken: pageAccessToken,
      workspaceId,
      status: 'connected',
      webhookStatus,
    });

    console.log(`[Facebook Page Connected] "${targetPage.name}" (ID: ${pageId}) - Webhook: ${webhookStatus}`);

    // Automatically sync initial conversations & messages from Meta in background
    syncSinglePageChats(targetPage.id || targetPage.pageId, pageAccessToken, targetPage.name).catch((syncErr) => {
      console.warn('[Facebook Page Connect] Initial sync error:', syncErr.message);
    });

    // Return sanitized page (no token)
    res.json({
      success: true,
      message: `Facebook Page "${targetPage.name}" connected successfully!`,
      page: {
        id: targetPage.id || targetPage.pageId,
        name: targetPage.name,
        category: targetPage.category,
        picture: targetPage.picture || null,
        connected: true,
        webhookStatus,
      },
    });
  } catch (err) {
    console.error('[Facebook Connect Page Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/disconnect-page
 * Disconnects a Facebook Page and unsubscribes from webhook events
 */
router.post('/disconnect-page', async (req, res) => {
  try {
    const { pageId, workspaceId = 'default_workspace' } = req.body;
    if (!pageId) return res.status(400).json({ success: false, error: 'pageId is required' });

    // Look up page to get access token for webhook unsubscribe
    const page = await getPageByPageId(pageId, true);
    if (page && page.accessToken) {
      await unsubscribePageFromWebhooks(pageId, page.accessToken);
    }

    // Disconnect in DB
    await disconnectPage(pageId, workspaceId);

    console.log(`[Facebook Page Disconnected] Page ID: ${pageId}`);

    const remainingPages = await getConnectedPages(workspaceId, false);
    res.json({
      success: true,
      message: 'Page disconnected successfully.',
      connectedPages: remainingPages,
    });
  } catch (err) {
    console.error('[Facebook Disconnect Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/integrations/facebook/webhook
 * Meta Webhook verification handshake
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const validTokens = [
    WEBHOOK_VERIFY_TOKEN,
    process.env.META_WEBHOOK_VERIFY_TOKEN,
    'omniconnect_meta_verify_token_2026',
    'omniconnect_webhook_secret_2026',
    'omniconnect_whatsapp_verify_token_2026'
  ].filter(Boolean);

  if (mode === 'subscribe' && validTokens.includes(token)) {
    console.log('[Meta Webhook Verified Successfully]');
    return res.status(200).send(challenge);
  }

  console.warn('[Meta Webhook Verification Failed] Incorrect verify token:', token);
  return res.sendStatus(403);
});

/**
 * POST /api/integrations/facebook/webhook
 * Receives Meta Messenger (Facebook + Instagram DM) webhook events
 */
router.post('/webhook', async (req, res) => {
  try {
    // 1. Verify webhook signature if present (log warning only, do not reject)
    const sigHeader = req.headers['x-hub-signature-256'];
    if (sigHeader && !verifyWebhookSignature(sigHeader, req.rawBody || req.body)) {
      console.warn('[Meta Webhook] Signature verification warning, proceeding with event');
    }

    const body = req.body;

    // ── Facebook Messenger Events ─────────────────────────────────────────
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        const pageId = entry.id;

        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const recipientId = event.recipient?.id;
          const message = event.message;

          if (senderId && message) {
            const messageId = message.mid;
            const messageText = message.text;
            const attachments = message.attachments;

            // Idempotency check
            if (messageId) {
              const { data: existingMsg } = await supabase
                .from('messages')
                .select('id')
                .eq('whatsapp_message_id', messageId)
                .maybeSingle();

              if (existingMsg) {
                console.log(`[Meta Webhook] Duplicate FB message ${messageId} skipped.`);
                continue;
              }
            }

            const connectedPage = await getPageByPageId(pageId || recipientId, true);
            const pageName = connectedPage?.name || 'Facebook Page';
            const pageAccessToken = connectedPage?.accessToken;

            let customerName = `Facebook User ${senderId.slice(-4)}`;
            let customerAvatar = null;

            if (pageAccessToken) {
              const profile = await getCustomerProfile(senderId, pageAccessToken);
              if (profile.name) customerName = profile.name;
              if (profile.profilePic) customerAvatar = profile.profilePic;
            }

            console.log(`[Facebook Messenger] From: ${customerName} (${senderId}) — "${messageText || '[Attachment]'}"`);

            const contact = await upsertContact({
              phoneNumber: `fb_${senderId}`,
              name: customerName,
              channel: 'facebook',
              tags: ['Facebook Lead', pageName],
              metadata: { pageId: pageId || recipientId, pageName, profilePic: customerAvatar, senderPsid: senderId },
            });

            if (contact) {
              let displayContent = messageText;
              let messageType = 'text';
              if (!displayContent && attachments?.length > 0) {
                messageType = attachments[0].type || 'image';
                displayContent = attachments[0].payload?.url || `[Attachment: ${messageType}]`;
              }
              await saveMessage({
                contactId: contact.id,
                phoneNumber: `fb_${senderId}`,
                direction: 'inbound',
                messageType: messageType === 'text' ? 'text' : 'image',
                content: displayContent,
                whatsappMessageId: messageId || `fb_in_${Date.now()}`,
                status: 'delivered',
                rawPayload: event,
              });
            }
          }

          if (event.delivery?.mids) {
            for (const mid of event.delivery.mids) {
              await updateMessageStatusByWamid(mid, 'delivered');
            }
          }

          if (event.read?.watermark) {
            console.log(`[FB Read Receipt] Watermark: ${event.read.watermark}`);
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    // ── Instagram DM Events ───────────────────────────────────────────────
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        const igPageId = entry.id; // This is the Instagram Business Account ID

        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const message = event.message;

          if (senderId && message) {
            const messageId = message.mid;
            const messageText = message.text;
            const attachments = message.attachments;

            // Idempotency check
            if (messageId) {
              const { data: existingMsg } = await supabase
                .from('messages')
                .select('id')
                .eq('whatsapp_message_id', messageId)
                .maybeSingle();

              if (existingMsg) {
                console.log(`[Meta Webhook] Duplicate IG message ${messageId} skipped.`);
                continue;
              }
            }

            // Find connected Instagram account (stored as ig_<igUserId>)
            const connectedIgPage = await getPageByPageId(`ig_${igPageId}`, true);
            const igAccountName = connectedIgPage?.name || `@instagram_${igPageId.slice(-4)}`;

            console.log(`[Instagram DM] From IG User: ${senderId} — "${messageText || '[Attachment]'}"`);

            const contact = await upsertContact({
              phoneNumber: `ig_${senderId}`,
              name: `Instagram User ${senderId.slice(-4)}`,
              channel: 'instagram',
              tags: ['Instagram DM', igAccountName],
              metadata: {
                igUserId: senderId,
                igPageId,
                igAccountName,
                senderType: 'instagram',
              },
            });

            if (contact) {
              let displayContent = messageText;
              let messageType = 'text';
              if (!displayContent && attachments?.length > 0) {
                messageType = attachments[0].type || 'image';
                displayContent = attachments[0].payload?.url || `[Instagram Attachment: ${messageType}]`;
              }
              await saveMessage({
                contactId: contact.id,
                phoneNumber: `ig_${senderId}`,
                direction: 'inbound',
                messageType: messageType === 'text' ? 'text' : 'image',
                content: displayContent,
                whatsappMessageId: messageId || `ig_in_${Date.now()}`,
                status: 'delivered',
                rawPayload: event,
              });
            }
          }

          if (event.read?.watermark) {
            console.log(`[IG Read Receipt] Watermark: ${event.read.watermark}`);
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    res.sendStatus(404);
  } catch (err) {
    console.error('[Facebook/Instagram Webhook Handler Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/send-message
 * Send a direct reply to a Facebook Messenger customer (used by agent inbox)
 */
router.post('/send-message', async (req, res) => {
  try {
    const { recipientPsid, text, pageId } = req.body;

    if (!recipientPsid || !text) {
      return res.status(400).json({ success: false, error: 'recipientPsid and text are required' });
    }

    // Look up page access token
    let page = null;
    if (pageId) {
      page = await getPageByPageId(pageId, true);
    }
    if (!page || !page.accessToken) {
      const pages = await getConnectedPages(null, true);
      page = pages.find((p) => p.accessToken);
    }

    if (!page || !page.accessToken) {
      return res.status(400).json({
        success: false,
        error: 'No connected Facebook Page found. Please reconnect your Facebook Page.',
      });
    }

    const result = await sendMessengerText(page.accessToken, recipientPsid, text.trim());

    console.log(`[Facebook Direct Send] To PSID: ${recipientPsid} - Meta ID: ${result.messageId}`);

    res.json({
      success: true,
      messageId: result.messageId,
      recipientId: result.recipientId,
    });
  } catch (err) {
    console.error('[Facebook Send Message Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INSTAGRAM DM ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/integrations/facebook/instagram/oauth/start
 * Starts Instagram DM OAuth flow (requires instagram_manage_messages permission)
 */
router.get('/instagram/oauth/start', async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || 'default_workspace';
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = getRedirectUri(req);

    await saveOAuthSession(state, {
      workspaceId,
      redirectUri,
      type: 'instagram',
      createdAt: new Date().toISOString(),
    });

    const oauthUrl = getInstagramOAuthUrl({
      state,
      redirectUri,
    });

    if (req.headers.accept?.includes('application/json') || req.query.format === 'json') {
      return res.json({ success: true, oauthUrl, state });
    }

    res.redirect(oauthUrl);
  } catch (err) {
    console.error('[Instagram OAuth Start Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/integrations/facebook/instagram/oauth/callback
 * Handles OAuth callback for Instagram DM permissions
 */
router.get('/instagram/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error || !code) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Instagram Connection Failed</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
          <h3>Instagram Connection Cancelled</h3>
          <p style="color:#64748b">${error_description || 'Authorization was cancelled or denied.'}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'IG_AUTH_ERROR', error: '${error || 'cancelled'}' }, '*');
              setTimeout(() => window.close(), 1000);
            } else {
              window.location.href = '${FRONTEND_URL}/connect-instagram?error=cancelled';
            }
          </script>
        </body>
      </html>
    `);
  }

  const session = await getOAuthSession(state);
  if (!session) {
    return res.status(400).send('Invalid or expired OAuth session. Please try connecting again.');
  }

  try {
    // Exchange code for tokens
    const redirectUri = session.redirectUri || getRedirectUri(req);
    const tokenData = await exchangeCodeForTokens(code, redirectUri);
    const userAccessToken = tokenData.userAccessToken;

    // Fetch Instagram accounts linked to Facebook Pages
    const igAccounts = await getInstagramAccounts(userAccessToken);
    console.log(`[Instagram OAuth] Authorized. Found ${igAccounts.length} Instagram account(s).`);

    // Store in session
    await saveOAuthSession(state, {
      ...session,
      igAccounts,
      userAccessToken,
      type: 'instagram',
      authorizedAt: new Date().toISOString(),
    });

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Instagram Connected</title>
          <style>
            body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; background:#f8fafc; }
            .card { background:white; padding:28px; border-radius:16px; box-shadow:0 4px 12px rgba(0,0,0,0.05); text-align:center; max-width:360px; }
            .spinner { width:36px; height:36px; border:3px solid #e2e8f0; border-top-color:#E1306C; border-radius:50%; animation:spin 0.8s linear infinite; margin:0 auto 16px; }
            @keyframes spin { to { transform:rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h3 style="margin:0 0 8px;font-size:16px">Instagram Connected!</h3>
            <p style="margin:0;font-size:13px;color:#64748b">Found ${igAccounts.length} Instagram account(s). Loading...</p>
          </div>
          <script>
            try {
              if (window.opener) {
                window.opener.postMessage({
                  type: 'IG_AUTH_SUCCESS',
                  state: '${state}',
                  igCount: ${igAccounts.length}
                }, '*');
                setTimeout(() => window.close(), 600);
              } else {
                window.location.href = '${FRONTEND_URL}/connect-instagram?state=${state}&oauth=success';
              }
            } catch(e) {
              window.location.href = '${FRONTEND_URL}/connect-instagram?state=${state}&oauth=success';
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Instagram OAuth Callback Error]:', err.message);
    return res.status(500).send(`Instagram authentication error: ${err.message}`);
  }
});

/**
 * GET /api/integrations/facebook/instagram/accounts
 * List Instagram accounts available after OAuth
 */
router.get('/instagram/accounts', async (req, res) => {
  try {
    const { state } = req.query;
    let igAccounts = [];
    let hasOAuthSession = false;

    if (state) {
      const session = await getOAuthSession(state);
      if (session?.igAccounts) {
        hasOAuthSession = true;
        igAccounts = session.igAccounts.map((acc) => ({
          igUserId: acc.igUserId,
          igUsername: acc.igUsername,
          igName: acc.igName,
          igProfilePicture: acc.igProfilePicture,
          igFollowers: acc.igFollowers,
          linkedPageName: acc.linkedPageName,
          linkedPageId: acc.linkedPageId,
        }));
      }
    }

    res.json({ success: true, hasOAuthSession, igAccounts, count: igAccounts.length });
  } catch (err) {
    console.error('[Instagram Accounts Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/instagram/connect-account
 * Connect selected Instagram account and subscribe to webhooks
 */
router.post('/instagram/connect-account', async (req, res) => {
  try {
    const { igUserId, state, workspaceId = 'default_workspace', userId = null } = req.body;

    if (!igUserId) {
      return res.status(400).json({ success: false, error: 'igUserId is required' });
    }

    // Get from OAuth session
    let targetAccount = null;
    if (state) {
      const session = await getOAuthSession(state);
      if (session?.igAccounts) {
        targetAccount = session.igAccounts.find((acc) => acc.igUserId === String(igUserId));
      }
    }

    if (!targetAccount || !targetAccount.pageAccessToken) {
      return res.status(400).json({
        success: false,
        error: 'Instagram account not found in session. Please reconnect via Meta OAuth.',
      });
    }

    // Save as a connected page (channel: instagram) using existing facebookDb
    const saved = await saveConnectedPage({
      pageId: `ig_${targetAccount.igUserId}`,
      pageName: `@${targetAccount.igUsername}`,
      category: 'Instagram',
      pictureUrl: targetAccount.igProfilePicture || null,
      accessToken: targetAccount.pageAccessToken,
      userId,
      workspaceId,
      status: 'connected',
      webhookStatus: 'subscribing',
    });

    // Subscribe linked Facebook Page to Instagram DM webhooks
    const subRes = await subscribeInstagramWebhooks(
      targetAccount.linkedPageId,
      targetAccount.pageAccessToken
    );
    const webhookStatus = subRes.success ? 'subscribed' : 'webhook_pending';

    // Update webhook status
    await saveConnectedPage({
      pageId: `ig_${targetAccount.igUserId}`,
      pageName: `@${targetAccount.igUsername}`,
      accessToken: targetAccount.pageAccessToken,
      workspaceId,
      status: 'connected',
      webhookStatus,
    });

    console.log(`[Instagram Connected] @${targetAccount.igUsername} (IG ID: ${targetAccount.igUserId}) - Webhook: ${webhookStatus}`);

    res.json({
      success: true,
      message: `Instagram @${targetAccount.igUsername} connected successfully!`,
      account: {
        igUserId: targetAccount.igUserId,
        igUsername: targetAccount.igUsername,
        igProfilePicture: targetAccount.igProfilePicture,
        linkedPageName: targetAccount.linkedPageName,
        connected: true,
        webhookStatus,
      },
    });
  } catch (err) {
    console.error('[Instagram Connect Account Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/instagram/send-message
 * Send Instagram DM reply to a customer
 */
router.post('/instagram/send-message', async (req, res) => {
  try {
    const { recipientIgUserId, text, igUserId } = req.body;

    if (!recipientIgUserId || !text) {
      return res.status(400).json({ success: false, error: 'recipientIgUserId and text are required' });
    }

    // Look up the page access token for this Instagram account
    let page = null;
    if (igUserId) {
      page = await getPageByPageId(`ig_${igUserId}`, true);
    }
    if (!page?.accessToken) {
      const pages = await getConnectedPages(null, true);
      page = pages.find((p) => p.pageId?.startsWith('ig_') && p.accessToken);
    }

    if (!page?.accessToken) {
      return res.status(400).json({
        success: false,
        error: 'No connected Instagram account found. Please reconnect your Instagram account.',
      });
    }

    const result = await sendInstagramDM(page.accessToken, recipientIgUserId, text.trim());

    console.log(`[Instagram DM Sent] To IG User: ${recipientIgUserId} - Meta ID: ${result.messageId}`);

    res.json({
      success: true,
      messageId: result.messageId,
      recipientId: result.recipientId,
    });
  } catch (err) {
    console.error('[Instagram Send DM Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Helper to sync conversations and messages from Meta Graph API for a Page
 */
export async function syncSinglePageChats(pageId, pageAccessToken, pageName = 'Facebook Page') {
  try {
    const conversations = await fetchPageConversations(pageId, pageAccessToken);
    let syncedCount = 0;

    for (const conv of conversations) {
      const participants = conv.participants?.data || [];
      const customer = participants.find((p) => String(p.id) !== String(pageId));
      if (!customer?.id) continue;

      const customerId = String(customer.id);
      const customerName = customer.name || `Facebook User ${customerId.slice(-4)}`;

      const contact = await upsertContact({
        phoneNumber: `fb_${customerId}`,
        name: customerName,
        channel: 'facebook',
        tags: ['Facebook Lead', pageName],
        metadata: {
          pageId: String(pageId),
          pageName,
          senderPsid: customerId,
        },
      });

      if (!contact) continue;

      const messages = (conv.messages?.data || []).slice().reverse(); // oldest first
      for (const msg of messages) {
        if (!msg.id) continue;

        // Check if message already exists
        const { data: existingMsg } = await supabase
          .from('messages')
          .select('id')
          .eq('whatsapp_message_id', msg.id)
          .maybeSingle();

        if (existingMsg) continue;

        const isFromCustomer = String(msg.from?.id) === customerId;
        await saveMessage({
          contactId: contact.id,
          phoneNumber: `fb_${customerId}`,
          direction: isFromCustomer ? 'inbound' : 'outbound',
          messageType: 'text',
          content: msg.message || '[Attachment]',
          whatsappMessageId: msg.id,
          status: 'delivered',
        });
        syncedCount++;
      }
    }

    console.log(`[Facebook Sync] Synced ${syncedCount} message(s) for page "${pageName}" (${pageId})`);
    return { success: true, syncedCount };
  } catch (err) {
    console.error(`[Facebook Sync Error] Page ${pageId}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * POST /api/integrations/facebook/sync
 * Manually or automatically trigger sync of existing chats from Meta Graph API
 */
router.all('/sync', async (req, res) => {
  try {
    const { workspaceId = 'default_workspace', pageId } = { ...req.query, ...req.body };
    const connectedPages = await getConnectedPages(workspaceId, true);

    const pagesToSync = pageId
      ? connectedPages.filter((p) => String(p.pageId || p.id) === String(pageId))
      : connectedPages;

    if (pagesToSync.length === 0) {
      return res.json({
        success: true,
        message: 'No connected Facebook pages found to sync.',
        syncedCount: 0,
      });
    }

    let totalSynced = 0;
    const results = [];

    for (const page of pagesToSync) {
      if (!page.accessToken) continue;
      const r = await syncSinglePageChats(page.pageId || page.id, page.accessToken, page.name || page.pageName);
      if (r.success) {
        totalSynced += r.syncedCount || 0;
      }
      results.push({ pageId: page.pageId || page.id, pageName: page.name, ...r });
    }

    res.json({
      success: true,
      message: `Successfully synced ${totalSynced} message(s) from Meta.`,
      totalSynced,
      results,
    });
  } catch (err) {
    console.error('[Facebook Sync Route Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
