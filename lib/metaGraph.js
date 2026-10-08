// backend/lib/metaGraph.js — Meta Graph API & Messenger + Instagram DM Services
import axios from 'axios';
import crypto from 'node:crypto';
import 'dotenv/config';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const META_APP_ID = process.env.META_APP_ID ? process.env.META_APP_ID.trim() : '';
const META_APP_SECRET = process.env.META_APP_SECRET ? process.env.META_APP_SECRET.trim() : '';

// ── Facebook Messenger OAuth ─────────────────────────────────────────────────

/**
 * Generate official Meta OAuth dialog URL for Facebook Pages (Messenger)
 */
export function getOAuthAuthorizationUrl({ state, redirectUri }) {
  const scopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_messaging',
  ].join(',');

  return (
    `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?` +
    new URLSearchParams({
      client_id: META_APP_ID,
      redirect_uri: redirectUri ? redirectUri.trim() : '',
      state: state,
      scope: scopes,
      response_type: 'code',
      auth_type: 'rerequest',
    }).toString()
  );
}

// ── Instagram DM OAuth ───────────────────────────────────────────────────────

/**
 * Generate Meta OAuth URL with Instagram DM permissions
 * Requires: instagram_basic + instagram_manage_messages + pages_show_list
 */
export function getInstagramOAuthUrl({ state, redirectUri }) {
  const scopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_messaging',
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'business_management',
  ].join(',');

  return (
    `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?` +
    new URLSearchParams({
      client_id: META_APP_ID,
      redirect_uri: redirectUri ? redirectUri.trim() : '',
      state: state,
      scope: scopes,
      response_type: 'code',
      auth_type: 'rerequest',
    }).toString()
  );
}

/**
 * Get Instagram Professional accounts linked to Facebook Pages
 * Each page can have a linked Instagram Business/Creator account
 */
export async function getInstagramAccounts(userAccessToken) {
  // 1. Get Facebook Pages first
  const pagesRes = await axios.get(`${GRAPH_BASE_URL}/me/accounts`, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
    params: { fields: 'id,name,access_token,instagram_business_account{id,name,username,profile_picture_url,followers_count}' },
    timeout: 10000,
  });

  if (!pagesRes.data?.data) return [];

  const igAccounts = [];
  for (const page of pagesRes.data.data) {
    if (page.instagram_business_account) {
      const igAccount = page.instagram_business_account;
      igAccounts.push({
        igUserId: String(igAccount.id),
        igUsername: igAccount.username || igAccount.name,
        igName: igAccount.name,
        igProfilePicture: igAccount.profile_picture_url || null,
        igFollowers: igAccount.followers_count || 0,
        linkedPageId: String(page.id),
        linkedPageName: page.name,
        pageAccessToken: page.access_token,
      });
    }
  }
  return igAccounts;
}

/**
 * Send an Instagram DM reply via the Messenger API for Instagram
 * Uses the page access token of the linked Facebook Page
 */
export async function sendInstagramDM(pageAccessToken, recipientIgUserId, text) {
  if (!pageAccessToken) throw new Error('Missing Page Access Token for Instagram DM');
  if (!recipientIgUserId) throw new Error('Missing recipient Instagram user ID');
  if (!text?.trim()) throw new Error('Message text cannot be empty');

  const payload = {
    recipient: { id: String(recipientIgUserId) },
    message: { text: text.trim() },
    messaging_type: 'RESPONSE',
  };

  const res = await axios.post(`${GRAPH_BASE_URL}/me/messages`, payload, {
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 12000,
  });

  return {
    success: true,
    messageId: res.data.message_id,
    recipientId: res.data.recipient_id,
  };
}

/**
 * Subscribe an Instagram-linked Facebook Page to Instagram webhooks
 */
