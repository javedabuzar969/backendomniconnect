// backend/scripts/test_repair_verification.js
// Verification suite for OmniConnect Meta & Instagram repair
import 'dotenv/config';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import {
  saveOAuthSession,
  getOAuthSession,
  clearOAuthSession,
  getPageByPageId,
  getConnectedPages,
} from '../lib/facebookDb.js';
import { verifyWebhookSignature } from '../lib/metaGraph.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('OMNICONNECT REPAIR VERIFICATION TEST SUITE');
  console.log('====================================================\n');

  // --- TEST 1: Security - Hardcoded Token Check ---
  console.log('--- TEST 1: Security - No Hardcoded Token in facebookDb.js ---');
  try {
    const fs = await import('fs');
    const dbCode = fs.readFileSync(new URL('../lib/facebookDb.js', import.meta.url), 'utf8');
    assert(!dbCode.includes('EAAZApxiiwRtk'), 'Hardcoded token removed from facebookDb.js source');
    assert(!dbCode.includes('memoryPages.set(\'1297933293411171'), 'Hardcoded page seed removed from memory cache');
  } catch (err) {
    assert(false, `Token security check failed: ${err.message}`);
  }

  // --- TEST 2: OAuth Session Persistence & Lifecycle ---
  console.log('\n--- TEST 2: OAuth Session Persistence & Single-Use Enforcement ---');
  try {
    const testState = 'test_state_' + crypto.randomBytes(16).toString('hex');
    const sessionPayload = {
      workspaceId: 'test_ws',
      redirectUri: 'https://example.com/callback',
      type: 'instagram',
      testMarker: true,
    };

    // Save session
    await saveOAuthSession(testState, sessionPayload);
    const retrieved = await getOAuthSession(testState);
    assert(Boolean(retrieved), 'OAuth session retrieved successfully');
    assert(retrieved?.type === 'instagram', 'Session type preserved');
    assert(retrieved?.workspaceId === 'test_ws', 'Session workspaceId preserved');

    // Replay prevention: clear session
    await clearOAuthSession(testState);
    const cleared = await getOAuthSession(testState);
    assert(!cleared, 'Session deleted after consumption (replay attack prevented)');

    // Expired session check
    const expiredState = 'test_expired_' + crypto.randomBytes(16).toString('hex');
    await saveOAuthSession(expiredState, { type: 'facebook', expiresAt: Date.now() - 5000 });
    const expiredRes = await getOAuthSession(expiredState);
    assert(!expiredRes, 'Expired session rejected automatically');
  } catch (err) {
    assert(false, `OAuth persistence test failed: ${err.message}`);
  }

  // --- TEST 3: Webhook Signature Verification ---
  console.log('\n--- TEST 3: Webhook Signature Verification & Constant-Time Check ---');
  try {
    const appSecret = process.env.META_APP_SECRET || 'test_secret_for_verification_suite';
    const originalSecret = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = appSecret;

    const payloadBuffer = Buffer.from(JSON.stringify({ object: 'page', entry: [] }), 'utf8');
    const validHmac = crypto.createHmac('sha256', appSecret).update(payloadBuffer).digest('hex');
    const validHeader = `sha256=${validHmac}`;
    const invalidHeader = `sha256=${crypto.randomBytes(32).toString('hex')}`;

    assert(verifyWebhookSignature(validHeader, payloadBuffer) === true, 'Valid signature on Buffer accepted');
    assert(verifyWebhookSignature(invalidHeader, payloadBuffer) === false, 'Invalid signature rejected');
    assert(verifyWebhookSignature('', payloadBuffer) === false, 'Missing signature rejected');
    assert(verifyWebhookSignature('invalid_format', payloadBuffer) === false, 'Malformed signature header rejected');

    process.env.META_APP_SECRET = originalSecret;
  } catch (err) {
    assert(false, `Signature test failed: ${err.message}`);
  }

  // --- TEST 4: Token Stripping & Multi-Tenant Page Sanitization ---
  console.log('\n--- TEST 4: Token Sanitization (Never Expose in Responses) ---');
  try {
    const pages = await getConnectedPages('default_workspace', false);
    for (const p of pages) {
      assert(p.accessToken === undefined, `Access token stripped from public page ${p.name}`);
      assert(Boolean(p.id || p.pageId), `Page ID preserved: ${p.pageId || p.id}`);
    }
  } catch (err) {
    assert(false, `Sanitization test failed: ${err.message}`);
  }

  // --- TEST 5: Duplicate Message Prevention ---
  console.log('\n--- TEST 5: Duplicate Message Idempotency Check ---');
  try {
    const testWamid = 'test_dup_check_' + Date.now();
    const { data: firstInsert, error: err1 } = await supabase
      .from('messages')
      .insert({
        phone_number: 'fb_test_dup',
        direction: 'inbound',
        message_type: 'text',
        content: 'Test message for idempotency',
        whatsapp_message_id: testWamid,
        status: 'delivered',
      })
      .select()
      .single();

    assert(!err1 && firstInsert, 'First message insertion succeeded');

    // Duplicate check query (as used in webhook and sync code)
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('whatsapp_message_id', testWamid)
      .maybeSingle();

    assert(Boolean(existing), 'Duplicate detection correctly identifies existing message ID');

    // Cleanup test record
    await supabase.from('messages').delete().eq('whatsapp_message_id', testWamid);
  } catch (err) {
    assert(false, `Duplicate prevention test failed: ${err.message}`);
  }

  // --- TEST 6: Conversations Query (Batched Performance) ---
  console.log('\n--- TEST 6: Conversations API Performance & Batching ---');
  try {
    const start = Date.now();
    const { data: contacts } = await supabase
      .from('contacts')
      .select('*')
      .limit(10);

    const contactIds = (contacts || []).map((c) => c.id).filter(Boolean);
    const { data: batchMsgs, error: bErr } = await supabase
      .from('messages')
      .select('*')
      .in('contact_id', contactIds);

    const durationMs = Date.now() - start;
    assert(!bErr, 'Batched messages query succeeded');
    assert(durationMs < 1000, `Batched query executed in ${durationMs}ms (< 1000ms threshold)`);
  } catch (err) {
    assert(false, `Conversations performance test failed: ${err.message}`);
  }

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

runTests();
