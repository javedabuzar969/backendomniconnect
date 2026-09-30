// backend/test_connection.js
import 'dotenv/config';
import { supabase } from './lib/supabase.js';
import axios from 'axios';

async function testAll() {
  console.log('--- 1. Testing Supabase Connectivity ---');
  try {
    const { data, error } = await supabase.from('contacts').select('*').limit(1);
    if (error) {
      console.log('Supabase table error (tables might need to be created via SQL Editor):', error.message);
    } else {
      console.log('✅ Supabase connected successfully! Contacts query result:', data);
    }
  } catch (err) {
    console.error('❌ Supabase connection error:', err.message);
  }

  console.log('\n--- 2. Testing WhatsApp Graph API Token & Phone ID ---');
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v25.0';

  try {
    const metaRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('✅ Meta WhatsApp Cloud API credentials are VALID!');
    console.log('Meta Phone Number Info:', metaRes.data);
  } catch (err) {
    console.error('Meta WhatsApp API check:', err.response?.data || err.message);
  }
}

testAll();
