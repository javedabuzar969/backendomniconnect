// backend/routes/whatsapp.js — Express routes for WhatsApp & Supabase
import { Router } from 'express';
import crypto from 'node:crypto';
import axios from 'axios';
import {
  sendWhatsAppTemplate,
  sendWhatsAppText,
  fetchMetaTemplates,
  getPhoneNumberDetails,
} from '../lib/whatsapp.js';
import {
  supabase,
  getActiveWhatsAppConfig,
  upsertContact,
  saveMessage,
  updateMessageStatusByWamid,
} from '../lib/supabase.js';
import { safeEncryptToken, safeDecryptToken } from '../lib/cryptoUtils.js';
import { requireAuth } from './auth.js';

const router = Router();
const FB_APP_SECRET = (process.env.FB_APP_SECRET || process.env.META_APP_SECRET || '').trim();

// ============================================================================
// 1. WhatsApp Connection Status, Connect & Disconnect (Workspace Scoped)
// ============================================================================

/**
 * GET /api/whatsapp/status
 * Scoped to authenticated workspace. Never returns access_token.
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId) return res.status(401).json({ success: false, error: 'Unauthorized: workspace required' });

    const config = await getActiveWhatsAppConfig(wsId);
    if (!config || !config.accessToken || !config.phoneNumberId) {
      return res.json({
        success: true,
        connected: false,
      });
    }

    return res.json({
      success: true,
      connected: true,
      displayPhoneNumber: config.displayPhoneNumber || null,
      verifiedName: config.verifiedName || null,
      phoneNumberId: config.phoneNumberId,
      wabaId: config.wabaId,
    });
  } catch (error) {
    console.error('[WhatsApp Status Error]:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/whatsapp/connect
 * Connect / reconnect WhatsApp credentials for authenticated workspace.
 * Verifies with Meta, checks collisions (409), encrypts token, updates own row.
 */
