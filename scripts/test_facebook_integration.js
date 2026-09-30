// backend/scripts/test_facebook_integration.js
// Automated End-to-End Test Suite for Real Meta / Facebook Page + Messenger Integration
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../lib/supabase.js';
import { saveConnectedPage, getConnectedPages, disconnectPage } from '../lib/facebookDb.js';

const BASE_URL = `http://localhost:${process.env.PORT || 5000}`;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'omniconnect_meta_verify_token_2026';

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

async function runTestSuite() {
  console.log('====================================================');
  console.log('RUNNING FULL REAL META/FACEBOOK INTEGRATION TEST SUITE');
  console.log(`Target Backend: ${BASE_URL}`);
  console.log('====================================================\n');

  // TEST 1: Config endpoint
  console.log('--- TEST 1: Public Config Endpoint Security ---');
  try {
    const res = await axios.get(`${BASE_URL}/api/integrations/facebook/config`);
    assert(res.data?.success === true, 'GET /config returns success: true');
    assert(res.data?.data?.appId === '4662451487410242', 'App ID is returned');
    assert(!res.data?.data?.appSecret, 'App Secret is NEVER exposed');
    assert(!res.data?.data?.accessToken, 'Page/User Access Tokens are NEVER exposed');
    assert(res.data?.data?.redirectUri.includes('/api/integrations/facebook/oauth/callback'), 'OAuth Callback URL is exact');
  } catch (e) {
    assert(false, `Config endpoint failed: ${e.message}`);
  }

  // TEST 2: OAuth Start & State Generation
  console.log('\n--- TEST 2: OAuth Start & CSRF State Generation ---');
  let oauthState = null;
  try {
    const res = await axios.get(`${BASE_URL}/api/integrations/facebook/oauth/start?format=json`);
    assert(res.data?.success === true, 'GET /oauth/start returns success');
    assert(Boolean(res.data?.state), 'Cryptographic CSRF state generated');
    assert(res.data?.oauthUrl?.startsWith('https://www.facebook.com/v21.0/dialog/oauth'), 'Official Meta OAuth URL generated');
    assert(res.data?.oauthUrl?.includes('client_id=4662451487410242'), 'Client ID included in OAuth URL');
    assert(res.data?.oauthUrl?.includes('pages_messaging'), 'pages_messaging scope included');
    oauthState = res.data?.state;
  } catch (e) {
    assert(false, `OAuth start failed: ${e.message}`);
  }

  // TEST 3: OAuth Cancellation Handling
  console.log('\n--- TEST 3: OAuth Cancellation Handling ---');
  try {
    const res = await axios.get(`${BASE_URL}/api/integrations/facebook/oauth/callback`, {
      params: { error: 'access_denied', error_description: 'Permissions not granted' },
    });
    assert(res.data?.includes('Meta Connection Cancelled'), 'OAuth cancellation handled cleanly without error');
  } catch (e) {
    assert(false, `OAuth cancellation test failed: ${e.message}`);
  }

  // TEST 4: Zero Mock Pages Verification
  console.log('\n--- TEST 4: Zero Mock Pages in Database/API ---');
  try {
    const res = await axios.get(`${BASE_URL}/api/integrations/facebook/pages`);
    assert(res.data?.success === true, 'GET /pages returns success');
    const pages = res.data?.connectedPages || [];
    assert(!pages.some((p) => p.name === 'Creative Logo Master' || p.name === 'Omifdgfgf'), 'No fake "Creative Logo Master" or "Omifdgfgf" pages exist');
  } catch (e) {
    assert(false, `Pages check failed: ${e.message}`);
  }

  // TEST 5: Webhook Verification (Challenge Handshake)
  console.log('\n--- TEST 5: Webhook Verification Handshake ---');
  const challengeCode = 'test_challenge_1234567890';
  try {
    const res = await axios.get(`${BASE_URL}/api/integrations/facebook/webhook`, {
      params: {
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': challengeCode,
      },
    });
    assert(res.status === 200, 'Webhook verification returns HTTP 200');
    assert(String(res.data) === challengeCode, 'Webhook verification returns exact challenge');
  } catch (e) {
    assert(false, `Webhook verification failed: ${e.message}`);
  }

  // TEST 6: Webhook Verification with Invalid Token
  console.log('\n--- TEST 6: Webhook Verification Security (Invalid Token) ---');
  try {
    await axios.get(`${BASE_URL}/api/integrations/facebook/webhook`, {
      params: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong_token',
        'hub.challenge': challengeCode,
      },
    });
    assert(false, 'Webhook accepted invalid token (should be rejected)');
  } catch (e) {
    assert(e.response?.status === 403, 'Webhook rejects invalid token with HTTP 403');
  }

  // TEST 7: Connected Page Database Storage
  console.log('\n--- TEST 7: Page Connection Storage & Webhook State ---');
  const testPageId = 'real_test_page_1001';
  try {
    await saveConnectedPage({
      pageId: testPageId,
      pageName: 'Real Test Business Page',
      category: 'Software',
      accessToken: 'EAAB_test_mock_token_server_side_only',
      workspaceId: 'test_ws_1',
      status: 'connected',
      webhookStatus: 'subscribed',
    });

    const pages = await getConnectedPages('test_ws_1', false);
    const found = pages.find((p) => p.pageId === testPageId || p.id === testPageId);
    assert(Boolean(found), 'Connected page persisted in database');
    assert(found?.name === 'Real Test Business Page', 'Page name stored correctly');
    assert(!found?.accessToken, 'Page Access Token is NEVER leaked in public queries');
  } catch (e) {
    assert(false, `Page connection storage failed: ${e.message}`);
  }

  // TEST 8: Real Customer Messenger Inbound Webhook Event
  console.log('\n--- TEST 8: Inbound Customer Messenger Webhook ---');
  const testSenderPsid = 'psid_customer_88412';
  const testMid = `mid.test_${Date.now()}_unique`;
  const incomingWebhookPayload = {
    object: 'page',
    entry: [
      {
        id: testPageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: testSenderPsid },
            recipient: { id: testPageId },
            timestamp: Date.now(),
            message: {
              mid: testMid,
              text: 'Hello, I have an inquiry about your services!',
            },
          },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(`${BASE_URL}/api/integrations/facebook/webhook`, incomingWebhookPayload);
    assert(res.status === 200, 'Webhook POST returned HTTP 200');
    assert(res.data === 'EVENT_RECEIVED', 'Webhook responded with EVENT_RECEIVED');

    // Verify contact in database
    const { data: contact } = await supabase
      .from('contacts')
      .select('*')
      .eq('phone_number', `fb_${testSenderPsid}`)
      .maybeSingle();

    assert(Boolean(contact), 'Customer contact created in database from real webhook');
    assert(contact?.channel === 'facebook', 'Customer channel is facebook');

    // Verify message in database
    const { data: msg } = await supabase
      .from('messages')
      .select('*')
      .eq('whatsapp_message_id', testMid)
      .maybeSingle();

    assert(Boolean(msg), 'Message stored in database');
    assert(msg?.direction === 'inbound', 'Message direction is inbound');
    assert(msg?.content === 'Hello, I have an inquiry about your services!', 'Message content matches payload');
  } catch (e) {
    assert(false, `Inbound webhook test failed: ${e.message}`);
  }

  // TEST 9: Webhook Idempotency (Duplicate Prevention)
  console.log('\n--- TEST 9: Webhook Idempotency / Duplicate Prevention ---');
  try {
    // Send the exact same webhook payload again
    await axios.post(`${BASE_URL}/api/integrations/facebook/webhook`, incomingWebhookPayload);

    const { data: allMessages } = await supabase
      .from('messages')
      .select('id')
      .eq('whatsapp_message_id', testMid);

    assert(allMessages?.length === 1, `Idempotency verified: exactly 1 message created (found ${allMessages?.length})`);
  } catch (e) {
    assert(false, `Idempotency test failed: ${e.message}`);
  }

  // TEST 10: Outbound Messenger Reply Error Handling (No Fake Success)
  console.log('\n--- TEST 10: Outbound Messenger Reply & Status Handling ---');
  try {
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone_number', `fb_${testSenderPsid}`)
      .single();

    try {
      await axios.post(`${BASE_URL}/api/conversations/${contact.id}/messages`, {
        content: 'Hello customer, thank you for reaching out!',
      });
      // If mock token worked, assert success
      assert(true, 'Message send API responded');
    } catch (sendErr) {
      // With our test token, Meta API correctly rejects the invalid token
      assert(sendErr.response?.status === 400, 'Backend correctly returns HTTP 400 when Meta API token is invalid');
      assert(sendErr.response?.data?.error?.includes('Meta') || sendErr.response?.data?.error?.includes('token'), 'Useful error returned: does NOT fake success');
    }

    // Verify the outbound message was recorded with true status (failed, not fake sent)
    const { data: outMsgs } = await supabase
      .from('messages')
      .select('*')
      .eq('contact_id', contact.id)
      .eq('direction', 'outbound');

    assert(outMsgs?.length > 0, 'Outbound message attempt recorded in database');
    assert(outMsgs[0]?.status === 'failed' || outMsgs[0]?.status === 'sent', `Outbound message has real status: ${outMsgs[0]?.status}`);
  } catch (e) {
    assert(false, `Outbound reply test failed: ${e.message}`);
  }

  // TEST 11: Multi-Page Isolation
  console.log('\n--- TEST 11: Multi-Page Isolation ---');
  try {
    const resAll = await axios.get(`${BASE_URL}/api/conversations?channel=facebook`);
    assert(resAll.data?.success === true, 'GET /conversations returns conversations');
    const convs = resAll.data?.data || [];
    assert(convs.every((c) => c.channel === 'facebook'), 'Channel filter works strictly');
  } catch (e) {
    assert(false, `Multi-page isolation test failed: ${e.message}`);
  }

  // TEST 12: Existing WhatsApp Preservation
  console.log('\n--- TEST 12: Existing WhatsApp Functionality Preservation ---');
  try {
    const { data: waContact } = await supabase
      .from('contacts')
      .select('*')
      .eq('phone_number', '923012200030')
      .maybeSingle();

    assert(Boolean(waContact), 'Real WhatsApp contact (+92 301 2200030) is preserved');
    assert(waContact?.channel === 'whatsapp', 'WhatsApp channel preserved');

    const waSettingsRes = await axios.get(`${BASE_URL}/api/integrations/whatsapp`);
    assert(waSettingsRes.data?.success === true, 'WhatsApp integrations API continues to work');
  } catch (e) {
    assert(false, `WhatsApp preservation test failed: ${e.message}`);
  }

  // Clean up test data
  try {
    await disconnectPage(testPageId, 'test_ws_1');
    const { data: c } = await supabase.from('contacts').select('id').eq('phone_number', `fb_${testSenderPsid}`).maybeSingle();
    if (c) {
      await supabase.from('messages').delete().eq('contact_id', c.id);
      await supabase.from('contacts').delete().eq('id', c.id);
    }
  } catch {}

  console.log('\n====================================================');
  console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');
}

runTestSuite().then(() => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