export async function subscribeInstagramWebhooks(pageId, pageAccessToken) {
  try {
    const res = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields: 'messages,messaging_postbacks,message_deliveries,message_reads,instagram_messages',
          access_token: pageAccessToken,
        },
        timeout: 10000,
      }
    );
    return { success: res.data?.success === true };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[MetaGraph] Instagram webhook subscription failed:`, msg);
    return { success: false, error: msg };
  }
}

/**
 * Exchange OAuth authorization code for a Long-Lived User Access Token
 */
export async function exchangeCodeForTokens(code, redirectUri) {
  if (!META_APP_ID || !META_APP_SECRET) {
    throw new Error('META_APP_ID or META_APP_SECRET is not configured in backend .env');
  }

  // 1. Exchange authorization code for short-lived user token
  const tokenRes = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
    params: {
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: redirectUri,
      code: code,
    },
    timeout: 10000,
  });

  const shortLivedToken = tokenRes.data.access_token;
  if (!shortLivedToken) {
    throw new Error('Meta did not return an access token for authorization code');
  }

  // 2. Exchange short-lived token for long-lived (60-day) user token
  try {
    const longLivedRes = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: shortLivedToken,
      },
      timeout: 10000,
    });

    const longLivedToken = longLivedRes.data.access_token;
    return {
      userAccessToken: longLivedToken || shortLivedToken,
      expiresIn: longLivedRes.data.expires_in || tokenRes.data.expires_in,
    };
  } catch (exchangeErr) {
    console.warn('[MetaGraph] Long-lived exchange warning:', exchangeErr.message);
    return {
      userAccessToken: shortLivedToken,
      expiresIn: tokenRes.data.expires_in,
    };
  }
}

/**
 * Retrieve real Facebook Pages managed by the authorized user
 * Returns pages with their permanent Page Access Tokens
 */
export async function getUserAccounts(userAccessToken) {
  const res = await axios.get(`${GRAPH_BASE_URL}/me/accounts`, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
    params: {
      fields: 'id,name,access_token,category,picture{url},tasks',
    },
    timeout: 10000,
  });

  if (!res.data?.data || !Array.isArray(res.data.data)) {
    return [];
  }

  return res.data.data.map((p) => ({
    id: String(p.id),
    name: p.name,
    category: p.category || 'Business',
    picture: p.picture?.data?.url || null,
    accessToken: p.access_token, // Kept server-side only
    tasks: p.tasks || [],
  }));
}

/**
 * Subscribe a Facebook Page to Messenger Webhook Events
 */
export async function subscribePageToWebhooks(pageId, pageAccessToken) {
  try {
    const res = await axios.post(
      `${GRAPH_BASE_URL}/${pageId}/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields: 'messages,messaging_postbacks,message_deliveries,message_reads',
          access_token: pageAccessToken,
        },
        timeout: 10000,
      }
    );

    const success = res.data?.success === true;
    return { success, data: res.data };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error(`[MetaGraph] Webhook subscription failed for page ${pageId}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Unsubscribe a Facebook Page from Webhook Events
 */
export async function unsubscribePageFromWebhooks(pageId, pageAccessToken) {
  try {
    const res = await axios.delete(`${GRAPH_BASE_URL}/${pageId}/subscribed_apps`, {
      params: { access_token: pageAccessToken },
      timeout: 10000,
    });
    return { success: res.data?.success === true };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

/**
 * Call Meta Messenger Send API to send a reply to a customer
 */
export async function sendMessengerText(pageAccessToken, recipientPsid, text) {
  if (!pageAccessToken) {
    throw new Error('Missing Page Access Token for Facebook Messenger');
  }
  if (!recipientPsid) {
    throw new Error('Missing recipient customer PSID');
  }
  if (!text || !text.trim()) {
    throw new Error('Message text cannot be empty');
  }

  try {
    const payload = {
      recipient: { id: String(recipientPsid) },
      message: { text: text.trim() },
      messaging_type: 'RESPONSE',
    };

    const res = await axios.post(`${GRAPH_BASE_URL}/me/messages`, payload, {
      headers: {
        Authorization: `Bearer ${pageAccessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 12000,
    });

    return {
      success: true,
      messageId: res.data.message_id,
      recipientId: res.data.recipient_id,
    };
  } catch (err) {
    const metaError = err.response?.data?.error;
    const msg = metaError?.message || err.message;
    console.error('[MetaGraph Send API Error]:', msg);
    throw new Error(`Meta Messenger API error: ${msg}`);
  }
}

/**
 * Optional: Fetch public profile for customer PSID (if permissions allow)
 */
export async function getCustomerProfile(senderPsid, pageAccessToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE_URL}/${senderPsid}`, {
      params: {
        fields: 'first_name,last_name,profile_pic',
        access_token: pageAccessToken,
      },
      timeout: 5000,
    });

    const firstName = res.data.first_name;
    const lastName = res.data.last_name;
    const name = [firstName, lastName].filter(Boolean).join(' ');
    return {
      name: name || null,
      profilePic: res.data.profile_pic || null,
    };
  } catch {
    // If user profile access is restricted by Meta, fallback safely
    return { name: null, profilePic: null };
  }
}

/**
 * Validate Meta Webhook signature (x-hub-signature-256)
 */
export function verifyWebhookSignature(signatureHeader, rawBody) {
  if (!signatureHeader || !META_APP_SECRET) return true; // Bypass in dev if not set or signature absent
  try {
    const [algo, signature] = signatureHeader.split('=');
    if (algo !== 'sha256') return false;

    const hmac = crypto.createHmac('sha256', META_APP_SECRET);
    hmac.update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
    const digest = hmac.digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(digest, 'hex'));
  } catch {
    return false;
  }
}
