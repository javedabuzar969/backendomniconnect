// backend/scripts/clean_mock_facebook.js
// Removes previously injected fake Facebook contacts and messages from Supabase
// Preserves all real WhatsApp contacts and messages.
import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

async function cleanMockFacebookData() {
  console.log('--- Cleaning Mock Facebook Data from Supabase ---');

  // Find contacts with channel = 'facebook' or phone numbers starting with 'fb_' or fake tags
  const { data: fbContacts, error: cErr } = await supabase
    .from('contacts')
    .select('id, name, phone_number, channel, tags')
    .eq('channel', 'facebook');

  if (cErr) {
    console.error('Error fetching contacts:', cErr.message);
    return;
  }

  console.log(`Found ${fbContacts?.length || 0} Facebook contact(s) to inspect.`);

  const fakeContactIds = [];
  for (const c of fbContacts || []) {
    // Check if it's one of the hardcoded defaultMetaClients or fake IDs
    const isMock =
      c.phone_number?.startsWith('fb_') ||
      c.phone_number === '921' ||
      c.phone_number === '482' ||
      c.phone_number === '715' ||
      c.phone_number === '304' ||
      ['Hamza Tariq', 'Zainab Malik', 'Ali Raza (Brand Inquiries)', 'Ayesha Siddiqui'].includes(c.name) ||
      (c.tags && c.tags.includes('Creative Logo Master'));

    if (isMock) {
      fakeContactIds.push(c.id);
      console.log(`- Removing fake contact: "${c.name}" (ID: ${c.id}, phone: ${c.phone_number})`);
    }
  }

  if (fakeContactIds.length > 0) {
    // Delete messages associated with these contacts
    const { error: mErr } = await supabase
      .from('messages')
      .delete()
      .in('contact_id', fakeContactIds);

    if (mErr) {
      console.error('Error deleting fake messages:', mErr.message);
    } else {
      console.log('✅ Fake messages deleted successfully.');
    }

    // Delete the contacts
    const { error: delErr } = await supabase
      .from('contacts')
      .delete()
      .in('id', fakeContactIds);

    if (delErr) {
      console.error('Error deleting fake contacts:', delErr.message);
    } else {
      console.log('✅ Fake contacts deleted successfully.');
    }
  } else {
    console.log('No mock Facebook contacts found in database.');
  }

  // Verify remaining contacts (must include WhatsApp contacts like John Doe)
  const { data: remaining } = await supabase.from('contacts').select('id, name, channel, phone_number');
  console.log('\nRemaining contacts in database:');
  console.table(remaining || []);
}

cleanMockFacebookData().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
