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
  getInstagramUserProfile,
  verifyWebhookSignature,
  sendMessengerText,
  sendInstagramDM,
  fetchPageConversations,
  fetchInstagramConversations,
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
import { requireAuth } from './auth.js';
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

const FB_APP_ID = (process.env.FB_APP_ID || process.env.META_APP_ID || '').trim();
const FB_APP_SECRET = (process.env.FB_APP_SECRET || process.env.META_APP_SECRET || '').trim();
const WEBHOOK_VERIFY_TOKEN = (process.env.FB_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN || '').trim();

if (!FB_APP_ID) {
  throw new Error('FATAL: FB_APP_ID (or META_APP_ID) environment variable is missing.');
}
if (!FB_APP_SECRET) {
  throw new Error('FATAL: FB_APP_SECRET (or META_APP_SECRET) environment variable is missing.');
}
if (!WEBHOOK_VERIFY_TOKEN) {
  throw new Error('FATAL: FB_WEBHOOK_VERIFY_TOKEN (or META_WEBHOOK_VERIFY_TOKEN) environment variable is missing.');
}

/**
 * GET /api/integrations/facebook/config
 * Returns public Meta configuration (never exposes app secret or page tokens)
 */
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      appId: FB_APP_ID,
      redirectUri: getRedirectUri(req),
    },
  });
});

/**
 * GET /api/integrations/facebook/oauth/start
 * Generates secure CSRF state and returns official Meta OAuth authorization URL
 */
router.get('/oauth/start', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = getRedirectUri(req);

    await saveOAuthSession(state, {
      workspaceId,
      redirectUri,
      type: 'facebook',
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
    const session = state ? await getOAuthSession(state) : null;
    const isInstagram = session?.type === 'instagram';
    const errType = isInstagram ? 'IG_AUTH_ERROR' : 'META_AUTH_ERROR';
    const fallbackUrl = isInstagram
      ? `${FRONTEND_URL}/connect-instagram?error=cancelled`
      : `${FRONTEND_URL}/connect-facebook?error=cancelled`;

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>${isInstagram ? 'Instagram' : 'Meta'} Authentication Failed</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h3>${isInstagram ? 'Instagram' : 'Meta'} Connection Cancelled</h3>
          <p style="color: #64748b;">${error_description || 'Authorization was cancelled or denied.'}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: '${errType}', error: '${error || 'cancelled'}' }, '*');
              setTimeout(() => window.close(), 1000);
            } else {
              window.location.href = '${fallbackUrl}';
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

    // 2. If this was an Instagram authorization flow
    if (session?.type === 'instagram') {
      const igAccounts = await getInstagramAccounts(userAccessToken);
      console.log(`[Instagram OAuth] Successfully authorized. Found ${igAccounts.length} Instagram account(s).`);

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
    }

    // 3. Fetch real Facebook Pages accessible to this authorized user
    const realPages = await getUserAccounts(userAccessToken);
    console.log(`[Meta OAuth] Successfully authorized. User has ${realPages.length} accessible page(s).`);

    // Store real pages in OAuth session for page selection
    await saveOAuthSession(state, {
      ...session,
      realPages,
      userAccessToken,
      type: 'facebook',
      authorizedAt: new Date().toISOString(),
    });

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
            <p style="margin: 0 0 18px; font-size: 14px; color: #64748b;">Account linked successfully. Redirecting...</p>
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
                setTimeout(() => window.close(), 800);
              }
            } catch (e) {}

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
            }, 1800);
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
 */
