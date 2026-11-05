-- ============================================================================
-- OmniConnect Database Migration 003: Salesforce CRM Integration Schema
-- Security Hardened: Strict Service-Role Isolation & RLS
-- Run this script in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/aoigdwsudqndviisihet/sql
-- ============================================================================

-- 1. Create salesforce_connections table for encrypted Salesforce tokens & tenant isolation
CREATE TABLE IF NOT EXISTS public.salesforce_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id TEXT NOT NULL UNIQUE,
    user_id TEXT,
    org_id TEXT,
    instance_url TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    access_token_iv TEXT NOT NULL,
    access_token_tag TEXT NOT NULL,
    refresh_token_iv TEXT NOT NULL,
    refresh_token_tag TEXT NOT NULL,
    token_type TEXT DEFAULT 'Bearer',
    issued_at TEXT,
    status TEXT DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'expired')),
    connected_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Performance indexes for fast workspace lookups
CREATE INDEX IF NOT EXISTS idx_salesforce_connections_workspace_id ON public.salesforce_connections (workspace_id);
CREATE INDEX IF NOT EXISTS idx_salesforce_connections_org_id ON public.salesforce_connections (org_id);
CREATE INDEX IF NOT EXISTS idx_salesforce_connections_status ON public.salesforce_connections (status);

-- 3. Row Level Security & Strict Role Access Control
ALTER TABLE public.salesforce_connections ENABLE ROW LEVEL SECURITY;

-- Block all direct client access (anon and authenticated users can NEVER access tokens)
REVOKE ALL ON TABLE public.salesforce_connections FROM anon, authenticated, public;

-- Grant access ONLY to backend service_role
GRANT ALL ON TABLE public.salesforce_connections TO service_role;

-- Clean up any existing permissive policies
DROP POLICY IF EXISTS "Allow all for service_role and anon on salesforce_connections" ON public.salesforce_connections;
DROP POLICY IF EXISTS "Service Role Only" ON public.salesforce_connections;

-- Dedicated policy for service_role
CREATE POLICY "Service Role Only" 
    ON public.salesforce_connections 
    FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);
