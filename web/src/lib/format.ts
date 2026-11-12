import i18n from '../i18n';

export function formatDate(v: string | null | undefined) {
  if (!v) return i18n.t('common.never');
  return new Intl.DateTimeFormat(i18n.language === 'nl' ? 'nl-NL' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
}

export function formatDuration(sec: number) {
  if (sec < 60) return i18n.t('time.seconds', { n: sec });
  if (sec < 3600) return i18n.t('time.minutes', { n: Math.floor(sec / 60) });
  if (sec < 86400) return i18n.t('time.hours', { n: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) });
  return i18n.t('time.days', { n: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) });
}

export const shortSha = (s: string) => (s && s !== 'unknown' ? s.slice(0, 7) : s);