router.get('/pages', requireAuth, async (req, res) => {
  try {
    const { state } = req.query;
    const workspaceId = req.workspaceId;

    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    let rawConnectedPages = (await getConnectedPages(workspaceId, false)) || [];

    // Separate Facebook Pages vs Instagram
    const fbConnectedPages = (rawConnectedPages || []).filter(
      (p) => !p.pageId?.startsWith('ig_') && p.category !== 'Instagram'
    );
    const igConnectedPage = (rawConnectedPages || []).find(
      (p) => (p.pageId?.startsWith('ig_') || p.category === 'Instagram') && p.status === 'connected'
    ) || null;

    let availablePages = [];
    let hasOAuthSession = false;

    if (state) {
      const session = await getOAuthSession(state);
      if (session && Array.isArray(session.realPages)) {
        hasOAuthSession = true;
        availablePages = session.realPages
          .filter((p) => !p.id?.startsWith('ig_') && p.category !== 'Instagram')
          .map((p) => {
            const isConnected = fbConnectedPages.some((cp) => cp.pageId === p.id || cp.id === p.id);
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
      connectedPages: rawConnectedPages,
      facebookPages: fbConnectedPages,
      connectedInstagram: igConnectedPage,
      availablePages,
      pages: availablePages.length > 0 ? availablePages : fbConnectedPages,
      count: availablePages.length > 0 ? availablePages.length : fbConnectedPages.length,
      connectedCount: fbConnectedPages.length,
    });
  } catch (err) {
    console.error('[Facebook Get Pages Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/connect-page
 * Connects a selected real Facebook Page and subscribes it to Messenger webhooks
 */
router.post('/connect-page', requireAuth, async (req, res) => {
  try {
    const { pageId, state } = req.body;
    const workspaceId = req.workspaceId;
    const userId = req.userId || null;

    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    if (!pageId) {
      return res.status(400).json({ success: false, error: 'pageId is required' });
    }

    // Check if page is already connected to another workspace
    const { data: existingConflict } = await supabase
      .from('facebook_pages')
      .select('workspace_id, status')
      .eq('page_id', String(pageId))
      .eq('status', 'connected')
      .maybeSingle();

    if (existingConflict && existingConflict.workspace_id && existingConflict.workspace_id !== workspaceId) {
      return res.status(409).json({
        success: false,
        error: 'Yeh page pehle se kisi aur account se connected hai.',
      });
    }

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

    const subRes = await subscribePageToWebhooks(targetPage.id || targetPage.pageId, pageAccessToken);
    const webhookStatus = subRes.success ? 'subscribed' : 'webhook_pending';

    await saveConnectedPage({
      pageId: targetPage.id || targetPage.pageId,
      pageName: targetPage.name,
      accessToken: pageAccessToken,
      workspaceId,
      status: 'connected',
      webhookStatus,
    });

    console.log(`[Facebook Page Connected] "${targetPage.name}" (ID: ${pageId}) - Webhook: ${webhookStatus}`);

    // Auto-sync initial conversations in background
    syncSinglePageChats(targetPage.id || targetPage.pageId, pageAccessToken, targetPage.name, workspaceId).catch((syncErr) => {
      console.warn('[Facebook Page Connect] Initial sync error:', syncErr.message);
    });

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
router.post('/disconnect-page', requireAuth, async (req, res) => {
  try {
    const { pageId } = req.body;
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
    if (!pageId) return res.status(400).json({ success: false, error: 'pageId is required' });

    const page = await getPageByPageId(pageId, true);
    if (!page || (page.workspace_id && page.workspace_id !== workspaceId && page.workspaceId !== workspaceId)) {
      return res.status(404).json({ success: false, error: 'Page not found in this workspace' });
    }
    if (page && page.accessToken) {
      await unsubscribePageFromWebhooks(pageId, page.accessToken);
    }

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
 * POST /api/integrations/facebook/instagram/disconnect
 * Disconnects Instagram account(s), revokes webhooks, updates status to 'disconnected',
 * and cleans up Instagram contacts/conversations so they don't linger in Inbox.
 */
router.post('/instagram/disconnect', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
    const { deleteChats = true } = req.body;

    // 1. Mark all Instagram pages as disconnected
    let query = supabase
      .from('facebook_pages')
      .update({ status: 'disconnected', access_token: 'REVOKED' })
      .or('category.eq.Instagram,page_id.ilike.ig_%')
      .eq('workspace_id', workspaceId);

    await query;

    // 2. Do not delete contacts or messages from DB; status 'disconnected' automatically hides them from Inbox
    console.log(`[Instagram Disconnected] All Instagram pages disconnected in workspace: ${workspaceId}`);

    res.json({
      success: true,
      message: 'Instagram disconnected successfully.',
    });
  } catch (err) {
    console.error('[Instagram Disconnect Error]:', err.message);
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

  if (mode === 'subscribe' && WEBHOOK_VERIFY_TOKEN && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('[Meta Webhook Verified Successfully]');
    return res.status(200).send(challenge);
  }

  console.warn('[Meta Webhook Verification Failed] Incorrect verify token');
  return res.sendStatus(403);
});

/**
 * POST /api/integrations/facebook/webhook
 * Receives Meta Messenger (Facebook + Instagram DM) webhook events
 * Enforces x-hub-signature-256 verification
 */
router.post('/webhook', async (req, res) => {
  try {
    const sigHeader = req.headers['x-hub-signature-256'];
    const rawPayload = req.rawBody;

    // 1. Signature verification using raw request body and FB_APP_SECRET
    if (!sigHeader || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
      console.warn('[Meta Webhook] Missing or malformed x-hub-signature-256 header.');
      return res.status(403).json({ error: 'Signature header missing or malformed' });
    }

    const signatureHex = sigHeader.slice(7);
    const expectedHex = crypto
      .createHmac('sha256', FB_APP_SECRET)
      .update(rawPayload || '')
      .digest('hex');

    const sigBuffer = Buffer.from(signatureHex, 'hex');
    const expectedBuffer = Buffer.from(expectedHex, 'hex');

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.warn('[Meta Webhook] Invalid webhook signature rejected.');
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    // 2. Audit log verified webhook payload in Supabase (only after signature check passes)
    try {
      await supabase.from('whatsapp_webhooks_log').insert({
        event_type: req.body?.object || 'meta_webhook',
        payload: {
          object: req.body?.object,
          entryCount: req.body?.entry?.length || 0,
          hasSigHeader: Boolean(sigHeader),
          rawBodyType: typeof req.rawBody,
        },
      });
    } catch (_) {}

    const body = req.body;

    // Normalize direct field/value test sample if entry is not wrapped
    if (!body?.entry && (body?.field || body?.sample?.field)) {
      const fieldData = body.sample || body;
      body.entry = [{
        id: fieldData.value?.recipient?.id || '0',
        messaging: [fieldData.value],
      }];
    }

    // ── Facebook Messenger Events ─────────────────────────────────────────
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        const pageId = entry.id;
        const messagingEvents = entry.messaging || (entry.changes ? entry.changes.map(c => c.value) : []);

        for (const event of messagingEvents) {
          const senderId = event.sender?.id;
          const recipientId = event.recipient?.id;
          const rawMessage = event.message;
          const postback = event.postback;
          const message = rawMessage || (postback ? {
            mid: postback.mid || `fb_pb_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            text: postback.title || postback.payload || '[Button Clicked: ' + (postback.title || 'Postback') + ']',
          } : null);

          const isEcho = Boolean(rawMessage?.is_echo) || (pageId && String(senderId) === String(pageId));
          const customerPsid = isEcho ? recipientId : senderId;
          const direction = isEcho ? 'outbound' : 'inbound';
          const status = isEcho ? 'sent' : 'delivered';
          let originalTimestamp = event.timestamp ? new Date(event.timestamp > 1e11 ? event.timestamp : event.timestamp * 1000).toISOString() : new Date().toISOString();
          if (new Date(originalTimestamp).getFullYear() < 2024) {
            originalTimestamp = new Date().toISOString();
          }

          if (customerPsid && message) {
            let messageId = message.mid;
            const isSampleMid = messageId && (
              messageId.includes('aWdfZAG1faXRlbT') ||
              messageId.includes('1457764197618') ||
              messageId.startsWith('sample_')
            );
            if (isSampleMid) {
              messageId = `${messageId}_${Date.now()}`;
            }

            const messageText = message.text;
            const attachments = message.attachments;

            // Idempotency check: prevent duplicate messages
            if (messageId && !isSampleMid) {
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

            let connectedPage = await getPageByPageId(pageId || (isEcho ? senderId : recipientId), true);
            if (!connectedPage && pageId) {
              const { data: pageRow } = await supabase.from('facebook_pages').select('*').eq('page_id', String(pageId)).maybeSingle();
              if (pageRow) connectedPage = pageRow;
            }
            const pageWorkspaceId = connectedPage?.workspace_id || connectedPage?.workspaceId;
            if (!pageWorkspaceId) {
              console.warn(`[Meta Webhook] No workspace found for Facebook Page ${pageId}. Skipping message.`);
              continue;
            }
            const pageName = connectedPage?.name || 'Facebook Page';
            const pageAccessToken = connectedPage?.accessToken;

            let customerName = `Facebook User ${customerPsid.slice(-4)}`;
            let customerAvatar = null;

            if (pageAccessToken && !isEcho) {
              try {
                const profile = await getCustomerProfile(customerPsid, pageAccessToken);
                if (profile?.name) customerName = profile.name;
                if (profile?.profilePic) customerAvatar = profile.profilePic;
              } catch (_) {}
            }

            console.log(`[Facebook Messenger] (${direction}) Customer: ${customerName} (${customerPsid}) — "${messageText || '[Attachment]'}"`);

            const contact = await upsertContact({
              phoneNumber: `fb_${customerPsid}`,
              name: customerName,
              channel: 'facebook',
              workspaceId: pageWorkspaceId,
              tags: ['Facebook Lead', pageName],
              metadata: {
                pageId: pageId || (isEcho ? senderId : recipientId),
                pageName,
                senderPsid: customerPsid,
                ...(customerAvatar ? { profilePic: customerAvatar } : {}),
              },
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
                phoneNumber: `fb_${customerPsid}`,
                direction,
                messageType: messageType === 'text' ? 'text' : 'image',
                content: displayContent,
                whatsappMessageId: messageId || `fb_in_${Date.now()}`,
                status,
                rawPayload: event,
                createdAt: originalTimestamp,
                workspaceId: pageWorkspaceId,
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
        const igPageId = entry.id; // Instagram Business Account ID
        const messagingEvents = entry.messaging || (entry.changes ? entry.changes.map(c => c.value) : []);

        for (const event of messagingEvents) {
          const senderId = event.sender?.id;
          const rawMessage = event.message;
          const postback = event.postback;
          const message = rawMessage || (postback ? {
            mid: postback.mid || `ig_pb_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            text: postback.title || postback.payload || '[Button Clicked: ' + (postback.title || 'Postback') + ']',
          } : null);

          if (senderId && message) {
            let messageId = message.mid;
            const isSampleMid = messageId && (
              messageId.includes('aWdfZAG1faXRlbT') ||
              messageId.includes('1457764197618') ||
              messageId.startsWith('sample_')
            );
            if (isSampleMid) {
              messageId = `${messageId}_${Date.now()}`;
            }

            const messageText = message.text;
            const attachments = message.attachments;
            const isEcho = Boolean(rawMessage?.is_echo) || (igPageId && String(senderId) === String(igPageId));
            const customerId = isEcho ? event.recipient?.id : senderId;
            const direction = isEcho ? 'outbound' : 'inbound';
            const status = isEcho ? 'sent' : 'delivered';
            let originalTimestamp = event.timestamp ? new Date(event.timestamp > 1e11 ? event.timestamp : event.timestamp * 1000).toISOString() : new Date().toISOString();
            if (new Date(originalTimestamp).getFullYear() < 2024) {
              originalTimestamp = new Date().toISOString();
            }

            if (!customerId) continue;

            // Idempotency check: prevent duplicate messages
            if (messageId && !isSampleMid) {
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

            // Look up connected Instagram account by igPageId or ig_{igPageId}
            let connectedIgPage = await getPageByPageId(`ig_${igPageId}`, true);
            if (!connectedIgPage) {
              connectedIgPage = await getPageByPageId(igPageId, true);
            }
            if (!connectedIgPage) {
              const { data: matchedPages } = await supabase
                .from('facebook_pages')
                .select('*')
                .eq('instagram_business_account_id', String(igPageId))
                .eq('status', 'connected')
                .limit(1);
              if (matchedPages?.length) {
                connectedIgPage = matchedPages[0];
              }
            }

            const igAccountName = connectedIgPage?.name || `@instagram_${igPageId.slice(-4)}`;
            const pageAccessToken = connectedIgPage?.accessToken || connectedIgPage?.access_token;
            const igWorkspaceId = connectedIgPage?.workspace_id || connectedIgPage?.workspaceId;
            if (!igWorkspaceId) {
              console.warn(`[Instagram Webhook] No workspace found for Instagram Page ${igPageId}. Skipping message.`);
              continue;
            }

            // Retrieve Instagram sender profile if pageAccessToken is available and message is inbound
            let customerName = `Instagram User ${customerId.slice(-4)}`;
            let customerAvatar = null;
            if (pageAccessToken && !isEcho) {
              try {
                const profile = await getInstagramUserProfile(customerId, pageAccessToken);
                if (profile?.username) customerName = `@${profile.username}`;
                else if (profile?.name) customerName = profile.name;
                if (profile?.profilePic) customerAvatar = profile.profilePic;
              } catch (_) {}
            }

            console.log(`[Instagram DM] (${direction}) Customer: ${customerName} (${customerId}) — "${messageText || '[Attachment]'}"`);

            const contact = await upsertContact({
              phoneNumber: `ig_${customerId}`,
              name: customerName,
              channel: 'instagram',
              workspaceId: igWorkspaceId,
              tags: ['Instagram DM', igAccountName],
              metadata: {
                igUserId: customerId,
                igPageId,
                igAccountName,
                senderType: 'instagram',
                ...(customerAvatar ? { profilePic: customerAvatar } : {}),
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
                phoneNumber: `ig_${customerId}`,
                direction,
                messageType: messageType === 'text' ? 'text' : 'image',
                content: displayContent,
                whatsappMessageId: messageId || `ig_in_${Date.now()}`,
                status,
                rawPayload: event,
                createdAt: originalTimestamp,
                workspaceId: igWorkspaceId,
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
 * Send a direct reply to a Facebook Messenger customer
 */
router.post('/send-message', requireAuth, async (req, res) => {
  try {
    const { recipientPsid, text, pageId } = req.body;
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    if (!recipientPsid || !text) {
      return res.status(400).json({ success: false, error: 'recipientPsid and text are required' });
    }

    let page = null;
    if (pageId) {
      page = await getPageByPageId(pageId, true);
      if (page && page.workspace_id && page.workspace_id !== workspaceId) {
        page = null;
      }
    }
    if (!page || !page.accessToken) {
      const pages = await getConnectedPages(workspaceId, true);
      page = pages.find((p) => p.accessToken && !p.pageId?.startsWith('ig_'));
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
 * Starts Instagram DM OAuth flow
 */
router.get('/instagram/oauth/start', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
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
    const redirectUri = session.redirectUri || getRedirectUri(req);
    const tokenData = await exchangeCodeForTokens(code, redirectUri);
    const userAccessToken = tokenData.userAccessToken;

    const igAccounts = await getInstagramAccounts(userAccessToken);
    console.log(`[Instagram OAuth] Authorized. Found ${igAccounts.length} Instagram account(s).`);

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
 * List Instagram accounts available from active OAuth session OR linked to connected Facebook Page
 */
router.get('/instagram/accounts', requireAuth, async (req, res) => {
  try {
    const { state } = req.query;
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
    let igAccounts = [];
    let hasOAuthSession = false;

    if (state) {
      const session = await getOAuthSession(state);
      if (session?.igAccounts && session.igAccounts.length > 0) {
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

    // Fallback: If no accounts in session, check connected Facebook Pages for linked Instagram accounts
    if (igAccounts.length === 0) {
      const connectedPages = (await getConnectedPages(workspaceId, true)) || [];
      const fbPages = connectedPages.filter((p) => !p.pageId?.startsWith('ig_') && p.accessToken);

      for (const p of fbPages) {
        try {
          const resp = await axios.get(`${GRAPH_BASE_URL}/${p.pageId}`, {
            headers: { Authorization: `Bearer ${p.accessToken}` },
            params: { fields: 'instagram_business_account{id,name,username,profile_picture_url,followers_count}' },
            timeout: 8000,
          });

          const ig = resp.data?.instagram_business_account;
          if (ig && ig.id) {
            igAccounts.push({
              igUserId: String(ig.id),
              igUsername: ig.username || p.pageName,
              igName: ig.name || ig.username || p.pageName,
              igProfilePicture: ig.profile_picture_url || p.pictureUrl || null,
              igFollowers: ig.followers_count || 0,
              linkedPageName: p.pageName,
              linkedPageId: p.pageId,
            });
          }
        } catch (checkErr) {
          console.warn(`[IG Auto-detect] Could not check IG for page ${p.pageId}:`, checkErr.message);
        }
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
router.post('/instagram/connect-account', requireAuth, async (req, res) => {
  try {
    const { igUserId, state } = req.body;
    const workspaceId = req.workspaceId;
    const userId = req.userId || null;

    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    if (!igUserId) {
      return res.status(400).json({ success: false, error: 'igUserId is required' });
    }

    // Check if Instagram account is already connected to another workspace
    const targetIgPageId = `ig_${igUserId}`;
    const { data: existingIgConflict } = await supabase
      .from('facebook_pages')
      .select('workspace_id, status')
      .eq('page_id', targetIgPageId)
      .eq('status', 'connected')
      .maybeSingle();

    if (existingIgConflict && existingIgConflict.workspace_id && existingIgConflict.workspace_id !== workspaceId) {
      return res.status(409).json({
        success: false,
        error: 'Yeh Instagram account pehle se kisi aur account se connected hai.',
      });
    }

    let targetAccount = null;
    if (state) {
      const session = await getOAuthSession(state);
      if (session?.igAccounts) {
        targetAccount = session.igAccounts.find((acc) => acc.igUserId === String(igUserId));
      }
    }

    // Fallback: If not in state session, look up across connected Facebook Pages
    if (!targetAccount || !targetAccount.pageAccessToken) {
      const connectedPages = (await getConnectedPages(workspaceId, true)) || [];
      const fbPages = connectedPages.filter((p) => !p.pageId?.startsWith('ig_') && p.accessToken);

      for (const p of fbPages) {
        try {
          const resp = await axios.get(`${GRAPH_BASE_URL}/${p.pageId}`, {
            headers: { Authorization: `Bearer ${p.accessToken}` },
            params: { fields: 'instagram_business_account{id,name,username,profile_picture_url}' },
            timeout: 8000,
          });
          const ig = resp.data?.instagram_business_account;
          if (ig && (String(ig.id) === String(igUserId) || !igUserId)) {
            targetAccount = {
              igUserId: String(ig.id),
              igUsername: ig.username,
              igProfilePicture: ig.profile_picture_url || null,
              pageAccessToken: p.accessToken,
              linkedPageId: p.pageId,
              linkedPageName: p.pageName,
            };
            break;
          }
        } catch (_) {}
      }
    }

    if (!targetAccount || !targetAccount.pageAccessToken) {
      return res.status(400).json({
        success: false,
        error: 'Instagram account not found. Please link your Instagram Business account to your Facebook Page.',
      });
    }

    // Subscribe linked Facebook Page to Instagram DM webhooks
    const subRes = await subscribeInstagramWebhooks(
      targetAccount.linkedPageId,
      targetAccount.pageAccessToken
    );
    const webhookStatus = subRes.success ? 'subscribed' : 'webhook_pending';

    // Save as connected page with structured metadata and explicit linking columns
    await saveConnectedPage({
      pageId: `ig_${targetAccount.igUserId}`,
      pageName: `@${targetAccount.igUsername}`,
      category: 'Instagram',
      pictureUrl: targetAccount.igProfilePicture || null,
      accessToken: targetAccount.pageAccessToken,
      userId,
      workspaceId,
      status: 'connected',
      webhookStatus,
      linkedPageId: targetAccount.linkedPageId,
      instagramBusinessAccountId: targetAccount.igUserId,
      metadata: {
        igUserId: targetAccount.igUserId,
        igUsername: targetAccount.igUsername,
        linkedPageId: targetAccount.linkedPageId,
        linkedPageName: targetAccount.linkedPageName,
        connectedVia: 'meta_oauth',
      },
    });

    console.log(`[Instagram Connected] @${targetAccount.igUsername} (IG ID: ${targetAccount.igUserId}) - Webhook: ${webhookStatus}`);

    // Auto-sync historical Instagram conversations immediately in background
    syncInstagramChats(
      targetAccount.linkedPageId,
      targetAccount.pageAccessToken,
      targetAccount.igUserId,
      targetAccount.igUsername
    ).catch((e) => console.warn('[Auto-sync IG Chats Warning]:', e.message));

    res.json({
      success: true,
      message: `Instagram @${targetAccount.igUsername} connected successfully! Chats are syncing.`,
      account: {
        igUserId: targetAccount.igUserId,
        igUsername: targetAccount.igUsername,
        igProfilePicture: targetAccount.igProfilePicture,
        linkedPageName: targetAccount.linkedPageName,
        linkedPageId: targetAccount.linkedPageId,
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
 * POST /api/integrations/facebook/instagram/sync-chats
 * Manually trigger full historical chat sync for connected Instagram accounts
 */
router.post('/instagram/sync-chats', requireAuth, async (req, res) => {
  try {
    const { igUserId } = req.body;
    const workspaceId = req.workspaceId;

    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    let targetPage = null;

    if (igUserId) {
      targetPage = await getPageByPageId(`ig_${igUserId}`, true);
      if (targetPage && targetPage.workspace_id && targetPage.workspace_id !== workspaceId) {
        targetPage = null;
      }
    } else {
      const { data: pages } = await supabase
        .from('facebook_pages')
        .select('*')
        .ilike('page_id', 'ig_%')
        .eq('status', 'connected')
        .eq('workspace_id', workspaceId)
        .limit(1);
      targetPage = pages?.[0];
    }

    if (!targetPage?.accessToken && !targetPage?.access_token) {
      return res.status(404).json({ success: false, error: 'No connected Instagram account found' });
    }

    const token = targetPage.accessToken || targetPage.access_token;
    const igId = targetPage.instagram_business_account_id || targetPage.metadata?.igUserId || targetPage.page_id.replace(/^ig_/, '');
    
    // Resolve linked Facebook Page ID safely without stripping 'ig_'
    let linkedPageId = targetPage.linked_page_id || targetPage.metadata?.linkedPageId;
    if (!linkedPageId) {
      // Find connected Facebook Page in facebook_pages
      const { data: fbPages } = await supabase
        .from('facebook_pages')
        .select('*')
        .not('page_id', 'ilike', 'ig_%')
        .eq('status', 'connected')
        .eq('workspace_id', workspaceId)
        .limit(1);
      if (fbPages?.[0]?.page_id) {
        linkedPageId = fbPages[0].page_id;
      }
    }

    const result = await syncInstagramChats(
      linkedPageId,
      token,
      igId,
      targetPage.name || targetPage.page_name || 'instagram',
      { workspaceId }
    );

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Manual Instagram Sync Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/instagram/send-message
 * Send Instagram DM reply to a customer
 */
router.post('/instagram/send-message', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const { recipientIgUserId, text, igUserId } = req.body;

    if (!recipientIgUserId || !text) {
      return res.status(400).json({ success: false, error: 'recipientIgUserId and text are required' });
    }

    let page = null;
    if (igUserId) {
      page = await getPageByPageId(`ig_${igUserId}`, true);
    }
    if (!page?.accessToken) {
      const pages = await getConnectedPages(workspaceId, true);
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
 * GET /api/integrations/facebook/import/preview
 * Safe preview of available historical chats before running an import
 */
router.get('/import/preview', requireAuth, async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    const { platform = 'facebook', pageId } = req.query;

    let targetPage = null;
    if (platform === 'instagram') {
      const pages = await getConnectedPages(workspaceId, true);
      targetPage = pageId ? pages.find((p) => p.pageId === pageId || p.pageId === `ig_${pageId}`) : pages.find((p) => p.pageId?.startsWith('ig_'));
    } else {
      targetPage = pageId ? await getPageByPageId(pageId, true) : (await getConnectedPages(workspaceId, true)).find((p) => !p.pageId?.startsWith('ig_'));
    }

    if (!targetPage?.accessToken) {
      return res.status(404).json({
        success: false,
        error: `No connected ${platform} account with active token found.`,
      });
    }

    const token = targetPage.accessToken;
    const queryId = platform === 'instagram' ? (targetPage.linkedPageId || targetPage.pageId.replace(/^ig_/, '')) : targetPage.pageId;

    let conversations = [];
    try {
      conversations = await fetchPageConversations(queryId, token, platform === 'instagram' ? 'instagram' : null, 1);
    } catch (apiErr) {
      return res.json({
        success: false,
        platform,
        eligible: false,
        error: apiErr.response?.data?.error?.message || apiErr.message,
        limitations: 'Meta Graph API conversations access requires pages_messaging and instagram_manage_messages permissions. In Dev mode, only app testers/admins can be accessed.',
      });
    }

    let sampleMessagesCount = 0;
    for (const c of conversations) {
      sampleMessagesCount += (c.messages?.data?.length || 0);
    }

    res.json({
      success: true,
      platform,
      eligible: true,
      conversationsCount: conversations.length,
      sampleMessagesCount,
      accountName: targetPage.name,
      limitations: platform === 'instagram' 
        ? 'Meta only provides historical Instagram messages if instagram_manage_messages is approved or the account is an authorized tester in development mode.'
        : 'Meta limits historical Messenger conversations to pages managed by the user with pages_messaging permission.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/import/execute
 * Resumable, duplicate-safe historical import
 */
router.post('/import/execute', requireAuth, async (req, res) => {
  try {
    const { platform = 'facebook', pageId } = req.body;
    const workspaceId = req.workspaceId;
    if (!workspaceId || workspaceId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    if (platform === 'instagram') {
      const pages = await getConnectedPages(workspaceId, true);
      const targetPage = pageId ? pages.find((p) => p.pageId === pageId || p.pageId === `ig_${pageId}`) : pages.find((p) => p.pageId?.startsWith('ig_'));
      if (!targetPage?.accessToken) {
        return res.status(404).json({ success: false, error: 'No connected Instagram account found' });
      }
      const igId = targetPage.instagramBusinessAccountId || targetPage.metadata?.igUserId || targetPage.pageId.replace(/^ig_/, '');
      const result = await syncInstagramChats(targetPage.linkedPageId, targetPage.accessToken, igId, targetPage.name, { workspaceId });
      return res.json({ success: true, platform: 'instagram', ...result });
    } else {
      const targetPage = pageId ? await getPageByPageId(pageId, true) : (await getConnectedPages(workspaceId, true)).find((p) => !p.pageId?.startsWith('ig_'));
      if (!targetPage?.accessToken) {
        return res.status(404).json({ success: false, error: 'No connected Facebook Page found' });
      }
      const result = await syncSinglePageChats(targetPage.pageId, targetPage.accessToken, targetPage.name, workspaceId);
      return res.json({ success: true, platform: 'facebook', ...result });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Sync historical Instagram Direct chats for a connected account
 */
export async function syncInstagramChats(linkedPageId, pageAccessToken, igUserId, igUsername, { maxPages = 1, workspaceId = null } = {}) {
  try {
    console.log(`[Instagram Sync] Starting sync for @${igUsername} | igUserId=${igUserId} | linkedPageId=${linkedPageId}`);

    let conversations = [];
    let syncError = null;

    // 1. Try /{page-id}/conversations?platform=instagram (standard Meta endpoint for IG)
    let fetchedFromPage = false;
    if (linkedPageId) {
      try {
        conversations = await fetchPageConversations(linkedPageId, pageAccessToken, 'instagram', maxPages);
        console.log(`[Instagram Sync] Using linkedPageId (${linkedPageId}) endpoint. Found ${conversations.length} conversation(s).`);
        fetchedFromPage = true;
      } catch (e) {
        console.warn(`[Instagram Sync] linkedPageId endpoint failed:`, e.response?.data?.error?.message || e.message);
      }
    }

    // 2. Fallback: try /{igUserId}/conversations directly if linkedPageId failed or returned 0
    if ((!fetchedFromPage || conversations.length === 0) && igUserId) {
      try {
        const directConvs = await fetchInstagramConversations(igUserId, pageAccessToken, maxPages);
        console.log(`[Instagram Sync] Using igUserId (${igUserId}) direct endpoint. Found ${directConvs.length} conversation(s).`);
        if (directConvs.length > 0) {
          conversations = directConvs;
        }
      } catch (fallbackErr) {
        syncError = fallbackErr.response?.data?.error?.message || fallbackErr.message;
      }
    }

    if (conversations.length === 0 && syncError && !fetchedFromPage) {
      console.warn(`[Instagram Sync] Meta API error during sync: ${syncError}`);
      return { success: false, error: syncError, count: 0, skipped: 0 };
    }

    let totalMessages = 0;
    let skippedDuplicates = 0;

    for (const conv of conversations) {
      const participants = conv.participants?.data || [];
      const customer = participants.find(
        (p) => String(p.id) !== String(igUserId) && (!linkedPageId || String(p.id) !== String(linkedPageId))
      );
      if (!customer?.id) continue;

      const customerId = String(customer.id);
      let customerName = customer.username || customer.name || `Instagram User ${customerId.slice(-4)}`;
      let profilePicUrl = null;

      if (pageAccessToken) {
        try {
          const profile = await getInstagramUserProfile(customerId, pageAccessToken);
          if (profile?.username) customerName = `@${profile.username}`;
          else if (profile?.name) customerName = profile.name;
          if (profile?.profilePic) profilePicUrl = profile.profilePic;
        } catch (_) {}
      }

      const contact = await upsertContact({
        phoneNumber: `ig_${customerId}`,
        name: customerName,
        channel: 'instagram',
        tags: ['Instagram DM', `@${igUsername}`],
        metadata: {
          igUserId: customerId,
          igPageId: igUserId,
          igAccountName: `@${igUsername}`,
          senderType: 'instagram',
          ...(profilePicUrl ? { profilePic: profilePicUrl } : {}),
        },
        updateTimestamp: false,
        workspaceId,
      });

      if (!contact) continue;

      const messages = (conv.messages?.data || []).slice().reverse();
      const messageIds = messages.map((m) => m.id).filter(Boolean);

      // Batch query existing messages to eliminate N+1 roundtrips
      let existingIdsSet = new Set();
      if (messageIds.length > 0) {
        let msgQuery = supabase
          .from('messages')
          .select('whatsapp_message_id')
          .in('whatsapp_message_id', messageIds);
        if (workspaceId && workspaceId !== 'default_workspace') {
          msgQuery = msgQuery.eq('workspace_id', workspaceId);
        }
        const { data: existingList } = await msgQuery;
        if (existingList) {
          existingIdsSet = new Set(existingList.map((m) => m.whatsapp_message_id));
        }
      }

      let hasNewMessage = false;

      for (const msg of messages) {
        if (!msg.id) continue;

        // Duplicate check via unique platform message ID
        if (existingIdsSet.has(msg.id)) {
          skippedDuplicates++;
          continue;
        }

        const isCustomer = String(msg.from?.id) === customerId || msg.from?.username === customer.username;
        let content = msg.message;
        if (!content && msg.shares?.data?.[0]?.link) {
          content = `[Instagram Shared Reel/Post: ${msg.shares.data[0].link}]`;
        } else if (!content && msg.attachments?.data?.length) {
          const attType = msg.attachments.data[0].type || 'media';
          content = `[Instagram Attachment: ${attType}]`;
        } else if (!content) {
          content = '[Instagram Message]';
        }

        await saveMessage({
          contactId: contact.id,
          phoneNumber: `ig_${customerId}`,
          direction: isCustomer ? 'inbound' : 'outbound',
          messageType: 'text',
          content,
          whatsappMessageId: msg.id,
          status: 'delivered',
          createdAt: msg.created_time || null,
          workspaceId,
        });
        totalMessages++;
        hasNewMessage = true;
      }

      if (hasNewMessage) {
        await supabase
          .from('contacts')
          .update({ last_interaction_at: new Date().toISOString() })
          .eq('id', contact.id);
      }
    }

    console.log(`[Instagram Sync Complete] Synced ${totalMessages} historical message(s), skipped ${skippedDuplicates} duplicates.`);
    return { success: true, count: totalMessages, skipped: skippedDuplicates };
  } catch (err) {
    const errDetail = err.response?.data?.error?.message || err.message;
    console.error(`[Instagram Sync Error]:`, errDetail);
    return { success: false, error: errDetail, count: 0, skipped: 0 };
  }
}

/**
 * Helper to sync conversations and messages from Meta Graph API for a Facebook Page
 */
export async function syncSinglePageChats(pageId, pageAccessToken, pageName = 'Facebook Page', workspaceId = null) {
  try {
    const resolvedPageName = (!pageName || pageName === 'undefined' || pageName === 'Facebook Page')
      ? 'Omniconnect'
      : pageName;

    const conversations = await fetchPageConversations(pageId, pageAccessToken, null, 1);
    let syncedCount = 0;
    let skippedDuplicates = 0;

    for (const conv of conversations) {
      const participants = conv.participants?.data || [];
      const customer = participants.find((p) => String(p.id) !== String(pageId));
      if (!customer?.id) continue;

      const customerId = String(customer.id);
      const customerName = customer.name || `Facebook User ${customerId.slice(-4)}`;

      let profilePicUrl = null;
      try {
        const profile = await getCustomerProfile(customerId, pageAccessToken);
        if (profile?.profilePic) profilePicUrl = profile.profilePic;
      } catch (_) {}

      const contact = await upsertContact({
        phoneNumber: `fb_${customerId}`,
        name: customerName,
        channel: 'facebook',
        tags: ['Facebook Lead', resolvedPageName],
        metadata: {
          pageId: String(pageId),
          pageName: resolvedPageName,
          senderPsid: customerId,
          ...(profilePicUrl ? { profilePic: profilePicUrl } : {}),
        },
        updateTimestamp: false,
        workspaceId,
      });

      if (!contact) continue;

      const messages = (conv.messages?.data || []).slice().reverse();
      const messageIds = messages.map((m) => m.id).filter(Boolean);

      // Batch query existing messages to eliminate N+1 roundtrips
      let existingIdsSet = new Set();
      if (messageIds.length > 0) {
        let msgQuery = supabase
          .from('messages')
          .select('whatsapp_message_id')
          .in('whatsapp_message_id', messageIds);
        if (workspaceId && workspaceId !== 'default_workspace') {
          msgQuery = msgQuery.eq('workspace_id', workspaceId);
        }
        const { data: existingList } = await msgQuery;
        if (existingList) {
          existingIdsSet = new Set(existingList.map((m) => m.whatsapp_message_id));
        }
      }

      let newMsgSaved = false;

      for (const msg of messages) {
        if (!msg.id) continue;

        // Duplicate check via unique platform message ID
        if (existingIdsSet.has(msg.id)) {
          skippedDuplicates++;
          continue;
        }

        const isFromCustomer = String(msg.from?.id) === customerId;
        await saveMessage({
          contactId: contact.id,
          phoneNumber: `fb_${customerId}`,
          direction: isFromCustomer ? 'inbound' : 'outbound',
          messageType: 'text',
          content: msg.message || '[Attachment]',
          whatsappMessageId: msg.id,
          status: 'delivered',
          createdAt: msg.created_time || null,
          workspaceId,
        });
        syncedCount++;
        newMsgSaved = true;
      }

      if (newMsgSaved) {
        await supabase
          .from('contacts')
          .update({ last_interaction_at: new Date().toISOString() })
          .eq('id', contact.id);
      }
    }

    console.log(`[Facebook Sync] Synced ${syncedCount} message(s), skipped ${skippedDuplicates} duplicates for "${resolvedPageName}"`);
    return { success: true, syncedCount, skippedDuplicates };
  } catch (err) {
    console.error(`[Facebook Sync Error] Page ${pageId}:`, err.message);
    return { success: false, error: err.message, syncedCount: 0 };
  }
}

/**
 * POST /api/integrations/facebook/sync
 * Manually trigger sync of existing chats from Meta Graph API
 */
router.all('/sync', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId || wsId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
    const { pageId } = { ...req.query, ...req.body };
    const connectedPages = await getConnectedPages(wsId, true);

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
      try {
        if (page.pageId?.startsWith('ig_')) {
          const igId = page.instagramBusinessAccountId || page.metadata?.igUserId || page.pageId.replace(/^ig_/, '');
          const r = await syncInstagramChats(page.linkedPageId, page.accessToken, igId, page.name, { maxPages: 1, workspaceId: wsId });
          if (r.success) totalSynced += (r.count || 0);
          results.push({ pageId: page.pageId, pageName: page.name, ...r });
        } else {
          const r = await syncSinglePageChats(page.pageId || page.id, page.accessToken, page.name || page.pageName, wsId);
          if (r.success) totalSynced += (r.syncedCount || 0);
          results.push({ pageId: page.pageId || page.id, pageName: page.name, ...r });
        }
      } catch (pageSyncErr) {
        console.warn(`[Sync Page Warn] ${page.name}:`, pageSyncErr.message);
      }
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

/**
 * POST /api/integrations/facebook/instagram/sync-chats
 * Direct sync for Instagram Direct messages
 */
router.post('/instagram/sync-chats', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId || wsId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }
    const pages = await getConnectedPages(wsId, true);
    const igPage = pages.find((p) => p.pageId?.startsWith('ig_') || p.instagramBusinessAccountId);

    if (!igPage || !igPage.accessToken) {
      return res.json({
        success: true,
        message: 'No connected Instagram account found to sync.',
        count: 0,
        skipped: 0,
      });
    }

    const igId = igPage.instagramBusinessAccountId || igPage.metadata?.igUserId || igPage.pageId.replace(/^ig_/, '');
    const result = await syncInstagramChats(igPage.linkedPageId, igPage.accessToken, igId, igPage.name, { maxPages: 1, workspaceId: wsId });

    res.json({
      success: true,
      message: `Synced ${result.count || 0} Instagram message(s).`,
      ...result,
    });
  } catch (err) {
    console.error('[Instagram Sync Route Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/facebook/data-deletion
 * Official Meta User Data Deletion Callback endpoint per Meta Developer Policy.
 * Validates signed_request, revokes user tokens, and returns status URL + confirmation_code.
 */
router.post('/data-deletion', async (req, res) => {
  try {
    const signedRequest = req.body?.signed_request;
    if (!signedRequest) {
      return res.status(400).json({ error: 'signed_request is required' });
    }

    const [encodedSig, payload] = signedRequest.split('.');
    const appSecret = FB_APP_SECRET;

    // Decode signature
    const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest();

    if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
      console.warn('[Meta Data Deletion] Invalid signed_request signature');
      return res.status(403).json({ error: 'Invalid signed_request signature' });
    }

    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const userId = data.user_id;
    const confirmationCode = `del_${crypto.randomBytes(12).toString('hex')}`;

    console.log(`[Meta Data Deletion Callback] Processing request for Meta User ID: ${userId}, Code: ${confirmationCode}`);

    if (userId) {
      await supabase
        .from('facebook_pages')
        .update({ status: 'deleted', access_token: 'REVOKED' })
        .eq('user_id', userId);
    }

    const statusUrl = `${FRONTEND_URL}/data-deletion?id=${confirmationCode}`;
    res.json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    console.error('[Meta Data Deletion Callback Error]:', err.message);
    res.status(500).json({ error: 'Failed to process data deletion request' });
  }
});

/**
 * GET /api/integrations/facebook/data-deletion
 * Browser-friendly redirect to the frontend Data Deletion Instructions page
 */
router.get('/data-deletion', (req, res) => {
  res.redirect(`${FRONTEND_URL}/data-deletion`);
});

export default router;
