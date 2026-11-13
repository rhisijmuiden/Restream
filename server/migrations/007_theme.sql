-- Per-user colour theme: 'dark' (the original look), 'light', or 'system' (follow the operating system).
ALTER TABLE users
  ADD COLUMN theme text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light', 'system'));
