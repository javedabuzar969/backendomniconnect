-- ============================================================================
-- OmniConnect Database Migration 001: Meta & Instagram Integration Repair
-- Run this script in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/aoigdwsudqndviisihet/sql
-- ============================================================================

-- 1. Create oauth_sessions table for persistent serverless OAuth
CREATE TABLE IF NOT EXISTS public.oauth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state TEXT NOT NULL UNIQUE,
    session_type TEXT DEFAULT 'facebook', -- 'facebook' or 'instagram'
    workspace_id TEXT DEFAULT 'default_workspace',
    redirect_uri TEXT,
    session_data JSONB DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_state ON public.oauth_sessions (state);
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires_at ON public.oauth_sessions (expires_at);

ALTER TABLE public.oauth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service_role and anon on oauth_sessions" ON public.oauth_sessions;
CREATE POLICY "Allow all for service_role and anon on oauth_sessions" 
    ON public.oauth_sessions FOR ALL USING (true) WITH CHECK (true);

-- 2. Enhance facebook_pages with metadata and Instagram linking columns
ALTER TABLE public.facebook_pages 
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS linked_page_id TEXT,
    ADD COLUMN IF NOT EXISTS instagram_business_account_id TEXT;

-- 3. Backfill existing Instagram records if any
UPDATE public.facebook_pages
SET instagram_business_account_id = REPLACE(page_id, 'ig_', '')
WHERE page_id LIKE 'ig_%' AND instagram_business_account_id IS NULL;

-- 4. Duplicate prevention: unique partial index on external message IDs
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique_external_id 
    ON public.messages (whatsapp_message_id) 
    WHERE whatsapp_message_id IS NOT NULL;

-- 5. Performance index on contacts channel and last_interaction_at
CREATE INDEX IF NOT EXISTS idx_contacts_channel_last_interaction 
    ON public.contacts (channel, last_interaction_at DESC);

-- 6. Performance index on messages contact_id and created_at
CREATE INDEX IF NOT EXISTS idx_messages_contact_created 
    ON public.messages (contact_id, created_at ASC);
