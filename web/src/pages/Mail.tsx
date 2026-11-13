import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { BellRing, CheckCircle2, KeyRound, Mail as MailIcon, PlugZap, Send, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatDate } from '../lib/format';
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, PageHeader, Toggle, inputClass } from '../components/ui';

type Security = 'tls' | 'starttls' | 'none';
interface MailForm {
  enabled: boolean; host: string; port: number; security: Security; verifyCertificate: boolean;
  username: string; passwordSet: boolean; fromName: string; fromAddress: string; replyTo: string;
  dkim: { enabled: boolean; domain: string; selector: string; keySet: boolean; dnsName: string; dnsValue: string };
}
type EventName = 'streamDown' | 'outputFailed' | 'healthWarning' | 'mediaServerDown' | 'backupFailed' | 'backupSucceeded' | 'updateFinished' | 'updateAvailable';
interface Notifications { recipients: string[]; includeAdmins: boolean; events: Record<EventName, boolean> }
interface MailResponse { mail: MailForm; configured: boolean; notifications: Notifications; events: EventName[] }
interface LogRow { id: number; kind: string; recipients: string[]; subject: string; status: 'sent' | 'failed'; error: string | null; created_at: string }

const defaultPort: Record<Security, number> = { starttls: 587, tls: 465, none: 25 };

