/**
 * fix-workspace-isolation.js
 * ------------------------------------------------------------------
 * DATABASE FIX SCRIPT — Run once to repair multi-tenancy isolation
 *
 * Problem: Instagram/Facebook contacts have workspace_id = null
 *          which leaks to ALL users via OR filter.
 *
 * Fix:     Set workspace_id = owner's workspace on all null records
 *          so they are ONLY visible to the owner (javedabuzar969@gmail.com)
 *
 * Usage:
 *   cd backend
 *   node scripts/fix-workspace-isolation.js
 * ------------------------------------------------------------------
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const OWNER_WORKSPACE_ID = '32e99783-06da-4c9e-b595-102f7ff20132';

// Use SERVICE ROLE key to bypass RLS (Row Level Security)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

async function fixWorkspaceIsolation() {
  console.log('🔧 Starting workspace isolation fix...\n');

  // ── Step 1: Check how many contacts have null workspace_id ──
  const { count: nullContactsCount, error: countErr } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })
    .is('workspace_id', null);

  if (countErr) {
    console.error('❌ Error counting null contacts:', countErr.message);
  } else {
    console.log(`📊 Contacts with workspace_id = null: ${nullContactsCount}`);
  }

  // ── Step 2: Check how many messages have null workspace_id ──
  const { count: nullMsgCount, error: msgCountErr } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .is('workspace_id', null);

  if (msgCountErr) {
    console.log('⚠️  Messages table may not have workspace_id column — skipping...');
  } else {
    console.log(`📊 Messages with workspace_id = null: ${nullMsgCount}`);
  }

  console.log('\n🔄 Applying fixes...\n');

  // ── Step 3: Fix contacts — assign null workspace contacts to owner ──
  const { data: fixedContacts, error: contactFixErr } = await supabase
    .from('contacts')
    .update({ workspace_id: OWNER_WORKSPACE_ID })
    .is('workspace_id', null)
    .select('id, name, channel');

  if (contactFixErr) {
    console.error('❌ Failed to fix contacts:', contactFixErr.message);
  } else {
    console.log(`✅ Fixed ${fixedContacts?.length ?? 0} contacts — workspace_id set to owner`);
    if (fixedContacts && fixedContacts.length > 0) {
      fixedContacts.forEach(c => console.log(`   • ${c.name || 'Unknown'} [${c.channel}] — id: ${c.id}`));
    }
  }

  // ── Step 4: Fix messages (if column exists) ──
  if (!msgCountErr && nullMsgCount > 0) {
    const { data: fixedMsgs, error: msgFixErr } = await supabase
      .from('messages')
      .update({ workspace_id: OWNER_WORKSPACE_ID })
      .is('workspace_id', null);

    if (msgFixErr) {
      console.error('❌ Failed to fix messages:', msgFixErr.message);
    } else {
      console.log(`✅ Fixed messages — workspace_id set to owner`);
    }
  }

  // ── Step 5: Verify — confirm no null workspace contacts remain ──
  console.log('\n🔍 Verifying fix...\n');

  const { count: remaining, error: verifyErr } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })
    .is('workspace_id', null);

  if (verifyErr) {
    console.error('❌ Verify failed:', verifyErr.message);
  } else if (remaining === 0) {
    console.log('✅ PERFECT — No contacts with null workspace_id remain!');
    console.log('✅ Multi-tenancy isolation is now SAFE.\n');
  } else {
    console.warn(`⚠️  ${remaining} contacts still have null workspace_id`);
  }

  // ── Step 6: Show summary by workspace ──
  const { data: summary } = await supabase
    .from('contacts')
    .select('workspace_id, channel')
    .order('workspace_id');

  if (summary) {
    const grouped = {};
    summary.forEach(c => {
      const key = c.workspace_id || 'NULL';
      if (!grouped[key]) grouped[key] = {};
      grouped[key][c.channel] = (grouped[key][c.channel] || 0) + 1;
    });
    console.log('📋 Final contact distribution by workspace:');
    Object.entries(grouped).forEach(([ws, channels]) => {
      const label = ws === OWNER_WORKSPACE_ID ? `${ws} (OWNER)` : ws;
      console.log(`   workspace: ${label}`);
      Object.entries(channels).forEach(([ch, cnt]) => console.log(`     - ${ch}: ${cnt} contacts`));
    });
  }

  console.log('\n✅ Script complete!\n');
  process.exit(0);
}

fixWorkspaceIsolation().catch(err => {
  console.error('💥 Script crashed:', err.message);
  process.exit(1);
});
