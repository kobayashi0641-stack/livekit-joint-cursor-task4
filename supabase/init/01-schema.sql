-- Supabase Schema for LiveKit Cursor Mesh Recording Data
-- This is the same schema as packages/web/supabase_schema.sql,
-- loaded automatically when the local Docker database starts.

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Recordings table - Main session metadata
CREATE TABLE IF NOT EXISTS recordings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  experiment_name TEXT NOT NULL DEFAULT '',
  trial_number INTEGER NOT NULL DEFAULT 1,
  room_name TEXT NOT NULL,
  start_time BIGINT NOT NULL,
  end_time BIGINT,
  frame_rate INTEGER NOT NULL DEFAULT 60,
  total_frames INTEGER DEFAULT 0,
  -- Group experiment metadata: snapshot of assignments at recording start.
  -- group_count = 1 (default) means "no grouping" / single global group.
  group_assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
  group_count INTEGER NOT NULL DEFAULT 1,
  -- Recording context (used for filename construction at download time).
  -- task_type:        ExperimentTaskType ('reaching', 'circle-target-tracking', ...)
  -- display_mode:     DisplayMode used during the trial ('avgOnly', 'self-with-avg', ...)
  -- participant_count: total non-admin participants present when recording started
  task_type TEXT NOT NULL DEFAULT '',
  display_mode TEXT NOT NULL DEFAULT 'avgOnly',
  participant_count INTEGER NOT NULL DEFAULT 0,
  -- Complete agent setup and runtime trial parameters used for reproducible analysis.
  experiment_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  trial_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Complete per-trial JSON payload, including frames, events, target trajectory,
  -- questionnaire responses, task config, and trial metadata.
  session_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Frames table - Frame data with cursor positions
-- Cursors are stored as JSONB for efficiency (avoids millions of rows).
-- group_averages: per-group average cursor positions, e.g. {"0":{"x":0.5,"y":0.5},"1":{"x":0.6,"y":0.4}}
-- Per-cursor groupId is embedded inside the cursors JSONB array (no schema change needed).
CREATE TABLE IF NOT EXISTS frames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  frame_number INTEGER NOT NULL,
  timestamp BIGINT NOT NULL,
  average_x DOUBLE PRECISION,
  average_y DOUBLE PRECISION,
  target_x DOUBLE PRECISION,
  target_y DOUBLE PRECISION,
  target_shape TEXT,
  cursors JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Per-participant visible targets for Task 6, whose local starts may differ.
  participant_targets JSONB NOT NULL DEFAULT '{}'::jsonb,
  group_averages JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Create index for faster queries on recording_id and frame_number
CREATE INDEX IF NOT EXISTS idx_frames_recording_id ON frames(recording_id);
CREATE INDEX IF NOT EXISTS idx_frames_recording_frame ON frames(recording_id, frame_number);

-- Migration: add group columns to existing tables (for DBs created before group support).
-- Safe to re-run; no-op when columns already exist.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS group_assignments JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS group_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE frames ADD COLUMN IF NOT EXISTS group_averages JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE frames ADD COLUMN IF NOT EXISTS participant_targets JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Migration: add recording-context columns used for filename composition on download.
-- Safe to re-run; no-op when columns already exist.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT '';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS display_mode TEXT NOT NULL DEFAULT 'avgOnly';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS participant_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS experiment_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS trial_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS session_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Events table - Admin events during recording
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}'::jsonb,
  timestamp BIGINT NOT NULL,
  relative_time BIGINT NOT NULL
);

-- Create index for faster queries on recording_id
CREATE INDEX IF NOT EXISTS idx_events_recording_id ON events(recording_id);

-- Broadcast messages table
CREATE TABLE IF NOT EXISTS broadcast_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  duration_ms INTEGER,
  severity TEXT DEFAULT 'info',
  position TEXT DEFAULT 'center',
  timestamp BIGINT NOT NULL
);

-- Create index for faster queries on recording_id
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_recording_id ON broadcast_messages(recording_id);

-- Row Level Security (RLS) Policies
-- Enable RLS on all tables
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_messages ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to insert and select data
-- (For production, you may want to restrict this further)

-- Recordings policies
CREATE POLICY "Allow anonymous insert on recordings" ON recordings
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anonymous select on recordings" ON recordings
  FOR SELECT TO anon USING (true);

CREATE POLICY "Allow anonymous update on recordings" ON recordings
  FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Frames policies
CREATE POLICY "Allow anonymous insert on frames" ON frames
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anonymous select on frames" ON frames
  FOR SELECT TO anon USING (true);

-- Events policies
CREATE POLICY "Allow anonymous insert on events" ON events
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anonymous select on events" ON events
  FOR SELECT TO anon USING (true);

-- Broadcast messages policies
CREATE POLICY "Allow anonymous insert on broadcast_messages" ON broadcast_messages
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anonymous select on broadcast_messages" ON broadcast_messages
  FOR SELECT TO anon USING (true);
