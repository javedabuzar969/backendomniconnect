-- ============================================================================
-- OmniConnect WhatsApp & Supabase Database Schema
-- Run this script in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/aoigdwsudqndviisihet/sql
-- ============================================================================

-- 1. Enable UUID generator extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- Table: whatsapp_settings
-- Stores Meta WhatsApp Cloud API credentials and settings
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number_id TEXT NOT NULL,
    waba_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    display_phone_number TEXT,
    webhook_verify_token TEXT DEFAULT 'omniconnect_webhook_secret_2026',
    api_version TEXT DEFAULT 'v25.0',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ============================================================================
-- Table: contacts
-- Stores user contacts/customers for messaging and broadcasts
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT,
    phone_number TEXT NOT NULL UNIQUE,
    email TEXT,
    channel TEXT DEFAULT 'whatsapp',
    status TEXT DEFAULT 'Subscribed',
    tags TEXT[] DEFAULT ARRAY['Lead']::TEXT[],
    metadata JSONB DEFAULT '{}'::jsonb,
    last_interaction_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index on contacts phone number for quick lookups
CREATE INDEX IF NOT EXISTS idx_contacts_phone_number ON public.contacts (phone_number);

-- ============================================================================
-- Table: messages
-- Stores all sent and received WhatsApp messages & templates
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    phone_number TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'template', 'image', 'document', 'interactive', 'audio', 'video')),
    content TEXT,
    template_name TEXT,
    template_params JSONB,
    whatsapp_message_id TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    error_message TEXT,
    raw_payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes on messages
CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON public.messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_phone_number ON public.messages (phone_number);
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_msg_id ON public.messages (whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages (created_at DESC);

-- ============================================================================
-- Table: broadcasts
-- Campaigns sent out to multiple contacts
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    channel TEXT DEFAULT 'whatsapp',
    message_type TEXT DEFAULT 'template',
    template_name TEXT,
    template_params JSONB DEFAULT '[]'::jsonb,
    message_text TEXT,
    status TEXT DEFAULT 'completed' CHECK (status IN ('draft', 'scheduled', 'processing', 'completed', 'failed')),
    total_recipients INT DEFAULT 0,
    success_count INT DEFAULT 0,
    failure_count INT DEFAULT 0,
    scheduled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ============================================================================
-- Table: broadcast_recipients
-- Track message delivery per contact inside each broadcast
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.broadcast_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broadcast_id UUID REFERENCES public.broadcasts(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    phone_number TEXT NOT NULL,
    whatsapp_message_id TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    error_details TEXT,
    sent_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- ============================================================================
-- Table: whatsapp_webhooks_log
-- Auditing raw webhook events incoming from Meta
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_webhooks_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ============================================================================
-- Auto-update updated_at timestamp function and triggers
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_whatsapp_settings_updated ON public.whatsapp_settings;
CREATE TRIGGER trigger_whatsapp_settings_updated
    BEFORE UPDATE ON public.whatsapp_settings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_contacts_updated ON public.contacts;
CREATE TRIGGER trigger_contacts_updated
    BEFORE UPDATE ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Insert initial WhatsApp credentials provided by user
-- ============================================================================
INSERT INTO public.whatsapp_settings (
    phone_number_id,
    waba_id,
    access_token,
    display_phone_number,
    api_version,
    is_active
) VALUES (
    '117953297853521',
    '115606731422647',
    'EABCQeZASwiEIBSug9R2fjZAmKhTkAZBpI6fSZCGB3g9LAZBbngozifJVKZAmFzGub6zEfZAl9dIUZBDh9bIImpUULBXBRKfjFJzZATOIfKM7apZAETVpi2QnMQWNQaaqHu7nImQRlkdOlvdTteAlIC0ZBD9GLqS0INJCm6sf4cMU909sQ1iejmHrKpLpGBwSLJwEo88Q9BQff9YnCGI3Ti1iM61PWqvt7z29xApqm6MmYvVRy8phUZCcHaaPZChx7XogU22A4AlF1ktydFN0EwjclfSAaAAZDZD',
    '+1 (555) 017-6631',
    'v25.0',
    true
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Seed initial sample contact (e.g. recipient from curl test)
-- ============================================================================
INSERT INTO public.contacts (
    name,
    phone_number,
    channel,
    status,
    tags
) VALUES (
    'John Doe',
    '923012200030',
    'whatsapp',
    'Subscribed',
    ARRAY['Customer', 'VIP']::TEXT[]
)
ON CONFLICT (phone_number) DO UPDATE
SET name = EXCLUDED.name,
    updated_at = timezone('utc'::text, now());

-- ============================================================================
-- Row Level Security (RLS) Configuration
-- Enable public reads/writes via service_role and authenticated/anon as needed
-- ============================================================================
ALTER TABLE public.whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_webhooks_log ENABLE ROW LEVEL SECURITY;

-- Allow full access for service_role and anon (or adjust based on your auth preference)
DROP POLICY IF EXISTS "Allow all for service_role and anon on whatsapp_settings" ON public.whatsapp_settings;
CREATE POLICY "Allow all for service_role and anon on whatsapp_settings" ON public.whatsapp_settings FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for service_role and anon on contacts" ON public.contacts;
CREATE POLICY "Allow all for service_role and anon on contacts" ON public.contacts FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for service_role and anon on messages" ON public.messages;
CREATE POLICY "Allow all for service_role and anon on messages" ON public.messages FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for service_role and anon on broadcasts" ON public.broadcasts;
CREATE POLICY "Allow all for service_role and anon on broadcasts" ON public.broadcasts FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for service_role and anon on broadcast_recipients" ON public.broadcast_recipients;
CREATE POLICY "Allow all for service_role and anon on broadcast_recipients" ON public.broadcast_recipients FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for service_role and anon on whatsapp_webhooks_log" ON public.whatsapp_webhooks_log;
CREATE POLICY "Allow all for service_role and anon on whatsapp_webhooks_log" ON public.whatsapp_webhooks_log FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- Table: facebook_pages
-- Stores connected Facebook Pages, access tokens, and Messenger webhook state
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.facebook_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id TEXT NOT NULL UNIQUE,
    page_name TEXT NOT NULL,
    category TEXT DEFAULT 'Business',
    picture_url TEXT,
    access_token TEXT NOT NULL,
    user_id TEXT,
    workspace_id TEXT DEFAULT 'default_workspace',
    status TEXT DEFAULT 'connected',
    webhook_status TEXT DEFAULT 'subscribed',
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.facebook_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service_role and anon on facebook_pages" ON public.facebook_pages;
CREATE POLICY "Allow all for service_role and anon on facebook_pages" ON public.facebook_pages FOR ALL USING (true) WITH CHECK (true);