router.post('/connect', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId) return res.status(401).json({ success: false, error: 'Unauthorized: workspace session required' });

    const { phoneNumberId, wabaId, accessToken } = req.body;
    const cleanPhoneId = phoneNumberId ? String(phoneNumberId).trim() : '';
    const cleanWabaId = wabaId ? String(wabaId).trim() : '';
    const cleanToken = accessToken ? String(accessToken).trim() : '';

    if (!cleanPhoneId || !cleanWabaId || !cleanToken) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumberId, wabaId, and accessToken are required',
      });
    }

    // 1. Verify token & phone number with Meta Graph API
    let phoneData;
    try {
      const resp = await axios.get(
        `https://graph.facebook.com/v25.0/${cleanPhoneId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${cleanToken}` } }
      );
      phoneData = resp.data;
    } catch (err) {
      const metaErr = err.response?.data?.error?.message || err.message;
      return res.status(400).json({
        success: false,
        error: `Invalid WhatsApp credentials or phone number: ${metaErr}`,
      });
    }

    // 2. Verify phone number belongs to the supplied WABA
    try {
      const wabaResp = await axios.get(
        `https://graph.facebook.com/v25.0/${cleanWabaId}/phone_numbers`,
        { headers: { Authorization: `Bearer ${cleanToken}` } }
      );
      const numbers = wabaResp.data?.data || [];
      if (numbers.length > 0) {
        const matched = numbers.some((n) => String(n.id) === cleanPhoneId);
        if (!matched) {
          return res.status(400).json({
            success: false,
            error: `Phone Number ID ${cleanPhoneId} does not belong to WABA ${cleanWabaId}`,
          });
        }
      }
    } catch (err) {
      console.warn('[WhatsApp Connect] WABA phone numbers check warning:', err.response?.data || err.message);
    }

    // 3. Collision Check: check if phone_number_id is already in use by another workspace
    const { data: existingRows, error: lookupErr } = await supabase
      .from('whatsapp_settings')
      .select('id, workspace_id, phone_number_id')
      .eq('phone_number_id', cleanPhoneId);

    if (lookupErr) throw lookupErr;

    if (existingRows && existingRows.length > 0) {
      const foreign = existingRows.find((r) => r.workspace_id !== wsId);
      if (foreign) {
        return res.status(409).json({
          success: false,
          error: 'This WhatsApp Phone Number ID is already connected to another workspace.',
        });
      }
    }

    // 4. Encrypt token and upsert (UPDATE if own workspace already has a row, else INSERT)
    const encryptedToken = safeEncryptToken(cleanToken);
    const displayPhone = phoneData.display_phone_number || '';
    const verifiedName = phoneData.verified_name || '';

    const { data: ownRows, error: ownErr } = await supabase
      .from('whatsapp_settings')
      .select('id')
      .eq('workspace_id', wsId);

    if (ownErr) throw ownErr;

    if (ownRows && ownRows.length > 0) {
      // Reconnect: update existing workspace row
      const { error: updateErr } = await supabase
        .from('whatsapp_settings')
        .update({
          phone_number_id: cleanPhoneId,
          waba_id: cleanWabaId,
          access_token: encryptedToken,
          display_phone_number: displayPhone,
          verified_name: verifiedName,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', wsId);

      if (updateErr) throw updateErr;
    } else {
      // New connection: insert row
      const { error: insertErr } = await supabase
        .from('whatsapp_settings')
        .insert({
          workspace_id: wsId,
          phone_number_id: cleanPhoneId,
          waba_id: cleanWabaId,
          access_token: encryptedToken,
          display_phone_number: displayPhone,
          verified_name: verifiedName,
          is_active: true,
        });

      if (insertErr) throw insertErr;
    }

    // 5. Subscribe WABA to webhook
    try {
      await axios.post(
        `https://graph.facebook.com/v25.0/${cleanWabaId}/subscribed_apps`,
        {},
        { headers: { Authorization: `Bearer ${cleanToken}` } }
      );
      console.log(`[WhatsApp Connect] Subscribed webhook for WABA ${cleanWabaId}`);
    } catch (subErr) {
      console.warn(`[WhatsApp Connect] Could not subscribe webhook:`, subErr.response?.data || subErr.message);
    }

    return res.json({
      success: true,
      message: 'WhatsApp connected successfully',
      data: {
        phoneNumberId: cleanPhoneId,
        wabaId: cleanWabaId,
        displayPhoneNumber: displayPhone,
        verifiedName,
      },
    });
  } catch (error) {
    console.error('[WhatsApp Connect Error]:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/whatsapp/disconnect
 * Disconnects WhatsApp for authenticated workspace.
 * Deletes the database row and unsubscribes Meta webhook ONLY if no other workspace uses this WABA.
 */
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId) return res.status(401).json({ success: false, error: 'Unauthorized: workspace required' });

    // Fetch existing row to retrieve WABA and token
    const { data: rows, error: fetchErr } = await supabase
      .from('whatsapp_settings')
      .select('*')
      .eq('workspace_id', wsId);

    if (fetchErr) throw fetchErr;

    if (!rows || rows.length === 0) {
      return res.json({ success: true, message: 'WhatsApp was not connected' });
    }

    const row = rows[0];
    const wabaId = row.waba_id;
    const decryptedToken = safeDecryptToken(row.access_token);

    // 1. DELETE row from whatsapp_settings
    const { error: delErr } = await supabase
      .from('whatsapp_settings')
      .delete()
      .eq('workspace_id', wsId);

    if (delErr) throw delErr;

    // 2. Unsubscribe Meta webhook only if no other row in whatsapp_settings uses this waba_id
    if (wabaId) {
      const { count, error: countErr } = await supabase
        .from('whatsapp_settings')
        .select('*', { count: 'exact', head: true })
        .eq('waba_id', wabaId);

      if (!countErr && (count === 0 || count === null)) {
        try {
          await axios.delete(`https://graph.facebook.com/v25.0/${wabaId}/subscribed_apps`, {
            headers: { Authorization: `Bearer ${decryptedToken}` },
          });
          console.log(`[WhatsApp Disconnect] Unsubscribed WABA ${wabaId} from Meta`);
        } catch (unsubErr) {
          console.warn(`[WhatsApp Disconnect] Webhook unsubscribe warning:`, unsubErr.response?.data || unsubErr.message);
        }
      } else {
        console.log(`[WhatsApp Disconnect] WABA ${wabaId} still used by other connection(s); skipped Meta unsubscribe.`);
      }
    }

    res.json({ success: true, message: 'WhatsApp disconnected successfully' });
  } catch (error) {
    console.error('[WhatsApp Disconnect Error]:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 2. Sending Messages (Template & Text)
// ============================================================================

/**
 * POST /api/whatsapp/send-template
 * Send WhatsApp template message
 */
router.post('/send-template', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const config = await getActiveWhatsAppConfig(wsId);
    if (!config) {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    const {
      to,
      templateName = 'jaspers_market_order_confirmation_v1',
      languageCode = 'en_US',
      components = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'John Doe' },
            { type: 'text', text: '123456' },
            { type: 'text', text: 'Sep 28, 2026' },
          ],
        },
      ],
      customerName,
    } = req.body;

    if (!to) {
      return res.status(400).json({ success: false, error: 'Recipient phone number "to" is required' });
    }

    const result = await sendWhatsAppTemplate({
      to,
      templateName,
      languageCode,
      components,
      customerName,
      workspaceId: wsId,
    });

    res.json({
      success: true,
      message: 'Template message sent successfully 🚀',
      data: result,
    });
  } catch (error) {
    if (error.message === 'WhatsApp not connected') {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/whatsapp/send-text
 * Send standard WhatsApp text message
 */
router.post('/send-text', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const config = await getActiveWhatsAppConfig(wsId);
    if (!config) {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    const { to, text, customerName, previewUrl = false } = req.body;

    if (!to || !text) {
      return res.status(400).json({ success: false, error: '"to" and "text" are required' });
    }

    const result = await sendWhatsAppText({
      to,
      text,
      customerName,
      previewUrl,
      workspaceId: wsId,
    });

    res.json({
      success: true,
      message: 'Text message sent successfully 🚀',
      data: result,
    });
  } catch (error) {
    if (error.message === 'WhatsApp not connected') {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 3. Fetch Templates & Chat History from Supabase
// ============================================================================

router.get('/templates', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const config = await getActiveWhatsAppConfig(wsId);
    if (!config) {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    const templates = await fetchMetaTemplates(wsId);
    res.json({ success: true, data: templates });
  } catch (error) {
    if (error.message === 'WhatsApp not connected') {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/messages', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const { phoneNumber, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('messages')
      .select('*, contacts(name, phone_number, tags)')
      .eq('workspace_id', wsId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (phoneNumber) {
      query = query.eq('phone_number', String(phoneNumber).replace(/[^\d+]/g, ''));
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/contacts', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const { search, limit = 100 } = req.query;
    let query = supabase
      .from('contacts')
      .select('*')
      .eq('workspace_id', wsId)
      .order('last_interaction_at', { ascending: false })
      .limit(Number(limit));

    if (search) {
      query = query.or(`name.ilike.%${search}%,phone_number.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/contacts', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const { phoneNumber, name, tags, email } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }

    const contact = await upsertContact({
      phoneNumber,
      name,
      tags: tags || ['Lead'],
      workspaceId: wsId,
    });

    if (email) {
      await supabase.from('contacts').update({ email }).eq('id', contact.id).eq('workspace_id', wsId);
    }

    res.json({ success: true, data: contact });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 4. WhatsApp Broadcast Campaign
// ============================================================================
router.post('/broadcast', requireAuth, async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId || wsId === 'default_workspace') {
      return res.status(401).json({ success: false, error: 'Unauthorized: valid workspace required' });
    }

    const config = await getActiveWhatsAppConfig(wsId);
    if (!config) {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }

    const {
      name,
      recipients = [], // Array of phone numbers or objects: [{ phone: '92301...', name: 'Ali' }]
      templateName = 'jaspers_market_order_confirmation_v1',
      languageCode = 'en_US',
      components = [],
      messageText,
    } = req.body;

    if (!name || (!recipients.length && !messageText && !templateName)) {
      return res.status(400).json({
        success: false,
        error: 'name and at least one recipient are required',
      });
    }

    // 1. Create Broadcast record in Supabase
    const { data: broadcast, error: bcError } = await supabase
      .from('broadcasts')
      .insert({
        workspace_id: wsId,
        name,
        channel: 'whatsapp',
        message_type: templateName ? 'template' : 'text',
        template_name: templateName,
        template_params: components,
        message_text: messageText,
        total_recipients: recipients.length,
        status: 'processing',
      })
      .select()
      .single();

    if (bcError) throw bcError;

    // 2. Dispatch messages to all recipients
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const recipient of recipients) {
      const phone = typeof recipient === 'string' ? recipient : recipient.phone || recipient.phoneNumber;
      const contactName = typeof recipient === 'object' ? recipient.name : null;

      try {
        let sentResult;
        if (templateName) {
          sentResult = await sendWhatsAppTemplate({
            to: phone,
            templateName,
            languageCode,
            components,
            customerName: contactName,
            workspaceId: wsId,
          });
        } else {
          sentResult = await sendWhatsAppText({
            to: phone,
            text: messageText,
            customerName: contactName,
            workspaceId: wsId,
          });
        }

        successCount++;
        results.push({ phone, status: 'sent', wamid: sentResult.wamid });

        await supabase.from('broadcast_recipients').insert({
          broadcast_id: broadcast.id,
          phone_number: phone,
          whatsapp_message_id: sentResult.wamid,
          status: 'sent',
        });
      } catch (err) {
        failCount++;
        results.push({ phone, status: 'failed', error: err.message });

        await supabase.from('broadcast_recipients').insert({
          broadcast_id: broadcast.id,
          phone_number: phone,
          status: 'failed',
          error_details: err.message,
        });
      }
    }

    // 3. Update Broadcast final status
    await supabase
      .from('broadcasts')
      .update({
        status: 'completed',
        success_count: successCount,
        failure_count: failCount,
      })
      .eq('id', broadcast.id);

    res.json({
      success: true,
      broadcastId: broadcast.id,
      total: recipients.length,
      successCount,
      failCount,
      results,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 5. Meta Webhook Verification & Event Handler
// ============================================================================

/**
 * GET /api/whatsapp/webhook
 * Meta webhook verification challenge
 */
router.get('/webhook', async (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const validTokens = [
      process.env.FB_WEBHOOK_VERIFY_TOKEN,
      process.env.META_WEBHOOK_VERIFY_TOKEN,
    ].map((t) => t?.trim()).filter(Boolean);

    if (mode === 'subscribe' && token && validTokens.includes(token)) {
      console.log('✅ Meta Webhook verified successfully');
      return res.status(200).send(challenge);
    }
    console.warn('❌ Webhook verification token mismatch. Received:', token);
    return res.status(403).json({ error: 'Webhook verification token mismatch' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/whatsapp/webhook
 * Incoming messages and message delivery status receipts from Meta
 * Enforces X-Hub-Signature-256 verification and workspace isolation
 */
router.post('/webhook', async (req, res) => {
  try {
    const sigHeader = req.headers['x-hub-signature-256'];
    const rawPayload = req.rawBody;

    // 1. Signature verification using raw request body and FB_APP_SECRET
    if (!sigHeader || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
      console.warn('[WhatsApp Webhook] Missing or malformed x-hub-signature-256 header.');
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
      console.warn('[WhatsApp Webhook] Invalid webhook signature rejected.');
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    // 2. Audit log verified webhook payload in Supabase (only after signature check passes)
    try {
      await supabase.from('whatsapp_webhooks_log').insert({
        event_type: req.body?.entry?.[0]?.changes?.[0]?.field || req.body?.object || 'whatsapp_event',
        payload: req.body,
      });
    } catch (_) {}

    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;
          const phoneNumberId = value?.metadata?.phone_number_id;

          // Resolve workspace_id from whatsapp_settings
          let workspaceId = null;
          if (phoneNumberId) {
            const { data: setting } = await supabase
              .from('whatsapp_settings')
              .select('workspace_id')
              .eq('phone_number_id', String(phoneNumberId))
              .eq('is_active', true)
              .maybeSingle();
            workspaceId = setting?.workspace_id || null;
          }

          if (!workspaceId) {
            console.warn(`[WhatsApp Webhook] No active workspace found for phone_number_id "${phoneNumberId}". Skipping message processing.`);
            continue;
          }

          // 1. Process Status Receipts (delivered, read, failed)
          if (value?.statuses && value.statuses.length > 0) {
            for (const statusObj of value.statuses) {
              const wamid = statusObj.id;
              const status = statusObj.status; // sent, delivered, read, failed
              const errorDetails = statusObj.errors ? JSON.stringify(statusObj.errors) : null;
              await updateMessageStatusByWamid(wamid, status, errorDetails);
            }
          }

          // 2. Process Inbound Messages (User replying to WhatsApp)
          if (value?.messages && value.messages.length > 0) {
            const contactInfo = value.contacts?.[0];
            const contactName = contactInfo?.profile?.name;

            for (const message of value.messages) {
              const senderPhone = message.from;
              const wamid = message.id;
              let content = '';
              const msgType = message.type || 'text';

              if (msgType === 'text') {
                content = message.text?.body;
              } else if (msgType === 'interactive') {
                content = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title;
              } else {
                content = `[${msgType} message]`;
              }

              // Save contact with workspaceId
              const contact = await upsertContact({
                phoneNumber: senderPhone,
                name: contactName,
                channel: 'whatsapp',
                workspaceId,
              });

              // Save inbound message with workspaceId
              await saveMessage({
                contactId: contact?.id,
                phoneNumber: senderPhone,
                direction: 'inbound',
                messageType: msgType,
                content,
                whatsappMessageId: wamid,
                status: 'delivered',
                rawPayload: message,
                workspaceId,
              });
            }
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    res.status(404).send('Not a WhatsApp event');
  } catch (error) {
    console.error('[Webhook Error]', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
