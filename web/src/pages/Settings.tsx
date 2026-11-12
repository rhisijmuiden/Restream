import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type Role } from '../lib/api';
import { Button, Card, CopyButton, ErrorText, Field, Input, PageHeader, Select, Toggle } from '../components/ui';

interface S {
  instanceName: string; defaultLanguage: 'en' | 'nl'; publicUrl: string; githubTokenSet: boolean;
  sso: { enabled: boolean; tenantId: string; clientId: string; allowedGroupId: string; autoProvision: boolean; defaultRole: Role; clientSecretSet: boolean; redirectUri: string };
}

export function Settings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<S>('/api/settings') });
  const [form, setForm] = useState<S | null>(null);
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [state, setState] = useState<{ busy?: boolean; saved?: string; error?: unknown }>({});

  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  if (!form) return null;

  async function save(section: 'general' | 'sso', e: FormEvent, extra: Record<string, unknown> = {}) {
    e.preventDefault();
    setState({ busy: true });
    try {
      const body = section === 'general'
        ? { instanceName: form!.instanceName, defaultLanguage: form!.defaultLanguage, publicUrl: form!.publicUrl, ...(token ? { githubToken: token } : {}), ...extra }
        : { sso: { enabled: form!.sso.enabled, tenantId: form!.sso.tenantId, clientId: form!.sso.clientId, allowedGroupId: form!.sso.allowedGroupId, autoProvision: form!.sso.autoProvision, defaultRole: form!.sso.defaultRole, ...(secret ? { clientSecret: secret } : {}) } };
      await api('/api/settings', { method: 'PUT', body });
      setSecret(''); setToken('');
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setState({ saved: section });
      setTimeout(() => setState({}), 2000);
    } catch (error) { setState({ error }); }
  }

  const sso = form.sso;
  const setSso = (p: Partial<S['sso']>) => setForm({ ...form, sso: { ...sso, ...p } });

  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('settings.title')} />
      <div className="mb-4"><ErrorText error={state.error} /></div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={t('settings.general')}>
          <form onSubmit={(e) => save('general', e)} className="flex flex-col gap-4">
            <Field label={t('settings.instanceName')}>{(id) => <Input id={id} required maxLength={60} value={form.instanceName} onChange={(e) => setForm({ ...form, instanceName: e.target.value })} />}</Field>
            <Field label={t('settings.defaultLanguage')}>
              {(id) => <Select id={id} value={form.defaultLanguage} onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value as 'en' | 'nl' })}><option value="en">English</option><option value="nl">Nederlands</option></Select>}
            </Field>
            <Field label={t('settings.publicUrl')} hint={t('settings.publicUrlHint')}>{(id) => <Input id={id} type="url" placeholder="https://restream.example.com" value={form.publicUrl} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} />}</Field>
            <Field label={t('settings.githubToken')} hint={form.githubTokenSet ? `${t('settings.tokenSet')} ${t('settings.githubTokenHint')}` : t('settings.githubTokenHint')}>
              {(id) => <Input id={id} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={form.githubTokenSet ? '••••••••' : 'github_pat_…'} />}
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary">{t('common.save')}</Button>
              {form.githubTokenSet && <Button type="button" variant="ghost" onClick={(e) => save('general', e, { githubToken: '' })}>{t('settings.clearToken')}</Button>}
              {state.saved === 'general' && <span className="text-sm text-ok">{t('common.saved')}</span>}
            </div>
          </form>
        </Card>

        <Card title={t('settings.sso')}>
          <form onSubmit={(e) => save('sso', e)} className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-fg-2">{t('settings.ssoText')}</p>
            <Toggle checked={sso.enabled} onChange={(v) => setSso({ enabled: v })} label={t('settings.ssoEnabled')} />
            <p className="rounded-xl border border-line bg-bg p-3 text-xs leading-relaxed text-fg-3">{t('settings.ssoHelp')}</p>
            <Field label={t('settings.redirectUri')}>
              {(id) => (
                <div className="flex items-center gap-2 rounded-xl border border-line bg-bg px-3 py-1.5">
                  {sso.redirectUri
                    ? <code id={id} className="flex-1 font-mono text-xs break-all text-accent">{sso.redirectUri}</code>
                    : <span id={id} className="flex-1 py-1 text-xs text-fg-3">{t('settings.publicUrlHint')}</span>}
                  {sso.redirectUri && <CopyButton value={sso.redirectUri} className="min-h-8 px-2" />}
                </div>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.tenantId')}>{(id) => <Input id={id} value={sso.tenantId} onChange={(e) => setSso({ tenantId: e.target.value })} placeholder="00000000-0000-…" className="font-mono text-sm" />}</Field>
              <Field label={t('settings.clientId')}>{(id) => <Input id={id} value={sso.clientId} onChange={(e) => setSso({ clientId: e.target.value })} placeholder="00000000-0000-…" className="font-mono text-sm" />}</Field>
            </div>
            <Field label={t('settings.clientSecret')} hint={sso.clientSecretSet ? t('settings.secretSet') : undefined}>
              {(id) => <Input id={id} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={sso.clientSecretSet ? '••••••••' : ''} />}
            </Field>
            <Field label={t('settings.allowedGroup')} hint={t('settings.allowedGroupHint')}>{(id) => <Input id={id} value={sso.allowedGroupId} onChange={(e) => setSso({ allowedGroupId: e.target.value })} className="font-mono text-sm" />}</Field>
            <Toggle checked={sso.autoProvision} onChange={(v) => setSso({ autoProvision: v })} label={t('settings.autoProvision')} />
            <Field label={t('settings.defaultRole')}>
              {(id) => (
                <Select id={id} value={sso.defaultRole} onChange={(e) => setSso({ defaultRole: e.target.value as Role })}>
                  {(['admin', 'operator', 'viewer'] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
                </Select>
              )}
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary">{t('common.save')}</Button>
              {state.saved === 'sso' && <span className="text-sm text-ok">{t('common.saved')}</span>}
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
