-- Create roles required by PostgREST / Supabase local dev
-- These mirror what Supabase Cloud provisions automatically.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN PASSWORD 'postgres' NOINHERIT;
  END IF;
END
$$;

GRANT anon          TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role  TO authenticator;

-- Allow anon and authenticated to use the public schema
GRANT USAGE  ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL    ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL    ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Make sure future tables also get the same grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
