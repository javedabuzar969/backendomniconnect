-- ============================================================================
-- OmniConnect Database Migration 002: Multi-Tenant SaaS Schema & Tenant Isolation
-- Run this script in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/aoigdwsudqndviisihet/sql
-- ============================================================================

-- 1. Enable UUID generator extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Create workspaces table
CREATE TABLE IF NOT EXISTS public.workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    owner_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON public.workspaces (owner_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON public.workspaces (slug);

-- 3. Create workspace_members table (Multi-user per workspace support)
CREATE TABLE IF NOT EXISTS public.workspace_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    role TEXT DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON public.workspace_members (user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON public.workspace_members (workspace_id);

-- 4. Add workspace_id column to existing application tables
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.whatsapp_settings ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- 5. Safe Backfill: Create Primary Workspace for existing user and link all existing data
DO $$
DECLARE
    v_user_id UUID;
    v_workspace_id UUID;
BEGIN
    -- Locate existing user
    SELECT id INTO v_user_id FROM public.users WHERE email = 'javedabuzar969@gmail.com' LIMIT 1;
    
    IF v_user_id IS NOT NULL THEN
        -- Check if workspace already created
        SELECT id INTO v_workspace_id FROM public.workspaces WHERE owner_id = v_user_id LIMIT 1;
        
        IF v_workspace_id IS NULL THEN
            INSERT INTO public.workspaces (name, slug, owner_id)
            VALUES ('Abuzar Workspace', 'abuzar-workspace', v_user_id)
            RETURNING id INTO v_workspace_id;
            
            INSERT INTO public.workspace_members (workspace_id, user_id, role)
            VALUES (v_workspace_id, v_user_id, 'owner')
            ON CONFLICT DO NOTHING;
        END IF;

        -- Backfill existing contacts
        UPDATE public.contacts 
        SET workspace_id = v_workspace_id 
        WHERE workspace_id IS NULL;

        -- Backfill existing messages from contact's workspace
        UPDATE public.messages m
        SET workspace_id = v_workspace_id
        WHERE m.workspace_id IS NULL;

        -- Backfill existing facebook_pages
        UPDATE public.facebook_pages
        SET workspace_id = v_workspace_id::text
        WHERE workspace_id IS NULL OR workspace_id = 'default_workspace';

        -- Backfill existing whatsapp_settings
        UPDATE public.whatsapp_settings
        SET workspace_id = v_workspace_id
        WHERE workspace_id IS NULL;

        -- Backfill existing broadcasts
        UPDATE public.broadcasts
        SET workspace_id = v_workspace_id
        WHERE workspace_id IS NULL;

        RAISE NOTICE 'Successfully backfilled existing data to workspace ID: %', v_workspace_id;
    END IF;
END $$;

-- 6. Update Contacts unique constraint from global to per-workspace
DO $$
BEGIN
    -- Drop global unique constraint on phone_number if present
    ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_phone_number_key;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Constraint contacts_phone_number_key does not exist or already dropped';
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_workspace_phone_unique 
    ON public.contacts (workspace_id, phone_number) 
    WHERE workspace_id IS NOT NULL;

-- 7. Performance indexes on workspace_id for instant filtering
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_id ON public.contacts (workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_workspace_id ON public.messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_settings_workspace_id ON public.whatsapp_settings (workspace_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_workspace_id ON public.broadcasts (workspace_id);

-- 8. Row Level Security (RLS) Configuration
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facebook_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;

-- Service Role Full Access (Ensures Backend Node.js APIs & Webhooks operate smoothly)
DROP POLICY IF EXISTS "Service role full access on workspaces" ON public.workspaces;
CREATE POLICY "Service role full access on workspaces" ON public.workspaces FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on workspace_members" ON public.workspace_members;
CREATE POLICY "Service role full access on workspace_members" ON public.workspace_members FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on contacts" ON public.contacts;
CREATE POLICY "Service role full access on contacts" ON public.contacts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on messages" ON public.messages;
CREATE POLICY "Service role full access on messages" ON public.messages FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on facebook_pages" ON public.facebook_pages;
CREATE POLICY "Service role full access on facebook_pages" ON public.facebook_pages FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on whatsapp_settings" ON public.whatsapp_settings;
CREATE POLICY "Service role full access on whatsapp_settings" ON public.whatsapp_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Remove dangerously permissive anon policies
DROP POLICY IF EXISTS "Allow all for service_role and anon on contacts" ON public.contacts;
DROP POLICY IF EXISTS "Allow all for service_role and anon on messages" ON public.messages;
DROP POLICY IF EXISTS "Allow all for service_role and anon on facebook_pages" ON public.facebook_pages;
DROP POLICY IF EXISTS "Allow all for service_role and anon on whatsapp_settings" ON public.whatsapp_settings;
DROP POLICY IF EXISTS "Allow all for service_role and anon on broadcasts" ON public.broadcasts;

-- Authenticated User Isolation Policies
DROP POLICY IF EXISTS "Users can only read own workspace" ON public.workspaces;
CREATE POLICY "Users can only read own workspace" ON public.workspaces FOR SELECT TO authenticated
USING (id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can only read own workspace contacts" ON public.contacts;
CREATE POLICY "Users can only read own workspace contacts" ON public.contacts FOR ALL TO authenticated
USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()))
WITH CHECK (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can only read own workspace messages" ON public.messages;
CREATE POLICY "Users can only read own workspace messages" ON public.messages FOR ALL TO authenticated
USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()))
WITH CHECK (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
