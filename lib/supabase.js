// backend/lib/supabase.js — Supabase client & DB helpers
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('⚠️ Supabase URL or Key missing in .env');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export const supabaseAnon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || SUPABASE_KEY);

/**
 * Get active WhatsApp settings from Supabase or fallback to environment variables
 */
export async function getActiveWhatsAppConfig() {
  try {
    const { data, error } = await supabase
      .from('whatsapp_settings')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      return {
        phoneNumberId: data.phone_number_id,
        wabaId: data.waba_id,
        accessToken: data.access_token,
        displayPhoneNumber: data.display_phone_number,
        apiVersion: data.api_version || 'v25.0',
        webhookVerifyToken: data.webhook_verify_token,
      };
    }
  } catch (err) {
    console.warn('[Supabase] Warning fetching config from DB, using fallback .env:', err.message);
  }

  // Fallback to .env values
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    displayPhoneNumber: '+1 (555) 017-6631',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v25.0',
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'omniconnect_whatsapp_verify_token_2026',
  };
}

/**
 * Upsert Contact in Supabase
 */
export async function upsertContact({ phoneNumber, name = null, channel = 'whatsapp', tags = ['Lead'], metadata = {} }) {
  try {
    const cleanPhone = channel === 'whatsapp' ? String(phoneNumber).replace(/[^\d+]/g, '') : String(phoneNumber);
    const { data: existing } = await supabase
      .from('contacts')
      .select('*')
      .eq('phone_number', cleanPhone)
      .maybeSingle();

    if (existing) {
      const updatePayload = {
        last_interaction_at: new Date().toISOString(),
      };
      if (name && (!existing.name || existing.name.startsWith('Facebook User'))) updatePayload.name = name;
      if (channel) updatePayload.channel = channel;
      if (metadata && Object.keys(metadata).length > 0) {
        const mergedMeta = { ...(existing.metadata || {}) };
        for (const [k, v] of Object.entries(metadata)) {
          if (k === 'profilePic' && !v && mergedMeta.profilePic) continue;
          mergedMeta[k] = v;
        }
        updatePayload.metadata = mergedMeta;
      }
      
      const { data, error } = await supabase
        .from('contacts')
        .update(updatePayload)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    } else {
      const { data, error } = await supabase
        .from('contacts')
        .insert({
          phone_number: cleanPhone,
          name: name || `Contact ${cleanPhone.slice(-4)}`,
          channel,
          status: 'Subscribed',
          tags,
          metadata: metadata || {},
          last_interaction_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    }
  } catch (err) {
    console.error('[Supabase] upsertContact error:', err.message);
    return null;
  }
}

/**
 * Save Message (Inbound or Outbound)
 */
export async function saveMessage({
  contactId = null,
  phoneNumber,
  direction,
  messageType = 'text',
  content = null,
  templateName = null,
  templateParams = null,
  whatsappMessageId = null,
  status = 'pending',
  errorMessage = null,
  rawPayload = {},
}) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert({
        contact_id: contactId,
        phone_number: phoneNumber,
        direction,
        message_type: messageType,
        content,
        template_name: templateName,
        template_params: templateParams,
        whatsapp_message_id: whatsappMessageId,
        status,
        error_message: errorMessage,
        raw_payload: rawPayload,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[Supabase] saveMessage error:', err.message);
    return null;
  }
}

/**
 * Update Message Status based on Meta Webhook (sent, delivered, read, failed)
 */
export async function updateMessageStatusByWamid(wamid, status, errorDetails = null) {
  try {
    const updateData = { status };
    if (errorDetails) updateData.error_message = errorDetails;

    const { data, error } = await supabase
      .from('messages')
      .update(updateData)
      .eq('whatsapp_message_id', wamid)
      .select();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[Supabase] updateMessageStatus error:', err.message);
    return null;
  }
}
