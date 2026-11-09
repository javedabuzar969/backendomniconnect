// backend/routes/contacts.js — Contacts CRUD API with Supabase
import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// ─── Helper: Normalize contact row from DB → frontend shape ───────────────────
function normalizeContact(row) {
  const meta = row.metadata || {};
  return {
    id: row.id,
    firstName: meta.firstName || (row.name ? row.name.split(' ')[0] : ''),
    lastName: meta.lastName || (row.name ? row.name.split(' ').slice(1).join(' ') : ''),
    name: row.name || '',
    gender: meta.gender || 'Unknown',
    channel: row.channel || 'whatsapp',
    identifier: row.phone_number || row.email || '',
    phone: row.phone_number || '',
    email: row.email || meta.email || '',
    subscribed: row.created_at,
    status: row.status || 'Subscribed',
    automationsPaused: meta.automationsPaused || false,
    tags: row.tags || [],
    sequences: meta.sequences || [],
    optedInThrough: meta.optedInThrough || 'Manually',
    contactTime: meta.contactTime || 'Unknown',
    contactId: row.id,
    workspace_id: row.workspace_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── GET /api/contacts — List all contacts ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, channel, limit = 200, offset = 0, workspace_id } = req.query;

    let query = supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (workspace_id) {
      query = query.eq('workspace_id', workspace_id);
    }

    if (channel && channel !== 'all') {
      query = query.eq('channel', channel);
    }

    if (q) {
      query = query.or(`name.ilike.%${q}%,phone_number.ilike.%${q}%,email.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ contacts: (data || []).map(normalizeContact), total: data?.length || 0 });
  } catch (err) {
    console.error('[contacts] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// ─── GET /api/contacts/:id — Get single contact ───────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Contact not found' });

    res.json(normalizeContact(data));
  } catch (err) {
    console.error('[contacts] GET /:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// ─── POST /api/contacts — Create new contact ──────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      firstName = '',
      lastName = '',
      phone = '',
      email = '',
      gender = 'Male',
      channel = 'whatsapp',
      tags = ['New Lead'],
      optedInThrough = 'Manually',
      workspace_id = null,
    } = req.body;

    const name = `${firstName.trim()} ${lastName.trim()}`.trim() || 'New Contact';

    // phone_number column has UNIQUE constraint — use phone or email as identifier
    const phoneNumber = phone.trim() || email.trim();
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number or email is required' });
    }

    const metadata = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      gender,
      email: email.trim(),
      sequences: [],
      automationsPaused: false,
      optedInThrough,
      contactTime: 'Unknown',
      ...(workspace_id ? { workspaceId: workspace_id } : {}),
    };

    const insertPayload = {
      name,
      phone_number: phoneNumber,
      email: email.trim() || null,
      channel,
      status: 'Subscribed',
      tags,
      metadata,
      last_interaction_at: new Date().toISOString(),
      ...(workspace_id ? { workspace_id } : {}),
    };

    let { data, error } = await supabase
      .from('contacts')
      .insert(insertPayload)
      .select()
      .single();

    // If workspace_id column doesn't exist yet, retry without it
    if (error && error.message?.includes('workspace_id')) {
      delete insertPayload.workspace_id;
      const res2 = await supabase.from('contacts').insert(insertPayload).select().single();
      data = res2.data;
      error = res2.error;
    }

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A contact with this phone number or email already exists.' });
      }
      throw error;
    }

    res.status(201).json(normalizeContact(data));
  } catch (err) {
    console.error('[contacts] POST / error:', err.message);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// ─── PATCH /api/contacts/:id — Update contact ─────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      firstName, lastName, phone, email, gender,
      status, tags, automationsPaused, sequences,
      optedInThrough, contactTime,
    } = req.body;

    // Fetch current row first
    const { data: existing, error: fetchErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const prevMeta = existing.metadata || {};
    const updatedMeta = {
      ...prevMeta,
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...(gender !== undefined ? { gender } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(automationsPaused !== undefined ? { automationsPaused } : {}),
      ...(sequences !== undefined ? { sequences } : {}),
      ...(optedInThrough !== undefined ? { optedInThrough } : {}),
      ...(contactTime !== undefined ? { contactTime } : {}),
    };

    const updatePayload = {
      metadata: updatedMeta,
      updated_at: new Date().toISOString(),
    };

    if (firstName !== undefined || lastName !== undefined) {
      const fName = firstName !== undefined ? firstName : (prevMeta.firstName || '');
      const lName = lastName !== undefined ? lastName : (prevMeta.lastName || '');
      updatePayload.name = `${fName.trim()} ${lName.trim()}`.trim();
    }
    if (status !== undefined) updatePayload.status = status;
    if (tags !== undefined) updatePayload.tags = tags;
    if (email !== undefined) updatePayload.email = email || null;
    if (phone !== undefined) updatePayload.phone_number = phone || existing.phone_number;

    const { data, error } = await supabase
      .from('contacts')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(normalizeContact(data));
  } catch (err) {
    console.error('[contacts] PATCH /:id error:', err.message);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ─── DELETE /api/contacts/:id — Delete contact ────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[contacts] DELETE /:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ─── POST /api/contacts/bulk — Bulk actions ───────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { ids, action, payload = {} } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

    let results = [];

    if (action === 'addTag') {
      const tag = payload.tag;
      if (!tag) return res.status(400).json({ error: 'tag is required' });

      for (const id of ids) {
        const { data: row } = await supabase.from('contacts').select('tags').eq('id', id).maybeSingle();
        if (row) {
          const newTags = Array.from(new Set([...(row.tags || []), tag]));
          const { data } = await supabase.from('contacts').update({ tags: newTags }).eq('id', id).select().single();
          if (data) results.push(normalizeContact(data));
        }
      }
    } else if (action === 'removeTag') {
      const tag = payload.tag;
      if (!tag) return res.status(400).json({ error: 'tag is required' });

      for (const id of ids) {
        const { data: row } = await supabase.from('contacts').select('tags').eq('id', id).maybeSingle();
        if (row) {
          const newTags = (row.tags || []).filter((t) => t.toLowerCase() !== tag.toLowerCase());
          const { data } = await supabase.from('contacts').update({ tags: newTags }).eq('id', id).select().single();
          if (data) results.push(normalizeContact(data));
        }
      }
    } else if (action === 'updateStatus') {
      const { status } = payload;
      if (!status) return res.status(400).json({ error: 'status is required' });
      const { data, error } = await supabase
        .from('contacts')
        .update({ status })
        .in('id', ids)
        .select();
      if (error) throw error;
      results = (data || []).map(normalizeContact);
    } else if (action === 'pauseAutomations') {
      for (const id of ids) {
        const { data: row } = await supabase.from('contacts').select('metadata').eq('id', id).maybeSingle();
        if (row) {
          const meta = { ...(row.metadata || {}), automationsPaused: true };
          const { data } = await supabase.from('contacts').update({ metadata: meta }).eq('id', id).select().single();
          if (data) results.push(normalizeContact(data));
        }
      }
    } else if (action === 'resumeAutomations') {
      for (const id of ids) {
        const { data: row } = await supabase.from('contacts').select('metadata').eq('id', id).maybeSingle();
        if (row) {
          const meta = { ...(row.metadata || {}), automationsPaused: false };
          const { data } = await supabase.from('contacts').update({ metadata: meta }).eq('id', id).select().single();
          if (data) results.push(normalizeContact(data));
        }
      }
    } else if (action === 'subscribeSequence') {
      const { sequence } = payload;
      if (!sequence) return res.status(400).json({ error: 'sequence is required' });
      for (const id of ids) {
        const { data: row } = await supabase.from('contacts').select('metadata').eq('id', id).maybeSingle();
        if (row) {
          const prevMeta = row.metadata || {};
          const sequences = Array.from(new Set([...(prevMeta.sequences || []), sequence]));
          const { data } = await supabase.from('contacts').update({ metadata: { ...prevMeta, sequences } }).eq('id', id).select().single();
          if (data) results.push(normalizeContact(data));
        }
      }
    } else if (action === 'unsubscribeSequence') {
      for (const id of ids) {
        const { data: row } = await supabase.from('contacts').select('metadata').eq('id', id).maybeSingle();
        if (row) {
          const prevMeta = row.metadata || {};
          const { data } = await supabase.from('contacts').update({ metadata: { ...prevMeta, sequences: [] } }).eq('id', id).select().single();
          if (data) results.push(normalizeContact(data));
        }
      }
    } else if (action === 'delete') {
      const { error } = await supabase.from('contacts').delete().in('id', ids);
      if (error) throw error;
      return res.json({ success: true, deleted: ids.length });
    } else {
      return res.status(400).json({ error: `Unknown bulk action: ${action}` });
    }

    res.json({ success: true, updated: results });
  } catch (err) {
    console.error('[contacts] POST /bulk error:', err.message);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

export default router;

