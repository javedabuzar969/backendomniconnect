// backend/routes/conversations.js — API for Inbox conversations & live chat
import { Router } from 'express';
import { supabase, saveMessage } from '../lib/supabase.js';
import { sendWhatsAppText } from '../lib/whatsapp.js';
import { sendMessengerText } from '../lib/metaGraph.js';
import { getConnectedPages, getPageByPageId } from '../lib/facebookDb.js';

const router = Router();

/**
 * GET /api/conversations
 * Returns active conversations grouped by contact with last message
 * Loaded strictly from database. No mock data.
 */
router.get('/', async (req, res) => {
  try {
    const { channel, pageId } = req.query;

    // 1. Fetch contacts from Supabase
    let query = supabase
      .from('contacts')
      .select('*')
      .order('last_interaction_at', { ascending: false });

    if (channel && channel !== 'all') {
      query = query.eq('channel', channel);
    }

    const { data: contacts, error: cErr } = await query;

    if (cErr) {
      console.warn('[Conversations API] Contacts query warning:', cErr.message);
      return res.json({ success: true, data: [] });
    }

    if (!contacts || contacts.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // 2. Fetch messages for each contact
    const conversations = [];

    for (const contact of contacts) {
      // Optional multi-page isolation check
      if (pageId && contact.metadata?.pageId && contact.metadata.pageId !== pageId) {
        continue;
      }

      const { data: msgs } = await supabase
        .from('messages')
        .select('*')
        .or(`contact_id.eq.${contact.id},phone_number.eq.${contact.phone_number}`)
        .order('created_at', { ascending: true });

      const messageList = (msgs || []).map((m) => ({
        id: m.id,
        sender: m.direction === 'inbound' ? 'customer' : 'agent',
        text: m.content || (m.template_name ? `Template: ${m.template_name}` : 'Message'),
        time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: m.status,
        createdAt: m.created_at,
        whatsappMessageId: m.whatsapp_message_id,
      }));

      const lastMsg = messageList[messageList.length - 1];

      conversations.push({
        id: contact.id,
        name: contact.name || `+${contact.phone_number}`,
        phoneNumber: contact.phone_number,
        channel: contact.channel || 'whatsapp',
        pageId: contact.metadata?.pageId || null,
        pageName: contact.metadata?.pageName || null,
        lastMessage: lastMsg?.text || 'No messages yet',
        time: lastMsg?.time || 'Recent',
        lastMessageAt: lastMsg?.createdAt || contact.last_interaction_at,
        unread: messageList.some((m) => m.sender === 'customer' && m.status !== 'read'),
        unreadCount: messageList.filter((m) => m.sender === 'customer' && m.status !== 'read').length,
        status: 'open',
        isFavorite: false,
        avatar:
          contact.metadata?.profilePic ||
          `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(contact.name || contact.phone_number)}`,
        messages: messageList,
      });
    }

    res.json({ success: true, data: conversations });
  } catch (error) {
    console.error('[Conversations API Error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/conversations/:id
 * Retrieve single conversation thread
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: contact } = await supabase.from('contacts').select('*').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'Conversation not found' });

    const { data: msgs } = await supabase
      .from('messages')
      .select('*')
      .or(`contact_id.eq.${contact.id},phone_number.eq.${contact.phone_number}`)
      .order('created_at', { ascending: true });

    const messageList = (msgs || []).map((m) => ({
      id: m.id,
      sender: m.direction === 'inbound' ? 'customer' : 'agent',
      text: m.content || m.template_name,
      time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: m.status,
      createdAt: m.created_at,
      whatsappMessageId: m.whatsapp_message_id,
    }));

    res.json({
      success: true,
      data: {
        id: contact.id,
        name: contact.name,
        phoneNumber: contact.phone_number,
        channel: contact.channel || 'whatsapp',
        pageId: contact.metadata?.pageId || null,
        pageName: contact.metadata?.pageName || null,
        messages: messageList,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/conversations/:id/messages
 * Send real reply message from Agent in Inbox to Customer
 * Calls Meta Messenger Send API for Facebook, or Meta Cloud API for WhatsApp.
 */
router.post('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const { data: contact } = await supabase.from('contacts').select('*').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    let sentExternalId = null;
    let sendStatus = 'pending';
    let sendError = null;

    // ── 1. WhatsApp Reply ──────────────────────────────────────────────
    if (contact.channel === 'whatsapp') {
      try {
        const sentWa = await sendWhatsAppText({
          to: contact.phone_number,
          text: content.trim(),
          customerName: contact.name,
        });
        sentExternalId = sentWa?.wamid || null;
        sendStatus = 'sent';
      } catch (waErr) {
        console.error('[WhatsApp Send API Error]:', waErr.message);
        sendError = waErr.message;
        sendStatus = 'failed';
      }
    }

    // ── 2. Facebook Messenger Reply ───────────────────────────────────
    else if (contact.channel === 'facebook') {
      try {
        // Extract customer PSID
        const psid = contact.phone_number.replace(/^fb_/, '');
        const targetPageId = contact.metadata?.pageId;

        // Look up connected page's access token
        let page = null;
        if (targetPageId) {
          page = await getPageByPageId(targetPageId, true);
        }

        // If page not found by targetPageId, get any active connected page
        if (!page || !page.accessToken) {
          const connectedPages = await getConnectedPages(null, true);
          page = connectedPages.find((p) => p.accessToken);
        }

        if (!page || !page.accessToken) {
          throw new Error('No connected Facebook Page access token found. Please reconnect your Facebook Page.');
        }

        // Call official Meta Messenger Send API
        const metaRes = await sendMessengerText(page.accessToken, psid, content.trim());
        sentExternalId = metaRes.messageId;
        sendStatus = 'sent';
        console.log(`[Facebook Reply Sent] To: ${contact.name} (${psid}) - Meta Message ID: ${sentExternalId}`);
      } catch (fbErr) {
        console.error('[Facebook Messenger Send API Error]:', fbErr.message);
        sendError = fbErr.message;
        sendStatus = 'failed';
      }
    }

    // ── 3. Persist Outbound Message in Database ────────────────────────
    const saved = await saveMessage({
      contactId: contact.id,
      phoneNumber: contact.phone_number,
      direction: 'outbound',
      messageType: 'text',
      content: content.trim(),
      whatsappMessageId: sentExternalId || `msg_err_${Date.now()}`,
      status: sendStatus,
      errorMessage: sendError,
    });

    if (sendStatus === 'failed') {
      return res.status(400).json({
        success: false,
        error: sendError || 'Failed to send message via Meta API',
        data: {
          id: saved?.id || `m_${Date.now()}`,
          conversationId: id,
          sender: 'agent',
          text: content.trim(),
          time: 'Just now',
          status: 'failed',
          error: sendError,
        },
      });
    }

    res.json({
      success: true,
      data: {
        id: saved?.id || `m_${Date.now()}`,
        conversationId: id,
        sender: 'agent',
        text: content.trim(),
        time: 'Just now',
        status: 'sent',
        externalId: sentExternalId,
      },
    });
  } catch (error) {
    console.error('[Send Message Error]:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
