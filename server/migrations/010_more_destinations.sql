-- v1.7.0: more destinations (TikTok, Vimeo, Dailymotion, Rumble, Trovo, Owncast, PeerTube) and LinkedIn as a connected account.
ALTER TABLE destinations DROP CONSTRAINT IF EXISTS destinations_platform_check;
ALTER TABLE destinations ADD CONSTRAINT destinations_platform_check
  CHECK (platform IN ('youtube', 'facebook', 'twitch', 'instagram', 'kick', 'x', 'linkedin',
                      'tiktok', 'vimeo', 'dailymotion', 'rumble', 'trovo', 'owncast', 'peertube', 'rtmp', 'srt'));

ALTER TABLE platform_accounts DROP CONSTRAINT IF EXISTS platform_accounts_provider_check;
ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_provider_check
  CHECK (provider IN ('youtube', 'facebook', 'twitch', 'x', 'linkedin'));
