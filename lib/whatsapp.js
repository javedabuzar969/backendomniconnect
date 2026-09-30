// backend/lib/whatsapp.js — Meta WhatsApp Cloud API Client
import axios from 'axios';
import { getActiveWhatsAppConfig, upsertContact, saveMessage } from './supabase.js';

/**
 * Send a WhatsApp Template Message (like jaspers_market_order_confirmation_v1)
 */
export async function sendWhatsAppTemplate({
  to,
  templateName,
  languageCode = 'en_US',
  components = [],
  customerName = null,
}) {
  const config = await getActiveWhatsAppConfig();
  const cleanTo = String(to).replace(/[^\d]/g, '');

  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: cleanTo,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: languageCode,
      },
      ...(components && components.length > 0 ? { components } : {}),
    },
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const wamid = response.data?.messages?.[0]?.id;

    // Persist contact in Supabase
    const contact = await upsertContact({
      phoneNumber: cleanTo,
      name: customerName,
      channel: 'whatsapp',
    });

    // Persist message in Supabase
    const savedMsg = await saveMessage({
      contactId: contact?.id,
      phoneNumber: cleanTo,
      direction: 'outbound',
      messageType: 'template',
      content: `Template: ${templateName}`,
      templateName,
      templateParams: components,
      whatsappMessageId: wamid,
      status: 'sent',
      rawPayload: response.data,
    });

    return {
      success: true,
      wamid,
      metaResponse: response.data,
      dbRecord: savedMsg,
    };
  } catch (error) {
    const errData = error.response?.data || error.message;
    console.error('[WhatsApp Cloud API] Send Template Error:', errData);

    // Save failed attempt to Supabase
    await saveMessage({
      phoneNumber: cleanTo,
      direction: 'outbound',
      messageType: 'template',
      content: `Template: ${templateName}`,
      templateName,
      templateParams: components,
      status: 'failed',
      errorMessage: JSON.stringify(errData),
      rawPayload: { error: errData },
    });

    throw new Error(
      error.response?.data?.error?.message ||
      (typeof errData === 'string' ? errData : JSON.stringify(errData))
    );
  }
}

/**
 * Send a Standard Text Message
 */
export async function sendWhatsAppText({ to, text, customerName = null, previewUrl = false }) {
  const config = await getActiveWhatsAppConfig();
  const cleanTo = String(to).replace(/[^\d]/g, '');

  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanTo,
    type: 'text',
    text: {
      preview_url: previewUrl,
      body: text,
    },
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const wamid = response.data?.messages?.[0]?.id;

    const contact = await upsertContact({
      phoneNumber: cleanTo,
      name: customerName,
      channel: 'whatsapp',
    });

    const savedMsg = await saveMessage({
      contactId: contact?.id,
      phoneNumber: cleanTo,
      direction: 'outbound',
      messageType: 'text',
      content: text,
      whatsappMessageId: wamid,
      status: 'sent',
      rawPayload: response.data,
    });

    return {
      success: true,
      wamid,
      metaResponse: response.data,
      dbRecord: savedMsg,
    };
  } catch (error) {
    const errData = error.response?.data || error.message;
    console.error('[WhatsApp Cloud API] Send Text Error:', errData);

    await saveMessage({
      phoneNumber: cleanTo,
      direction: 'outbound',
      messageType: 'text',
      content: text,
      status: 'failed',
      errorMessage: JSON.stringify(errData),
      rawPayload: { error: errData },
    });

    throw new Error(
      error.response?.data?.error?.message ||
      (typeof errData === 'string' ? errData : JSON.stringify(errData))
    );
  }
}

/**
 * Fetch approved message templates from Meta WABA account
 */
export async function fetchMetaTemplates() {
  const config = await getActiveWhatsAppConfig();
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.wabaId}/message_templates`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
    },
  });

  return response.data;
}

/**
 * Fetch WhatsApp Phone Number info & status
 */
export async function getPhoneNumberDetails() {
  const config = await getActiveWhatsAppConfig();
  const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
    },
  });

  return response.data;
}
