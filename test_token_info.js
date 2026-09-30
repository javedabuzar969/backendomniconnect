// backend/test_token_info.js
import axios from 'axios';
import 'dotenv/config';

async function checkToken() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  console.log('Testing token against Meta Graph API me / me/accounts...');

  try {
    const res = await axios.get('https://graph.facebook.com/v21.0/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Me info:', res.data);
  } catch (err) {
    console.log('Error /me:', err.response?.data?.error?.message || err.message);
  }

  try {
    const res = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Accounts (Pages):', res.data);
  } catch (err) {
    console.log('Error /me/accounts:', err.response?.data?.error?.message || err.message);
  }
}

checkToken();
