import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Globe, KeyRound, Link2, ShieldCheck, Eye, EyeOff, Ban } from 'lucide-react';
import { api, type Stream } from '../lib/api';
import { formatDate } from '../lib/format';
import { Button, CopyButton, ErrorText, Select, Toggle, inputClass } from './ui';

type Access = 'public' | 'domains' | 'token';
interface TokenLink { token: string; expiresAt: string | null; embed: string; hls: string; whep: string }

/** Embed code builder plus who may play the stream (everywhere, listed websites, or signed links). */
export function StreamEmbed({ s, canOperate }: { s: Stream; canOperate: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const current: Access = s.requireToken ? 'token' : s.allowedDomains.length ? 'domains' : 'public';
  const [access, setAccess] = useState<Access>(current);
  const [domains, setDomains] = useState(s.allowedDomains.join('\n'));
  const [lastFor, setLastFor] = useState(`${s.id}|${current}|${s.allowedDomains.join(',')}`);
  const sig = `${s.id}|${current}|${s.allowedDomains.join(',')}`;
  if (sig !== lastFor) { setLastFor(sig); setAccess(current); setDomains(s.allowedDomains.join('\n')); }

  const [opts, setOpts] = useState({ autoplay: false, webrtc: false, title: true });
  const [link, setLink] = useState<TokenLink | null>(null);
  const [days, setDays] = useState<number | null>(30);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['streams'] });

  const save = useMutation({
    mutationFn: () => api(`/api/streams/${s.id}`, {
      method: 'PATCH',
      body: {
        requireToken: access === 'token',
        allowedDomains: access === 'domains' ? domains.split(/[\s,]+/).filter(Boolean) : access === 'public' ? [] : s.allowedDomains,
      },
    }),
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); refresh(); },
  });
  const makeLink = useMutation({
    mutationFn: () => api<TokenLink>(`/api/streams/${s.id}/playback-token`, { method: 'POST', body: { days } }),
    onSuccess: setLink,
  });
  const revoke = useMutation({
    mutationFn: async () => {
      if (!confirm(t('embed.confirmRevoke'))) return;
      await api(`/api/streams/${s.id}/revoke-tokens`, { method: 'POST' });
      setLink(null);
    },
  });

  const src = useMemo(() => {
    const base = current === 'token' ? link?.embed ?? null : s.playback.embed;
    if (!base) return null;
    const u = new URL(base);
    if (opts.autoplay) { u.searchParams.set('autoplay', '1'); u.searchParams.set('muted', '1'); }
    if (opts.webrtc) u.searchParams.set('mode', 'webrtc');
    if (!opts.title) u.searchParams.set('title', '0');
    return u.toString();
  }, [current, link, s.playback.embed, opts]);

  const code = src
    ? `<iframe src="${src}" title="${s.name.replace(/"/g, '&quot;')}" style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`
    : '';
  const dirty = access !== current || (access === 'domains' && domains.split(/[\s,]+/).filter(Boolean).join(',') !== s.allowedDomains.join(','));

  return (
    <section className="flex flex-col gap-5 border-t border-line pt-6">
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-base font-semibold">{t('embed.title')}</h3>
        <p className="text-xs leading-relaxed text-fg-3">{t('embed.subtitle')}</p>
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <span className="eyebrow">{t('embed.access')}</span>
          <div role="radiogroup" aria-label={t('embed.access')} className="grid gap-2">
            {([
              ['public', <Globe key="g" size={18} />],
              ['domains', <ShieldCheck key="s" size={18} />],
              ['token', <KeyRound key="k" size={18} />],
            ] as const).map(([value, icon]) => (
              <button
                key={value} type="button" role="radio" aria-checked={access === value} disabled={!canOperate}
                onClick={() => setAccess(value)}
                className={clsx('flex items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-default',
                  access === value ? 'border-accent bg-accent/[0.07]' : 'border-line enabled:hover:border-line-strong')}
              >
                <span className={clsx('mt-0.5', access === value ? 'text-accent' : 'text-fg-3')}>{icon}</span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(`embed.mode.${value}`)}</span>
                  <span className="text-xs leading-relaxed text-fg-3">{t(`embed.modeHint.${value}`)}</span>
                </span>
              </button>
            ))}
          </div>
          {access === 'domains' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`dom-${s.id}`} className="text-[13px] font-medium text-fg-2">{t('embed.domains')}</label>
              <textarea
                id={`dom-${s.id}`} rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} disabled={!canOperate}
                placeholder={'www.example.com\n*.example.org'} className={clsx(inputClass, 'py-2.5 font-mono text-[13px]')}
              />
              <p className="text-xs leading-relaxed text-fg-3">{t('embed.domainsHint')}</p>
            </div>
          )}
          {canOperate && (
            <div className="flex items-center gap-3">
              <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>{t('embed.saveAccess')}</Button>
              {saved && <span className="text-sm text-ok">{t('common.saved')}</span>}
            </div>
          )}
          <ErrorText error={save.error} />

          {canOperate && (current === 'token' || current === 'domains') && (
            <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg/40 p-4">
              <span className="flex items-center gap-2 text-sm font-medium"><Link2 size={15} className="text-accent" /> {t('embed.links')}</span>
              <p className="text-xs leading-relaxed text-fg-3">{current === 'token' ? t('embed.linksHintToken') : t('embed.linksHintDomains')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label={t('embed.validity')} value={days ?? 0} onChange={(e) => setDays(Number(e.target.value) || null)} className="w-auto min-w-40">
                  {[1, 7, 30, 365].map((d) => <option key={d} value={d}>{t('embed.validDays', { count: d })}</option>)}
                  <option value={0}>{t('embed.validForever')}</option>
                </Select>
                <Button onClick={() => makeLink.mutate()} loading={makeLink.isPending}><KeyRound size={15} /> {t('embed.createLink')}</Button>
                <Button variant="ghost" className="text-danger hover:text-danger" onClick={() => revoke.mutate()} loading={revoke.isPending}><Ban size={15} /> {t('embed.revoke')}</Button>
              </div>
              {link && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-fg-3">{link.expiresAt ? t('embed.validUntil', { date: formatDate(link.expiresAt) }) : t('embed.validForever')}</span>
                  {[['Embed', link.embed], ['HLS', link.hls], ['WebRTC (WHEP)', link.whep]].map(([k, v]) => (
                    <div key={k} className="flex items-center gap-1 rounded-xl border border-line bg-bg pl-3">
                      <span className="w-24 shrink-0 font-mono text-[11px] text-fg-3">{k}</span>
                      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{v}</code>
                      <CopyButton value={v} className="min-h-9 px-3" />
                    </div>
                  ))}
                </div>
              )}
              <ErrorText error={makeLink.error ?? revoke.error} />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <span className="eyebrow">{t('embed.code')}</span>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Toggle checked={opts.autoplay} onChange={(v) => setOpts({ ...opts, autoplay: v })} label={t('embed.autoplay')} />
            <Toggle checked={opts.title} onChange={(v) => setOpts({ ...opts, title: v })} label={t('embed.showTitle')} />
            <Toggle checked={opts.webrtc} onChange={(v) => setOpts({ ...opts, webrtc: v })} label={t('embed.lowLatency')} />
          </div>
          {code ? (
            <>
              <div className="relative">
                <textarea readOnly value={code} rows={6} onFocus={(e) => e.target.select()} className={clsx(inputClass, 'resize-none py-2.5 font-mono text-xs text-fg-2')} />
              </div>
              <div className="flex flex-wrap gap-2">
                <CopyButton value={code} className="border border-line" />
                <Button variant="ghost" onClick={() => setPreview((p) => !p)}>{preview ? <EyeOff size={15} /> : <Eye size={15} />} {preview ? t('embed.hidePreview') : t('embed.preview')}</Button>
              </div>
              <p className="text-xs leading-relaxed text-fg-3">{opts.autoplay ? t('embed.autoplayHint') : t('embed.codeHint')}</p>
              {preview && (
                <iframe src={src!} title={t('embed.preview')} className="aspect-video w-full rounded-xl border border-line bg-black" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
              )}
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-fg-3">{t('embed.needLink')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
