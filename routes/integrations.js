// backend/routes/integrations.js — Handles frontend integrations UI with Supabase
import { Router } from 'express';
import { supabase, getActiveWhatsAppConfig } from '../lib/supabase.js';
import { getPhoneNumberDetails } from '../lib/whatsapp.js';

const router = Router();

/**
 * GET /api/integrations/whatsapp
 * Returns connected WhatsApp accounts
 */
router.get('/whatsapp', async (req, res) => {
  try {
    const config = await getActiveWhatsAppConfig();
    let metaProfile = null;

    try {
      metaProfile = await getPhoneNumberDetails();
    } catch {}

    const { data: dbSettings } = await supabase
      .from('whatsapp_settings')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    const activeRecord = dbSettings?.[0];

    const connections = [
      {
        id: activeRecord?.id || 'wa_conn_default',
        businessName: metaProfile?.verified_name || 'Jasper’s Market Demo',
        displayPhoneNumber: metaProfile?.display_phone_number || config.displayPhoneNumber,
        phoneNumberId: config.phoneNumberId,
        wabaId: config.wabaId,
        status: metaProfile ? 'Connected' : 'Active',
        qualityRating: metaProfile?.quality_rating || 'GREEN',
        messagingLimit: '250 / 24hrs (Tier 1)',
        connectedAt: activeRecord?.created_at || new Date().toISOString(),
      },
    ];

    res.json({ success: true, data: connections });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/whatsapp/connect
 */
router.post('/whatsapp/connect', async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, displayPhoneNumber } = req.body;

    const { data, error } = await supabase
      .from('whatsapp_settings')
      .insert({
        phone_number_id: phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
        waba_id: wabaId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
        access_token: accessToken || process.env.WHATSAPP_ACCESS_TOKEN,
        display_phone_number: displayPhoneNumber || '+1 (555) 017-6631',
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: {
        id: data.id,
        businessName: 'Jasper’s Market Demo',
        displayPhoneNumber: data.display_phone_number,
        phoneNumberId: data.phone_number_id,
        wabaId: data.waba_id,
        status: 'Connected',
        connectedAt: data.created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/integrations/whatsapp/:id
 */
router.delete('/whatsapp/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (id !== 'wa_conn_default') {
      await supabase.from('whatsapp_settings').update({ is_active: false }).eq('id', id);
    }
    res.json({ success: true, message: 'WhatsApp account disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
