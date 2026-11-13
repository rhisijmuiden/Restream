-- X (formerly Twitter) accounts connected with OAuth 2.0 (X Livestream API).
ALTER TABLE platform_accounts DROP CONSTRAINT IF EXISTS platform_accounts_provider_check;
ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_provider_check
  CHECK (provider IN ('youtube', 'facebook', 'twitch', 'x'));
