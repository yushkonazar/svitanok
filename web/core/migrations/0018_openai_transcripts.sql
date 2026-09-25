-- release-phase: expand
-- First-party rolling transcript for stateless model runtimes. It contains
-- only owner input and delivered assistant output, never provider state or
-- raw external tool results. The scheduler summarizes it only for clean
-- sessions, then clears it after the D1 summary is safely stored.
ALTER TABLE sessions ADD COLUMN transcript_md TEXT;
