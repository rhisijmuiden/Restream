import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useMe, useRefreshMe } from '../lib/auth';
import { formatDate } from '../lib/format';
import { setLanguage } from '../i18n';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select } from '../components/ui';
import { PasswordForm } from './ChangePassword';
import { RecoveryCodes, TotpEnrol } from './Setup2fa';

interface Session { id: string; ip: string; user_agent: string; created_at: string; last_seen_at: string; current: boolean }

export function Account() {
  const { t } = useTranslation();
  const me = useMe().data!.user!;
  const refresh = useRefreshMe();
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const [saved, setSaved] = useState(false);
  const [reenrol, setReenrol] = useState(false);
  const [codeForm, setCodeForm] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<Session[]>('/api/auth/sessions') });
  const local = me.auth_source === 'local';

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    await api('/api/auth/me', { method: 'PATCH', body: { name } });
    await refresh();
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  }

  async function newCodes(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/recovery-codes', { method: 'POST', body: { code: codeForm } });
      setCodes(r.recoveryCodes); setCodeForm('');
    } catch (err) { setError(err); }
  }

  return (
    <>
      <PageHeader title={t('account.title')} subtitle={me.email} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('account.profile')}>
          <form onSubmit={saveProfile} className="flex flex-col gap-4">
            <Field label={t('common.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label={t('account.language')}>
              {(id) => (
                <Select id={id} value={me.language} onChange={async (e) => {
                  const lang = e.target.value as 'en' | 'nl';
                  await setLanguage(lang);
                  await api('/api/auth/me', { method: 'PATCH', body: { language: lang } });
                  refresh();
                }}>
                  <option value="en">{t('lang.en')}</option><option value="nl">{t('lang.nl')}</option>
                </Select>
              )}
            </Field>
            <div className="flex items-center gap-3"><Button type="submit" variant="primary">{t('common.save')}</Button>{saved && <span className="text-sm text-ok">{t('common.saved')}</span>}</div>
          </form>
        </Card>

        {local ? (
          <Card title={t('account.password')}><PasswordForm /></Card>
        ) : (
          <Card title={t('account.password')}><p className="text-sm text-fg-2">{t('account.ssoManaged')}</p></Card>
        )}

        {local && (
          <Card title={t('account.twofa')} actions={<Badge tone="ok" dot>{t('users.on')}</Badge>}>
            <div className="flex flex-col gap-5">
              <p className="text-sm text-fg-2">{t('account.twofaOn', { n: me.recovery_left })}</p>
              <form onSubmit={newCodes} className="flex flex-col gap-3">
                <span className="text-sm font-medium">{t('account.newCodes')}</span>
                <p className="text-xs leading-relaxed text-fg-3">{t('account.newCodesText')}</p>
                <ErrorText error={error} />
                <div className="flex gap-2">
                  <Input aria-label={t('login.mfaCode')} value={codeForm} onChange={(e) => setCodeForm(e.target.value)} placeholder="000 000" inputMode="numeric" maxLength={7} className="font-mono tracking-[0.2em]" />
                  <Button type="submit">{t('common.continue')}</Button>
                </div>
              </form>
              <Button variant="ghost" className="self-start" onClick={() => setReenrol(true)}>{t('account.reenrol')}</Button>
            </div>
          </Card>
        )}

        <Card title={t('account.sessions')}>
          <ul className="flex flex-col divide-y divide-line">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{s.user_agent || '—'}</span>
                  <span className="font-mono text-xs text-fg-3">{s.ip} · {formatDate(s.last_seen_at)}</span>
                </div>
                {s.current ? <Badge tone="accent">{t('account.current')}</Badge> : (
                  <Button variant="ghost" onClick={async () => { await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['sessions'] }); }}>{t('account.revoke')}</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Modal open={reenrol} onClose={() => setReenrol(false)} title={t('account.reenrol')}>
        {reenrol && <TotpEnrol onDone={() => { setReenrol(false); refresh(); }} />}
      </Modal>
      <Modal open={!!codes} onClose={() => setCodes(null)} title={t('account.newCodes')}>
        {codes && <RecoveryCodes codes={codes} onDone={() => { setCodes(null); refresh(); }} />}
      </Modal>
    </>
  );
}
