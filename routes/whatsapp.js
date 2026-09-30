// backend/routes/whatsapp.js — Express routes for WhatsApp & Supabase
import { Router } from 'express';
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

const router = Router();

// ============================================================================
// 1. WhatsApp Connection Status & Settings
// ============================================================================
router.get('/status', async (req, res) => {
  try {
    const config = await getActiveWhatsAppConfig();
    let metaInfo = null;
    let metaError = null;

    try {
      metaInfo = await getPhoneNumberDetails();
    } catch (err) {
      metaError = err.message;
    }

    // Check Supabase connection
    const { count, error: sbError } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });

    res.json({
      success: true,
      whatsapp: {
        connected: !metaError,
        phoneNumberId: config.phoneNumberId,
        wabaId: config.wabaId,
        displayPhoneNumber: metaInfo?.display_phone_number || config.displayPhoneNumber,
        verifiedName: metaInfo?.verified_name,
        qualityRating: metaInfo?.quality_rating,
        error: metaError,
      },
      supabase: {
        connected: !sbError,
        error: sbError ? sbError.message : null,
        contactsCount: count ?? 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/config', async (req, res) => {
  try {
    const config = await getActiveWhatsAppConfig();
    res.json({
      success: true,
      data: {
        phoneNumberId: config.phoneNumberId,
        wabaId: config.wabaId,
        displayPhoneNumber: config.displayPhoneNumber,
        apiVersion: config.apiVersion,
        hasAccessToken: Boolean(config.accessToken),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/config', async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, displayPhoneNumber, apiVersion } = req.body;

    if (!phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumberId, wabaId, and accessToken are required',
      });
    }

    const { data, error } = await supabase
      .from('whatsapp_settings')
      .insert({
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: accessToken,
        display_phone_number: displayPhoneNumber,
        api_version: apiVersion || 'v25.0',
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Settings saved to Supabase', data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 2. Sending Messages (Template & Text)
// ============================================================================

/**
 * POST /api/whatsapp/send-template
 * Send WhatsApp template message (e.g. jaspers_market_order_confirmation_v1)
 */
router.post('/send-template', async (req, res) => {
  try {
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
    });

    res.json({
      success: true,
      message: 'Template message sent successfully 🚀',
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/whatsapp/send-text
 * Send standard WhatsApp text message
 */
router.post('/send-text', async (req, res) => {
  try {
    const { to, text, customerName, previewUrl = false } = req.body;

    if (!to || !text) {
      return res.status(400).json({ success: false, error: '"to" and "text" are required' });
    }

    const result = await sendWhatsAppText({
      to,
      text,
      customerName,
      previewUrl,
    });

    res.json({
      success: true,
      message: 'Text message sent successfully 🚀',
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 3. Fetch Templates & Chat History from Supabase
// ============================================================================

router.get('/templates', async (req, res) => {
  try {
    const templates = await fetchMetaTemplates();
    res.json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/messages', async (req, res) => {
  try {
    const { phoneNumber, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('messages')
      .select('*, contacts(name, phone_number, tags)')
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

router.get('/contacts', async (req, res) => {
  try {
    const { search, limit = 100 } = req.query;
    let query = supabase
      .from('contacts')
      .select('*')
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

router.post('/contacts', async (req, res) => {
  try {
    const { phoneNumber, name, tags, email } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }

    const contact = await upsertContact({
      phoneNumber,
      name,
      tags: tags || ['Lead'],
    });

    if (email) {
      await supabase.from('contacts').update({ email }).eq('id', contact.id);
    }

    res.json({ success: true, data: contact });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 4. WhatsApp Broadcast Campaign
// ============================================================================
router.post('/broadcast', async (req, res) => {
  try {
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
          });
        } else {
          sentResult = await sendWhatsAppText({
            to: phone,
            text: messageText,
            customerName: contactName,
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
    const config = await getActiveWhatsAppConfig();
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const validTokens = [
      config?.webhookVerifyToken,
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      'omniconnect_whatsapp_verify_token_2026',
      'omniconnect_webhook_secret_2026',
      'omniconnect_meta_verify_token_2026'
    ].filter(Boolean);

    if (mode === 'subscribe' && validTokens.includes(token)) {
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
 */
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Log raw webhook payload in Supabase
    await supabase.from('whatsapp_webhooks_log').insert({
      event_type: body.entry?.[0]?.changes?.[0]?.field || 'whatsapp_event',
      payload: body,
    });

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

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

          // Save contact
          const contact = await upsertContact({
            phoneNumber: senderPhone,
            name: contactName,
            channel: 'whatsapp',
          });

          // Save inbound message
          await saveMessage({
            contactId: contact?.id,
            phoneNumber: senderPhone,
            direction: 'inbound',
            messageType: msgType,
            content,
            whatsappMessageId: wamid,
            status: 'delivered',
            rawPayload: message,
          });
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