export function Mail() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe().data!.user!;
  const q = useQuery({ queryKey: ['mail'], queryFn: () => api<MailResponse>('/api/mail') });
  const log = useQuery({ queryKey: ['mail-log'], queryFn: () => api<LogRow[]>('/api/mail/log') });
  const [form, setForm] = useState<MailForm | null>(null);
  const [notif, setNotif] = useState<Notifications | null>(null);
  const [recipients, setRecipients] = useState('');
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState(me.email);
  const [state, setState] = useState<{ busy?: string; ok?: string; error?: unknown; where?: string }>({});

  useEffect(() => {
    if (!q.data) return;
    setForm(q.data.mail);
    setNotif(q.data.notifications);
    setRecipients(q.data.notifications.recipients.join('\n'));
  }, [q.data]);
  if (!form || !notif || !q.data) return null;

  const set = (p: Partial<MailForm>) => setForm({ ...form, ...p });
  const setDkim = (p: Partial<MailForm['dkim']>) => setForm({ ...form, dkim: { ...form.dkim, ...p } });

  async function act(where: string, fn: () => Promise<unknown>, okKey?: string) {
    setState({ busy: where, where });
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['mail'] });
      await qc.invalidateQueries({ queryKey: ['mail-log'] });
      setState({ ok: okKey ?? where, where });
      setTimeout(() => setState((s) => (s.ok ? {} : s)), 3500);
    } catch (error) { setState({ error, where }); }
  }

  const saveMail = (e?: FormEvent, where = 'server') => {
    e?.preventDefault();
    return act(where, async () => {
      await api('/api/mail', {
        method: 'PUT',
        body: {
          enabled: form!.enabled, host: form!.host.trim(), port: Number(form!.port), security: form!.security, verifyCertificate: form!.verifyCertificate,
          username: form!.username, ...(password ? { password } : {}), fromName: form!.fromName, fromAddress: form!.fromAddress.trim(), replyTo: form!.replyTo.trim(),
          dkim: { enabled: form!.dkim.enabled, domain: form!.dkim.domain, selector: form!.dkim.selector },
        },
      });
      setPassword('');
    }, 'saved');
  };

  const err = (where: string) => (state.where === where ? <ErrorText error={state.error} /> : null);
  const ok = (where: string, text: string) => state.where === where && state.ok
    ? <span className="flex items-center gap-1.5 text-sm text-ok"><CheckCircle2 size={16} /> {text}</span> : null;

  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('mail.title')} subtitle={t('mail.subtitle')}
        actions={<Badge tone={q.data.configured ? 'ok' : 'neutral'} dot>{q.data.configured ? t('mail.active') : t('mail.inactive')}</Badge>} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card eyebrow="SMTP" title={t('mail.server')}>
          <form onSubmit={saveMail} className="flex flex-col gap-4">
            <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} label={t('mail.enabled')} />
            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <Field label={t('mail.host')}>{(id) => <Input id={id} value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.office365.com" className="font-mono text-sm" />}</Field>
              <Field label={t('mail.port')}>{(id) => <Input id={id} type="number" min={1} max={65535} value={form.port} onChange={(e) => set({ port: Number(e.target.value) })} className="font-mono text-sm" />}</Field>
            </div>
            <Field label={t('mail.security')} hint={t(`mail.security_${form.security}_hint`)}>
              {(id) => (
                <div id={id} role="radiogroup" className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-bg p-1">
                  {(['starttls', 'tls', 'none'] as const).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={form.security === s}
                      onClick={() => set({ security: s, port: Object.values(defaultPort).includes(form.port) ? defaultPort[s] : form.port })}
                      className={clsx('min-h-9 rounded-lg text-sm transition-colors', form.security === s ? 'bg-surface-2 text-fg shadow-[inset_0_-2px_0_var(--rs-accent)]' : 'text-fg-3 hover:text-fg-2')}>
                      {t(`mail.security_${s}`)}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            {form.security !== 'none' && <Toggle checked={form.verifyCertificate} onChange={(v) => set({ verifyCertificate: v })} label={t('mail.verifyCertificate')} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('mail.username')}>{(id) => <Input id={id} autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />}</Field>
              <Field label={t('mail.password')} hint={form.passwordSet ? t('mail.passwordSet') : undefined}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={form.passwordSet ? '••••••••' : ''} />}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('mail.fromName')}>{(id) => <Input id={id} value={form.fromName} onChange={(e) => set({ fromName: e.target.value })} />}</Field>
              <Field label={t('mail.fromAddress')}>{(id) => <Input id={id} type="email" value={form.fromAddress} onChange={(e) => set({ fromAddress: e.target.value })} placeholder="restream@example.com" />}</Field>
            </div>
            <Field label={`${t('mail.replyTo')} (${t('common.optional')})`}>{(id) => <Input id={id} type="email" value={form.replyTo} onChange={(e) => set({ replyTo: e.target.value })} />}</Field>
            {err('server')}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" loading={state.busy === 'server'}>{t('common.save')}</Button>
              <Button type="button" loading={state.busy === 'verify'} disabled={!form.host}
                onClick={() => act('verify', () => api('/api/mail/verify', { method: 'POST' }))}><PlugZap size={16} /> {t('mail.verify')}</Button>
              {ok('server', t('common.saved'))}
              {ok('verify', t('mail.verifyOk'))}
            </div>
            {err('verify')}
            <p className="text-xs leading-relaxed text-fg-3">{t('mail.verifyHint')}</p>
          </form>
        </Card>

        <div className="flex flex-col gap-6">
          <Card eyebrow={t('mail.testEyebrow')} title={t('mail.test')}>
            <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void act('test', () => api('/api/mail/test', { method: 'POST', body: { to: testTo } })); }}>
              <Field label={t('mail.testTo')}>{(id) => <Input id={id} type="email" required value={testTo} onChange={(e) => setTestTo(e.target.value)} />}</Field>
              {err('test')}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" loading={state.busy === 'test'} disabled={!q.data.configured}><Send size={16} /> {t('mail.sendTest')}</Button>
                {ok('test', t('mail.testSent'))}
              </div>
              {!q.data.configured && <p className="text-xs text-fg-3">{t('mail.saveFirst')}</p>}
            </form>
          </Card>

          <Card eyebrow={t('mail.dkimEyebrow')} title={t('mail.dkim')} actions={<ShieldCheck size={20} className="text-accent" />}>
            <div className="flex flex-col gap-4">
              <p className="text-sm leading-relaxed text-fg-2">{t('mail.dkimText')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('mail.dkimDomain')}>{(id) => <Input id={id} value={form.dkim.domain} onChange={(e) => setDkim({ domain: e.target.value })} placeholder="example.com" className="font-mono text-sm" />}</Field>
                <Field label={t('mail.dkimSelector')}>{(id) => <Input id={id} value={form.dkim.selector} onChange={(e) => setDkim({ selector: e.target.value })} className="font-mono text-sm" />}</Field>
              </div>
              {form.dkim.keySet && form.dkim.dnsValue ? (
                <div className="flex flex-col gap-2 rounded-xl border border-line bg-bg p-3">
                  <span className="eyebrow">{t('mail.dnsRecord')}</span>
                  <div className="flex items-center gap-2"><code className="flex-1 font-mono text-xs break-all text-fg">TXT {form.dkim.domain ? `${form.dkim.selector}._domainkey.${form.dkim.domain}` : `${form.dkim.selector}._domainkey.<domain>`}</code></div>
                  <div className="flex items-start gap-2">
                    <code className="max-h-24 flex-1 overflow-auto font-mono text-[11px] break-all text-accent">{form.dkim.dnsValue}</code>
                    <CopyButton value={form.dkim.dnsValue} className="min-h-8 px-2" />
                  </div>
                </div>
              ) : <p className="text-xs text-fg-3">{t('mail.dkimNoKey')}</p>}
              <Toggle checked={form.dkim.enabled} disabled={!form.dkim.keySet} onChange={(v) => setDkim({ enabled: v })} label={t('mail.dkimEnabled')} />
              {err('dkim')}
              {err('dkimSave')}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="primary" loading={state.busy === 'dkimSave'} onClick={() => saveMail(undefined, 'dkimSave')}>{t('common.save')}</Button>
                <Button type="button" loading={state.busy === 'dkim'}
                  onClick={() => { if (!form.dkim.keySet || window.confirm(t('mail.dkimRegenerateConfirm'))) void act('dkim', () => api('/api/mail/dkim', { method: 'POST' })); }}>
                  <KeyRound size={16} /> {form.dkim.keySet ? t('mail.dkimRegenerate') : t('mail.dkimGenerate')}
                </Button>
                {ok('dkimSave', t('common.saved'))}
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Card eyebrow={t('mail.notifyEyebrow')} title={t('mail.notifications')} className="mt-6" actions={<BellRing size={20} className="text-accent" />}>
        <form className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          onSubmit={(e) => {
            e.preventDefault();
            const list = recipients.split(/[\s,;]+/).map((r) => r.trim()).filter(Boolean);
            void act('notify', () => api('/api/notifications', { method: 'PUT', body: { ...notif, recipients: list } }), 'saved');
          }}>
          <div className="flex flex-col gap-4">
            <Toggle checked={notif.includeAdmins} onChange={(v) => setNotif({ ...notif, includeAdmins: v })} label={t('mail.includeAdmins')} />
            <Field label={t('mail.recipients')} hint={t('mail.recipientsHint')}>
              {(id) => <textarea id={id} rows={4} value={recipients} onChange={(e) => setRecipients(e.target.value)} className={clsx(inputClass, 'py-2.5 font-mono text-sm')} placeholder="noc@example.com" />}
            </Field>
            {!q.data.configured && <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{t('mail.notifyNeedsMail')}</p>}
          </div>
          <div className="flex flex-col gap-2">
            {q.data.events.map((ev) => (
              <label key={ev} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-bg px-3.5 py-3 hover:border-line-strong">
                <input type="checkbox" checked={notif.events[ev]} onChange={(e) => setNotif({ ...notif, events: { ...notif.events, [ev]: e.target.checked } })}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--rs-accent)]" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(`mail.event_${ev}`)}</span>
                  <span className="text-xs leading-relaxed text-fg-3">{t(`mail.event_${ev}_hint`)}</span>
                </span>
              </label>
            ))}
            {err('notify')}
            <div className="mt-2 flex items-center gap-3">
              <Button type="submit" variant="primary" loading={state.busy === 'notify'}>{t('common.save')}</Button>
              {ok('notify', t('common.saved'))}
            </div>
          </div>
        </form>
      </Card>

      <Card title={t('mail.log')} className="mt-6" actions={<MailIcon size={20} className="text-fg-3" />}>
        {!log.data?.length ? <p className="text-sm text-fg-3">{t('mail.logEmpty')}</p> : (
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-line">
                <tr className="eyebrow">
                  <th className="px-5 py-2.5 font-normal sm:px-6">{t('audit.when')}</th>
                  <th className="px-3 py-2.5 font-normal">{t('mail.subject')}</th>
                  <th className="px-3 py-2.5 font-normal">{t('mail.to')}</th>
                  <th className="px-5 py-2.5 font-normal sm:px-6">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {log.data.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-5 py-2.5 whitespace-nowrap text-fg-3 sm:px-6">{formatDate(r.created_at)}</td>
                    <td className="px-3 py-2.5">{r.subject}{r.error && <span className="mt-0.5 block font-mono text-xs text-danger">{r.error}</span>}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{r.recipients.join(', ')}</td>
                    <td className="px-5 py-2.5 sm:px-6"><Badge tone={r.status === 'sent' ? 'ok' : 'danger'}>{t(`mail.status_${r.status}`)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
