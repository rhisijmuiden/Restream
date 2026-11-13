-- Phase 6: thumbnail for the broadcasts Restream creates on connected accounts (YouTube).
ALTER TABLE streams ADD COLUMN IF NOT EXISTS thumbnail text;
