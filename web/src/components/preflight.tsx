import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, Info, OctagonAlert, Radio, RefreshCw, Stethoscope } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type CheckStatus, type PreflightCheck, type PreflightResult, type Stream } from '../lib/api';
import { formatKbps } from '../lib/streams';
import { Button, ErrorText, Modal } from './ui';
import { PlatformChip } from './media';
import { issueText } from './health';

const icon: Record<CheckStatus, typeof Info> = { ok: CheckCircle2, info: Info, warn: CircleAlert, fail: OctagonAlert };
const tone: Record<CheckStatus, string> = { ok: 'text-ok', info: 'text-accent', warn: 'text-warn', fail: 'text-danger' };

/** One line of the check: health issues reuse the wording of the health page, the rest has its own (preflight.c_<code>). */
function CheckRow({ c }: { c: PreflightCheck }) {
  const { t } = useTranslation();
  const Icon = icon[c.status];
  const params = { ...c.params, kbpsText: typeof c.params.kbps === 'number' ? formatKbps(c.params.kbps) : '' };
  const { label, text } = c.code === 'health'
    ? issueText(t, String(c.params.issue), params)
    : { label: t(`preflight.c_${c.code}.label`, params), text: t(`preflight.c_${c.code}.text`, params) };
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon size={17} className={clsx('mt-0.5 shrink-0', tone[c.status])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {c.platform && <PlatformChip platform={c.platform} size={18} />}
          {c.destinationName && <span className="font-medium">{c.destinationName}:</span>}
          <span className={clsx(!c.destinationName && 'font-medium')}>{label}</span>
        </span>
        {text && <span className="text-xs leading-relaxed text-fg-2">{text}</span>}
      </div>
    </li>
  );
}

export function PreflightList({ result }: { result: PreflightResult }) {
  const { t } = useTranslation();
  const general = result.checks.filter((c) => !c.destinationId);
  const perDest = result.checks.filter((c) => c.destinationId);
  return (
    <div className="flex flex-col gap-4">
      {[[t('preflight.general'), general], [t('preflight.destinations'), perDest]].map(([title, list]) => (list as PreflightCheck[]).length > 0 && (
        <section key={title as string} className="flex flex-col gap-2">
          <span className="eyebrow">{title as string}</span>
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-bg/40">
            {(list as PreflightCheck[]).map((c, i) => <CheckRow key={`${c.code}-${c.destinationId ?? ''}-${i}`} c={c} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Summary({ r }: { r: PreflightResult }) {
  const { t } = useTranslation();
  const st: CheckStatus = r.fails ? 'fail' : r.warnings ? 'warn' : 'ok';
  const Icon = icon[st];
  return (
    <div className={clsx('flex items-start gap-3 rounded-xl border px-4 py-3',
      st === 'fail' ? 'border-danger/40 bg-danger/[0.06]' : st === 'warn' ? 'border-warn/40 bg-warn/[0.06]' : 'border-ok/30 bg-ok/[0.06]')}>
      <Icon size={20} className={clsx('mt-0.5 shrink-0', tone[st])} />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{r.fails ? t('preflight.summaryFail', { count: r.fails }) : r.warnings ? t('preflight.summaryWarn', { count: r.warnings }) : t('preflight.summaryOk')}</span>
        <span className="text-xs text-fg-2">{r.fails ? t('preflight.summaryFailText') : r.warnings ? t('preflight.summaryWarnText') : t('preflight.summaryOkText')}</span>
      </div>
    </div>
  );
}

/**
 * Go live with a check first: when everything is fine the stream goes live at once; otherwise the operator sees
 * what is wrong and chooses. "Check" runs the same check without going live.
 */
export function GoLiveControls({ stream, disabled, title }: { stream: Stream; disabled: boolean; title?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState<null | 'check' | 'golive'>(null);
  const [result, setResult] = useState<PreflightResult | null>(null);

  const live = useMutation({
    mutationFn: () => api(`/api/streams/${stream.id}/live`, { method: 'POST', body: { live: true } }),
    onSuccess: () => setOpen(null),
    onSettled: () => qc.invalidateQueries({ queryKey: ['streams'] }),
  });
  const check = useMutation({
    mutationFn: () => api<PreflightResult>(`/api/streams/${stream.id}/preflight`, { method: 'POST' }),
    onSuccess: (r, _v) => setResult(r),
  });

  async function goLive() {
    setResult(null);
    try {
      const r = await check.mutateAsync();
      if (!r.fails && !r.warnings) { live.mutate(); return; }
      setOpen('golive');
    } catch {
      // The check itself failed (server unreachable): show it, the operator can still go live from the dialog.
      setOpen('golive');
    }
  }

  return (
    <>
      <Button onClick={() => { setResult(null); setOpen('check'); check.mutate(); }} title={t('preflight.checkHint')} disabled={check.isPending && open === null}>
        <Stethoscope size={16} /> {t('preflight.check')}
      </Button>
      <Button variant="primary" onClick={goLive} loading={(check.isPending && open === null) || live.isPending} disabled={disabled} title={title}>
        <Radio size={16} /> {t('dashboard.goLive')}
      </Button>
      <ErrorText error={open === null ? live.error : null} />
      <Modal open={open !== null} onClose={() => setOpen(null)} wide title={open === 'golive' ? t('preflight.titleGoLive') : t('preflight.title')}>
        <div className="flex flex-col gap-5">
          {check.isPending && (
            <div className="flex items-center gap-3 rounded-xl border border-line bg-bg/40 px-4 py-6 text-sm text-fg-2">
              <span className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden /> {t('preflight.running')}
            </div>
          )}
          <ErrorText error={check.error} />
          {result && !check.isPending && <><Summary r={result} /><PreflightList result={result} /></>}
          <ErrorText error={live.error} />
          <div className="flex flex-wrap items-center gap-3">
            {open === 'golive' || (result && !disabled) ? (
              <Button variant={result?.fails ? 'danger' : 'primary'} onClick={() => live.mutate()} loading={live.isPending} disabled={disabled || check.isPending}>
                <Radio size={16} /> {result && (result.fails || result.warnings) ? t('preflight.goLiveAnyway') : t('dashboard.goLive')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => check.mutate()} loading={check.isPending}><RefreshCw size={15} /> {t('preflight.again')}</Button>
            <Button variant="ghost" onClick={() => setOpen(null)} className="ml-auto">{t('common.close')}</Button>
          </div>
          {result && <p className="text-xs text-fg-3">{t('preflight.footer')}</p>}
        </div>
      </Modal>
    </>
  );
}
