// backend/routes/integrations.js — Handles frontend integrations UI with Supabase
import { Router } from 'express';
import axios from 'axios';
import { supabase, getActiveWhatsAppConfig } from '../lib/supabase.js';
import { getPhoneNumberDetails } from '../lib/whatsapp.js';
import { safeEncryptToken, safeDecryptToken } from '../lib/cryptoUtils.js';
import { requireAuth } from './auth.js';

const router = Router();

// Protect all integration settings routes with authentication
router.use(requireAuth);

/**
 * GET /api/integrations/whatsapp
 * Returns connected WhatsApp accounts for authenticated workspace
 */
router.get('/whatsapp', async (req, res) => {
  try {
    const wsId = req.workspaceId;
    if (!wsId) return res.status(401).json({ error: 'Unauthorized: workspace session required' });

    const config = await getActiveWhatsAppConfig(wsId);
    if (!config || !config.accessToken || !config.phoneNumberId) {
      return res.json({ success: true, data: [] });
    }

    let metaProfile = null;
    try {
      metaProfile = await getPhoneNumberDetails(wsId);
    } catch {}

    const connections = [
      {
        id: config.id || 'wa_conn_default',
        businessName: metaProfile?.verified_name || config.verifiedName || 'WhatsApp Business',
        displayPhoneNumber: metaProfile?.display_phone_number || config.displayPhoneNumber,
        phoneNumberId: config.phoneNumberId,
        wabaId: config.wabaId,
        status: 'Connected',
        qualityRating: metaProfile?.quality_rating || 'GREEN',
        messagingLimit: '250 / 24hrs (Tier 1)',
        connectedAt: new Date().toISOString(),
      },
    ];

    res.json({ success: true, data: connections });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/integrations/whatsapp/connect
 * Secure per-workspace connect with Meta verification, conflict checks, and encryption
 */
router.post('/whatsapp/connect', async (req, res) => {
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

    // 1. Verify with Meta Graph API
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

    // 2. Collision check across other workspaces
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

    // 3. Encrypt and upsert for own workspace
    const encryptedToken = safeEncryptToken(cleanToken);
    const displayPhone = phoneData.display_phone_number || '';
    const verifiedName = phoneData.verified_name || '';

    const { data: ownRows, error: ownErr } = await supabase
      .from('whatsapp_settings')
      .select('id')
      .eq('workspace_id', wsId);

    if (ownErr) throw ownErr;

    let savedId;
    if (ownRows && ownRows.length > 0) {
      const { data: updated, error: updateErr } = await supabase
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
        .eq('workspace_id', wsId)
        .select()
        .single();

      if (updateErr) throw updateErr;
      savedId = updated.id;
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from('whatsapp_settings')
        .insert({
          workspace_id: wsId,
          phone_number_id: cleanPhoneId,
          waba_id: cleanWabaId,
          access_token: encryptedToken,
          display_phone_number: displayPhone,
          verified_name: verifiedName,
          is_active: true,
        })
        .select()
        .single();

      if (insertErr) throw insertErr;
      savedId = inserted.id;
    }

    // 4. Webhook subscribe
    try {
      await axios.post(
        `https://graph.facebook.com/v25.0/${cleanWabaId}/subscribed_apps`,
        {},
        { headers: { Authorization: `Bearer ${cleanToken}` } }
      );
    } catch (_) {}

    res.json({
      success: true,
      data: {
        id: savedId,
        businessName: verifiedName || 'WhatsApp Business',
        displayPhoneNumber: displayPhone,
        phoneNumberId: cleanPhoneId,
        wabaId: cleanWabaId,
        status: 'Connected',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/integrations/whatsapp/:id
 * Disconnects WhatsApp connection by ID, deleting the row
 */
router.delete('/whatsapp/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const wsId = req.workspaceId;

    let query = supabase.from('whatsapp_settings').select('*');
    if (id && id !== 'wa_conn_default') {
      query = query.eq('id', id);
    } else if (wsId) {
      query = query.eq('workspace_id', wsId);
    }

    const { data: rows } = await query;
    const row = rows?.[0];

    if (row) {
      const wabaId = row.waba_id;
      const decryptedToken = safeDecryptToken(row.access_token);

      await supabase.from('whatsapp_settings').delete().eq('id', row.id);

      if (wabaId) {
        const { count } = await supabase
          .from('whatsapp_settings')
          .select('*', { count: 'exact', head: true })
          .eq('waba_id', wabaId);

        if (!count) {
          try {
            await axios.delete(`https://graph.facebook.com/v25.0/${wabaId}/subscribed_apps`, {
              headers: { Authorization: `Bearer ${decryptedToken}` },
            });
          } catch (_) {}
        }
      }
    }

    res.json({ success: true, message: 'WhatsApp account disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
