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

  try {
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
    const statusCode = err.response?.status;
    const errCode = metaError?.code;
    const errSubcode = metaError?.error_subcode;
    const traceId = metaError?.fbtrace_id;
    const msg = metaError?.message || err.message;
    console.error(`[Instagram DM Send Error] Status: ${statusCode}, Code: ${errCode}, Subcode: ${errSubcode}, Trace: ${traceId} — ${msg}`);

    let cleanMsg = msg;
    if (errCode === 10 || errSubcode === 2018001) {
      cleanMsg = 'Message cannot be sent: Meta 24-hour messaging window has closed. The customer must message first.';
    } else if (errCode === 190) {
      cleanMsg = 'Meta Page Access Token has expired. Please reconnect your Instagram account in Settings.';
    } else if (errCode === 230 || errCode === 200) {
      cleanMsg = 'Permission error: App requires Advanced Access to instagram_manage_messages.';
    }
    throw new Error(cleanMsg);
  }
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
          subscribed_fields: 'messages,messaging_postbacks,message_deliveries,message_reads',
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
export async function sendMessengerText(pageAccessToken, recipientPsid, text, options = {}) {
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
      messaging_type: options.messaging_type || 'RESPONSE',
    };
    if (options.tag) {
      payload.tag = options.tag;
    }

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
    const statusCode = err.response?.status;
    const errCode = metaError?.code;
    const errSubcode = metaError?.error_subcode;
    const traceId = metaError?.fbtrace_id;
    const msg = metaError?.message || err.message;
    console.error(`[Facebook Messenger Send Error] Status: ${statusCode}, Code: ${errCode}, Subcode: ${errSubcode}, Trace: ${traceId} — ${msg}`);

    // If 24h window closed, automatically attempt fallback with MESSAGE_TAG (POST_PURCHASE_UPDATE)
    if (errCode === 10 || errSubcode === 2018001) {
      console.log('[Facebook Messenger] 24-hour window closed. Attempting auto-fallback with MESSAGE_TAG (POST_PURCHASE_UPDATE)...');
      try {
        const tagPayload = {
          recipient: { id: String(recipientPsid) },
          message: { text: text.trim() },
          messaging_type: 'MESSAGE_TAG',
          tag: 'POST_PURCHASE_UPDATE',
        };
        const resTag = await axios.post(`${GRAPH_BASE_URL}/me/messages`, tagPayload, {
          headers: {
            Authorization: `Bearer ${pageAccessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 12000,
        });
        console.log('[Facebook Messenger] Fallback MESSAGE_TAG delivered successfully!');
        return {
          success: true,
          messageId: resTag.data.message_id,
          recipientId: resTag.data.recipient_id,
          usedTagFallback: true,
        };
      } catch (fallbackErr) {
        console.error('[Facebook Messenger MESSAGE_TAG Fallback Failed]:', fallbackErr.response?.data?.error?.message || fallbackErr.message);
      }
    }

    let cleanMsg = msg;
    if (errCode === 10 || errSubcode === 2018001) {
      cleanMsg = 'Message cannot be sent: Meta 24-hour messaging window has closed. The customer must message first, or use an approved Meta Template/Tag.';
    } else if (errCode === 190) {
      cleanMsg = 'Facebook Page Access Token has expired. Please reconnect your Facebook Page in Settings.';
    }
    throw new Error(cleanMsg);
  }
}

/**
 * Fetch public profile for customer Facebook PSID (safe initials fallback if restricted)
 */
export async function getCustomerProfile(senderPsid, pageAccessToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE_URL}/${senderPsid}`, {
      params: {
        fields: 'first_name,last_name,profile_pic',
        access_token: pageAccessToken,
      },
      timeout: 3000,
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
 * Fetch public profile for customer Instagram Scoped ID (IGSID)
 */
export async function getInstagramUserProfile(igsid, pageAccessToken) {
  if (!igsid || !pageAccessToken) return { name: null, username: null, profilePic: null };
  try {
    const res = await axios.get(`${GRAPH_BASE_URL}/${igsid}`, {
      params: {
        fields: 'name,username,profile_pic',
        access_token: pageAccessToken,
      },
      timeout: 3000,
    });
    return {
      name: res.data?.name || null,
      username: res.data?.username || null,
      profilePic: res.data?.profile_pic || null,
    };
  } catch {
    return { name: null, username: null, profilePic: null };
  }
}

/**
 * Validate Meta Webhook signature (x-hub-signature-256)
 * Uses constant-time comparison on raw buffer bytes
 */
export function verifyWebhookSignature(signatureHeader, rawBody) {
  if (!META_APP_SECRET) {
    console.warn('[MetaGraph] META_APP_SECRET not configured, skipping signature check in dev');
    return true;
  }
  if (!signatureHeader) {
    return false;
  }
  try {
    const parts = signatureHeader.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') return false;
    const signature = parts[1];

    const hmac = crypto.createHmac('sha256', META_APP_SECRET);
    if (Buffer.isBuffer(rawBody)) {
      hmac.update(rawBody);
    } else if (typeof rawBody === 'string') {
      hmac.update(rawBody, 'utf8');
    } else if (rawBody) {
      hmac.update(JSON.stringify(rawBody), 'utf8');
    } else {
      return false;
    }
    const digest = hmac.digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const digestBuf = Buffer.from(digest, 'hex');

    if (sigBuf.length !== digestBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, digestBuf);
  } catch (err) {
    return false;
  }
}

/**
 * Fetch messages for a specific Instagram thread per Meta Graph API documentation
 */
export async function fetchInstagramThreadMessages(threadId, pageAccessToken, limit = 25) {
  if (!threadId || !pageAccessToken) return [];
  try {
    const res = await axios.get(`${GRAPH_BASE_URL}/${threadId}/messages`, {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
      params: {
        fields: 'id,created_time,from,to,message,shares,attachments',
        limit: Math.min(limit, 50),
      },
      timeout: 15000,
    });
    return res.data?.data || [];
  } catch (err) {
    console.warn(`[MetaGraph] Failed to fetch messages for thread ${threadId}:`, err.response?.data?.error?.message || err.message);
    return [];
  }
}

/**
 * Fetch conversations and their messages from Meta Graph API for a Page or Instagram Account
 * Supports pagination, attachments, and platform-specific query parameters
 */
export async function fetchPageConversations(pageId, pageAccessToken, platform = null, maxPages = 1) {
  if (!pageId || !pageAccessToken) {
    throw new Error('Page ID and Page Access Token are required to fetch conversations');
  }

  const allConversations = [];
  let nextUrl = null;
  let pageCount = 0;

  // Instagram Graph API rejects nested messages on /conversations (Meta Error #1: reduce data requested)
  const isInstagram = platform === 'instagram';
  const params = isInstagram
    ? { fields: 'id,updated_time,participants', limit: 25, platform: 'instagram' }
    : { fields: 'id,snippet,updated_time,participants,messages{id,message,created_time,from,to,attachments}', limit: 25 };

  do {
    try {
      const res = nextUrl
        ? await axios.get(nextUrl, {
            headers: { Authorization: `Bearer ${pageAccessToken}` },
            timeout: 5000,
          })
        : await axios.get(`${GRAPH_BASE_URL}/${pageId}/conversations`, {
            headers: { Authorization: `Bearer ${pageAccessToken}` },
            params,
            timeout: 5000,
          });

      const data = res.data?.data || [];

      // For Instagram, hydrate thread messages in parallel chunks of 5 per Meta documentation
      if (isInstagram && data.length > 0) {
        const chunkSize = 5;
        for (let i = 0; i < data.length; i += chunkSize) {
          const chunk = data.slice(i, i + chunkSize);
          await Promise.all(
            chunk.map(async (conv) => {
              if (!conv.messages?.data) {
                const threadMsgs = await fetchInstagramThreadMessages(conv.id, pageAccessToken, 25);
                conv.messages = { data: threadMsgs };
              }
            })
          );
        }
      }

      allConversations.push(...data);
      nextUrl = res.data?.paging?.next || null;
      pageCount++;
    } catch (err) {
      if (allConversations.length > 0) {
        break; // Return whatever pages were retrieved
      }
      throw err;
    }
  } while (nextUrl && pageCount < maxPages);

  return allConversations;
}

/**
 * Fetch Instagram Direct conversations directly using the Instagram Business Account ID
 */
export async function fetchInstagramConversations(igUserId, pageAccessToken, maxPages = 1) {
  if (!igUserId || !pageAccessToken) {
    throw new Error('Instagram User ID and Page Access Token are required');
  }

  const allConversations = [];
  let nextUrl = null;
  let pageCount = 0;

  do {
    try {
      const res = nextUrl
        ? await axios.get(nextUrl, {
            headers: { Authorization: `Bearer ${pageAccessToken}` },
            timeout: 5000,
          })
        : await axios.get(`${GRAPH_BASE_URL}/${igUserId}/conversations`, {
            headers: { Authorization: `Bearer ${pageAccessToken}` },
            params: { fields: 'id,updated_time,participants', limit: 25 },
            timeout: 5000,
          });

      const data = res.data?.data || [];
      const chunkSize = 5;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map(async (conv) => {
            const threadMsgs = await fetchInstagramThreadMessages(conv.id, pageAccessToken, 25);
            conv.messages = { data: threadMsgs };
          })
        );
      }

      allConversations.push(...data);
      nextUrl = res.data?.paging?.next || null;
      pageCount++;
    } catch (err) {
      if (allConversations.length > 0) break;
      throw err;
    }
  } while (nextUrl && pageCount < maxPages);

  return allConversations;
}
