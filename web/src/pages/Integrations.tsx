import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, ExternalLink, KeyRound, Pencil, Plus, RotateCw, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { api, type ApiKey, type Role, type SystemInfo, type Webhook, type WebhookDelivery } from '../lib/api';
import { formatDate } from '../lib/format';
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, Modal, PageHeader, Select, Toggle } from '../components/ui';

/** Administration › API & webhooks: keys for other projects and events pushed to them. */
export function Integrations() {
  const { t } = useTranslation();
  const sys = useQuery({ queryKey: ['info'], queryFn: () => api<SystemInfo>('/api/system/info') });
  const docs = sys.data?.repository ? `${sys.data.repository.replace(/\.git$/, '')}/blob/${sys.data.branch === 'main' ? 'main' : 'test'}/docs/API.md` : null;
  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('integrations.title')} subtitle={t('integrations.subtitle')} />
      {docs && (
        <a href={docs} target="_blank" rel="noreferrer" className="mb-6 inline-flex items-center gap-1.5 text-sm">{t('integrations.docs')} <ExternalLink size={13} /></a>
      )}
      <div className="flex flex-col gap-6">
        <ApiKeys />
        <Webhooks />
      </div>
    </>
  );
}

function ApiKeys() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKey[]>('/api/api-keys') });
  const [adding, setAdding] = useState(false);
  const revoke = useMutation({
    mutationFn: async (k: ApiKey) => {
      if (!confirm(t('integrations.confirmRevoke', { name: k.name }))) return;
      return api(`/api/api-keys/${k.id}`, { method: 'DELETE' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <Card
      eyebrow={t('integrations.apiEyebrow')} title={t('integrations.keysTitle')}
      actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} /> {t('integrations.newKey')}</Button>}
    >
      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-fg-2">{t('integrations.keysIntro')}</p>
      <ErrorText error={revoke.error} />
      {keys.data?.length === 0 && <p className="text-sm text-fg-3">{t('integrations.noKeys')}</p>}
      <ul className="divide-y divide-line">
        {keys.data?.map((k) => (
          <li key={k.id} className={clsx('flex flex-wrap items-center gap-x-5 gap-y-2 py-4 first:pt-0 last:pb-0', !k.active && 'opacity-55')}>
            <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-accent"><KeyRound size={16} /></div>
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{k.name}</span>
                <span className="truncate font-mono text-xs text-fg-3">{k.prefix}… · {t('integrations.createdBy', { name: k.createdBy, date: formatDate(k.createdAt) })}</span>
              </div>
            </div>
            <Badge tone="accent">{t(`roles.${k.role}`)}</Badge>
            <span className="text-xs text-fg-3">{t('integrations.lastUsed', { date: formatDate(k.lastUsedAt) })}</span>
            {k.revokedAt ? <Badge tone="neutral">{t('integrations.revoked')}</Badge>
              : !k.active ? <Badge tone="warn">{t('integrations.expired')}</Badge>
              : k.expiresAt ? <span className="text-xs text-fg-3">{t('integrations.expires', { date: formatDate(k.expiresAt) })}</span>
              : <span className="text-xs text-fg-3">{t('integrations.noExpiry')}</span>}
            {!k.revokedAt && (
              <Button variant="ghost" className="min-h-9 px-2.5 text-danger hover:text-danger" onClick={() => revoke.mutate(k)} aria-label={t('integrations.revoke')}>
                <Trash2 size={15} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <NewKeyModal open={adding} onClose={() => setAdding(false)} />
    </Card>
  );
}

function NewKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [days, setDays] = useState<string>('365');
  const [token, setToken] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ token: string }>('/api/api-keys', { method: 'POST', body: { name, role, expiresInDays: days ? Number(days) : null } }),
    onSuccess: (r) => { setToken(r.token); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
  });
  const close = () => { setName(''); setRole('operator'); setDays('365'); setToken(null); create.reset(); onClose(); };
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <Modal open={open} onClose={close} title={token ? t('integrations.keyCreated') : t('integrations.newKey')}>
      {token ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-fg-2">{t('integrations.keyOnce')}</p>
          <div className="flex items-center gap-1 rounded-xl border border-accent/40 bg-bg pl-3">
            <code className="min-w-0 flex-1 truncate py-2.5 font-mono text-[13px] text-fg">{token}</code>
            <CopyButton value={token} className="min-h-9 px-3" />
          </div>
          <pre className="overflow-x-auto rounded-xl border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-fg-2">{`curl -H "Authorization: Bearer ${token.slice(0, 10)}…" \\\n  ${location.origin}/api/streams`}</pre>
          <div className="flex justify-end"><Button variant="primary" onClick={close}>{t('common.done')}</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t('common.name')} hint={t('integrations.keyNameHint')}>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus placeholder={t('integrations.keyNamePlaceholder')} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.role')} hint={t(`integrations.roleHint_${role}`)}>
              {(id) => (
                <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {(['viewer', 'operator', 'admin'] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('integrations.expiry')}>
              {(id) => (
                <Select id={id} value={days} onChange={(e) => setDays(e.target.value)}>
                  {['30', '90', '365'].map((d) => <option key={d} value={d}>{t('integrations.days', { n: Number(d) })}</option>)}
                  <option value="">{t('integrations.never')}</option>
                </Select>
              )}
            </Field>
          </div>
          <ErrorText error={create.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>{t('integrations.createKey')}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Webhooks() {
  const { t } = useTranslation();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api<Webhook[]>('/api/webhooks'), refetchInterval: 10_000 });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  return (
    <Card
      eyebrow={t('integrations.webhooksEyebrow')} title={t('integrations.webhooksTitle')}
      actions={<Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} /> {t('integrations.newWebhook')}</Button>}
    >
      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-fg-2">{t('integrations.webhooksIntro')}</p>
      {hooks.data?.length === 0 && <p className="text-sm text-fg-3">{t('integrations.noWebhooks')}</p>}
      <div className="flex flex-col gap-3">
        {hooks.data?.map((h) => <WebhookRow key={h.id} h={h} onEdit={() => setEditing(h)} />)}
      </div>
      <details className="mt-6 rounded-xl border border-line bg-bg/40 p-4 text-sm">
        <summary className="cursor-pointer font-medium">{t('integrations.verifyTitle')}</summary>
        <p className="mt-3 text-xs leading-relaxed text-fg-3">{t('integrations.verifyText')}</p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-fg-2">{verifySnippet}</pre>
      </details>
      <WebhookModal editing={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

const verifySnippet = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header = req.headers['x-restream-signature']  ("t=1731430000,v1=5f2c…")
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}`;

function WebhookRow({ h, onEdit }: { h: Webhook; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status: number | null; error: string | null; durationMs: number } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['webhooks'] }); qc.invalidateQueries({ queryKey: ['webhook-deliveries', h.id] }); };
  const act = useMutation({
    mutationFn: async (a: 'test' | 'toggle' | 'delete' | 'rotate') => {
      switch (a) {
        case 'test': setResult(await api(`/api/webhooks/${h.id}/test`, { method: 'POST' })); return;
        case 'toggle': return api(`/api/webhooks/${h.id}`, { method: 'PUT', body: { name: h.name, url: h.url, events: h.events, enabled: !h.enabled } });
        case 'rotate':
          if (!confirm(t('integrations.confirmRotateSecret'))) return;
          return api(`/api/webhooks/${h.id}/rotate-secret`, { method: 'POST' });
        case 'delete':
          if (!confirm(t('integrations.confirmDeleteWebhook', { name: h.name }))) return;
          return api(`/api/webhooks/${h.id}`, { method: 'DELETE' });
      }
    },
    onSettled: refresh,
  });
  const tone = h.stats.lastStatus === 'failed' ? 'danger' : h.stats.lastStatus === 'pending' ? 'warn' : h.stats.lastStatus === 'delivered' ? 'ok' : 'neutral';

  return (
    <div className="rounded-xl border border-line bg-bg/40">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
        <button className="flex min-w-0 flex-1 basis-64 items-center gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={16} className="text-fg-3" /> : <ChevronRight size={16} className="text-fg-3" />}
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-accent"><WebhookIcon size={16} /></div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{h.name}</span>
            <span className="truncate font-mono text-xs text-fg-3">{h.url}</span>
          </div>
        </button>
        <span className="text-xs text-fg-2">{h.events.length ? t('integrations.eventsCount', { count: h.events.length }) : t('integrations.allEvents')}</span>
        <Badge tone={tone} dot>
          {h.stats.lastStatus ? t(`integrations.status_${h.stats.lastStatus}`) : t('integrations.noDeliveries')}
        </Badge>
        <Toggle checked={h.enabled} onChange={() => act.mutate('toggle')} label={<span className="text-xs text-fg-2">{t('integrations.active')}</span>} />
        <div className="flex gap-1">
          <Button variant="ghost" className="min-h-9 px-2.5" onClick={() => act.mutate('test')} loading={act.isPending && act.variables === 'test'} aria-label={t('integrations.test')} title={t('integrations.test')}><Send size={15} /></Button>
          <Button variant="ghost" className="min-h-9 px-2.5" onClick={onEdit} aria-label={t('common.edit')}><Pencil size={15} /></Button>
          <Button variant="ghost" className="min-h-9 px-2.5 text-danger hover:text-danger" onClick={() => act.mutate('delete')} aria-label={t('common.delete')}><Trash2 size={15} /></Button>
        </div>
        {result && (
          <p className={clsx('basis-full rounded-lg px-3 py-2 text-xs', result.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger')}>
            {result.ok ? t('integrations.testOk', { status: result.status, ms: result.durationMs }) : t('integrations.testFailed', { error: result.error })}
          </p>
        )}
        {act.error && <div className="basis-full"><ErrorText error={act.error} /></div>}
      </div>
      {open && (
        <div className="flex flex-col gap-4 border-t border-line p-4">
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('integrations.secret')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <SecretField value={h.secret} />
              <Button variant="secondary" onClick={() => act.mutate('rotate')}><RotateCw size={15} /> {t('integrations.rotateSecret')}</Button>
            </div>
            <span className="text-xs text-fg-3">{t('integrations.secretHint')}</span>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
            {(['delivered', 'pending', 'failed'] as const).map((k) => (
              <div key={k} className="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span className="eyebrow">{t(`integrations.status_${k}`)}</span>
                <span className="font-mono text-lg">{h.stats[k]}</span>
              </div>
            ))}
          </div>
          <Deliveries id={h.id} />
        </div>
      )}
    </div>
  );
}

function SecretField({ value }: { value: string }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 basis-72 items-center gap-1 rounded-xl border border-line bg-bg pl-3">
      <code className="min-w-0 flex-1 truncate py-2 font-mono text-[13px]">{show ? value : '•'.repeat(28)}</code>
      <Button variant="ghost" className="min-h-9 px-2.5 text-xs" onClick={() => setShow((v) => !v)}>{show ? t('streams.hide') : t('streams.show')}</Button>
      <CopyButton value={value} className="min-h-9 px-3" />
    </div>
  );
}

function Deliveries({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhook-deliveries', id], queryFn: () => api<WebhookDelivery[]>(`/api/webhooks/${id}/deliveries`), refetchInterval: 5000 });
  const [payload, setPayload] = useState<string | null>(null);
  const redeliver = useMutation({
    mutationFn: (d: string) => api(`/api/webhooks/deliveries/${d}/redeliver`, { method: 'POST' }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['webhook-deliveries', id] }); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
  });
  if (!q.data) return null;
  if (!q.data.length) return <p className="text-sm text-fg-3">{t('integrations.noDeliveries')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">{t('integrations.deliveries')}</span>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {q.data.map((d) => (
          <li key={d.id} className="flex flex-col">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm">
              <button className="min-w-0 flex-1 basis-48 truncate text-left font-mono text-[13px]" onClick={() => setPayload(payload === d.id ? null : d.id)}>{d.event}</button>
              <Badge tone={d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'danger' : 'warn'} dot>{t(`integrations.status_${d.status}`)}</Badge>
              <span className="font-mono text-xs text-fg-3">{d.responseCode ?? '—'}{d.durationMs !== null && ` · ${d.durationMs} ms`}</span>
              <span className="text-xs text-fg-3">{t('integrations.attempts', { n: d.attempts })}{d.nextAttemptAt && ` · ${t('integrations.retryAt', { date: formatDate(d.nextAttemptAt) })}`}</span>
              <span className="text-xs text-fg-3">{formatDate(d.createdAt)}</span>
              {d.status !== 'pending' && <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => redeliver.mutate(d.id)}>{t('integrations.redeliver')}</Button>}
            </div>
            {d.error && <span className="px-3 pb-2 font-mono text-xs text-danger">{d.error}</span>}
            {payload === d.id && <pre className="mx-3 mb-3 max-h-72 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs text-fg-2">{JSON.stringify(d.payload, null, 2)}</pre>}
          </li>
        ))}
      </ul>
      <ErrorText error={redeliver.error} />
    </div>
  );
}

function WebhookModal({ editing, onClose }: { editing: Webhook | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const events = useQuery({ queryKey: ['webhook-events'], queryFn: () => api<string[]>('/api/webhooks/events'), staleTime: Infinity, enabled: editing !== null });
  const [f, setF] = useState({ name: '', url: '', events: [] as string[], enabled: true, all: true });
  const [lastFor, setLastFor] = useState<string | null>(null);
  const key = editing === 'new' ? 'new' : editing?.id ?? null;
  if (key !== lastFor) {
    setLastFor(key);
    const h = editing && editing !== 'new' ? editing : null;
    setF(h ? { name: h.name, url: h.url, events: h.events, enabled: h.enabled, all: h.events.length === 0 } : { name: '', url: 'https://', events: [], enabled: true, all: true });
  }
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, url: f.url.trim(), events: f.all ? [] : f.events, enabled: f.enabled };
      return editing === 'new' ? api('/api/webhooks', { method: 'POST', body }) : api(`/api/webhooks/${(editing as Webhook).id}`, { method: 'PUT', body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks'] }); onClose(); },
  });
  const toggle = (e: string) => setF((cur) => ({ ...cur, events: cur.events.includes(e) ? cur.events.filter((x) => x !== e) : [...cur.events, e] }));
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const groups = new Map<string, string[]>();
  for (const e of events.data ?? []) {
    const g = e.split('.')[0];
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }

  return (
    <Modal open={editing !== null} onClose={onClose} wide title={editing === 'new' ? t('integrations.newWebhook') : t('integrations.editWebhook')}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Field label={t('common.name')}>
            {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={60} placeholder={t('integrations.webhookNamePlaceholder')} />}
          </Field>
          <Field label={t('integrations.url')} hint={t('integrations.urlHint')}>
            {(id) => <Input id={id} type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required className="font-mono text-[13px]" />}
          </Field>
        </div>
        <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={t('integrations.active')} />
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg/40 p-4">
          <Toggle checked={f.all} onChange={(v) => setF({ ...f, all: v })} label={t('integrations.allEventsLong')} />
          {!f.all && (
            <div className="grid gap-4 sm:grid-cols-2">
              {[...groups].map(([g, list]) => (
                <fieldset key={g} className="flex flex-col gap-2">
                  <legend className="eyebrow mb-1">{t(`integrations.group_${g}`)}</legend>
                  {list.map((e) => (
                    <label key={e} className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input type="checkbox" checked={f.events.includes(e)} onChange={() => toggle(e)} className="mt-1 size-4 accent-[var(--rs-accent)]" />
                      <span className="flex flex-col">
                        <span className="font-mono text-[13px]">{e}</span>
                        <span className="text-xs text-fg-3">{t(`integrations.ev_${e.replace(/\./g, '_')}`)}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          )}
        </div>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.all && !f.events.length}>{editing === 'new' ? t('integrations.createWebhook') : t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
