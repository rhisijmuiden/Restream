import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { KeyRound, MoreHorizontal, Plus, ShieldCheck, ShieldOff, Trash2, UserX, UserCheck } from 'lucide-react';
import { api, type Role } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatDate } from '../lib/format';
import { Badge, Button, CopyButton, ErrorText, Field, Input, Modal, PageHeader, Select } from '../components/ui';

interface UserRow {
  id: string; email: string; name: string; role: Role; totp_enabled: boolean; disabled: boolean; locked: boolean;
  auth_source: 'local' | 'microsoft'; last_login_at: string | null; must_change_password: boolean;
}

export function Users() {
  const { t } = useTranslation();
  const me = useMe().data!.user!;
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
  const [adding, setAdding] = useState(false);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const act = useMutation({
    mutationFn: async ({ u, action, role }: { u: UserRow; action: string; role?: Role }) => {
      setError(null);
      switch (action) {
        case 'role': return api(`/api/users/${u.id}`, { method: 'PATCH', body: { role } });
        case 'toggle': return api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } });
        case 'reset2fa':
          if (!confirm(t('users.confirmReset2fa', { email: u.email }))) return;
          return api(`/api/users/${u.id}/reset-2fa`, { method: 'POST' });
        case 'resetpw': {
          const r = await api<{ temporaryPassword: string }>(`/api/users/${u.id}/reset-password`, { method: 'POST' });
          setTemp({ email: u.email, password: r.temporaryPassword });
          return;
        }
        case 'delete':
          if (!confirm(t('users.confirmDelete', { email: u.email }))) return;
          return api(`/api/users/${u.id}`, { method: 'DELETE' });
      }
    },
    onSettled: () => { setMenu(null); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: setError,
  });

  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('users.title')} subtitle={t('users.subtitle')}
        actions={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} /> {t('users.add')}</Button>} />
      <div className="mb-4"><ErrorText error={error} /></div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="hidden border-b border-line md:table-header-group">
            <tr className="eyebrow">
              <th className="px-5 py-3 font-normal">{t('common.name')}</th>
              <th className="px-5 py-3 font-normal">{t('common.role')}</th>
              <th className="px-5 py-3 font-normal">{t('users.source')}</th>
              <th className="px-5 py-3 font-normal">{t('users.lastLogin')}</th>
              <th className="px-5 py-3"><span className="sr-only">{t('common.actions')}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.data?.map((u) => (
              <tr key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 md:table-row md:p-0">
                <td className="min-w-0 flex-1 md:px-5 md:py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 font-mono text-xs text-fg-2">
                      {(u.name || u.email).slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2 truncate font-medium">
                        {u.name || u.email.split('@')[0]}
                        {u.id === me.id && <span className="text-xs font-normal text-fg-3">({t('users.you')})</span>}
                      </span>
                      <span className="truncate text-xs text-fg-3">{u.email}</span>
                    </div>
                  </div>
                </td>
                <td className="md:px-5 md:py-4">
                  <Select aria-label={t('users.editRole')} value={u.role} disabled={u.id === me.id}
                    onChange={(e) => act.mutate({ u, action: 'role', role: e.target.value as Role })}
                    className="min-h-9 w-auto py-0 text-sm">
                    {(['admin', 'operator', 'viewer'] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
                  </Select>
                </td>
                <td className="md:px-5 md:py-4">
                  <div className="flex flex-wrap gap-1.5">
                    {u.auth_source === 'microsoft'
                      ? <Badge tone="accent">{t('users.microsoft')}</Badge>
                      : <Badge tone={u.totp_enabled ? 'ok' : 'warn'} dot>2FA {u.totp_enabled ? t('users.on') : t('users.off')}</Badge>}
                    {u.disabled && <Badge tone="danger">{t('common.disabled')}</Badge>}
                    {u.locked && <Badge tone="danger">{t('users.locked')}</Badge>}
                  </div>
                </td>
                <td className="text-xs text-fg-3 md:px-5 md:py-4">{formatDate(u.last_login_at)}</td>
                <td className="relative md:px-5 md:py-4 md:text-right">
                  {u.id !== me.id && (
                    <>
                      <button aria-label={t('common.actions')} aria-expanded={menu === u.id} onClick={() => setMenu(menu === u.id ? null : u.id)}
                        className="rounded-lg p-2 text-fg-3 hover:bg-surface-2 hover:text-fg"><MoreHorizontal size={18} /></button>
                      {menu === u.id && (
                        <div className="absolute right-0 z-20 mt-1 flex w-56 flex-col rounded-xl border border-line bg-surface-2 p-1.5 text-left shadow-2xl md:right-5">
                          {u.auth_source === 'local' && <MenuItem icon={<KeyRound size={16} />} onClick={() => act.mutate({ u, action: 'resetpw' })}>{t('users.resetPassword')}</MenuItem>}
                          {u.auth_source === 'local' && <MenuItem icon={<ShieldOff size={16} />} onClick={() => act.mutate({ u, action: 'reset2fa' })}>{t('users.reset2fa')}</MenuItem>}
                          <MenuItem icon={u.disabled ? <UserCheck size={16} /> : <UserX size={16} />} onClick={() => act.mutate({ u, action: 'toggle' })}>{u.disabled ? t('users.enable') : t('users.disable')}</MenuItem>
                          <MenuItem danger icon={<Trash2 size={16} />} onClick={() => act.mutate({ u, action: 'delete' })}>{t('common.delete')}</MenuItem>
                        </div>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AddUser open={adding} onClose={() => setAdding(false)} onCreated={(email, password) => { setAdding(false); setTemp({ email, password }); qc.invalidateQueries({ queryKey: ['users'] }); }} />
      <Modal open={!!temp} onClose={() => setTemp(null)} title={t('users.tempPassword')}>
        <p className="text-sm text-fg-2">{t('users.tempPasswordText', { email: temp?.email })}</p>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2">
          <code className="flex-1 font-mono text-base text-accent">{temp?.password}</code>
          <CopyButton value={temp?.password ?? ''} />
        </div>
        <Button variant="primary" onClick={() => setTemp(null)}>{t('common.close')}</Button>
      </Modal>
    </>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-surface ${danger ? 'text-danger' : 'text-fg-2 hover:text-fg'}`}>
      {icon}{children}
    </button>
  );
}

function AddUser({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (email: string, password: string) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ email: '', name: '', role: 'operator' as Role, password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ temporaryPassword: string }>('/api/users', { method: 'POST', body: { ...form, password: form.password || undefined } });
      onCreated(form.email, r.temporaryPassword);
      setForm({ email: '', name: '', role: 'operator', password: '' });
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('users.addTitle')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorText error={error} />
        <Field label={t('common.email')}>{(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label={t('common.name')}>{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label={t('common.role')}>
          {(id) => (
            <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(['admin', 'operator', 'viewer'] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={<>{t('login.password')} <span className="text-fg-3">({t('common.optional')})</span></>} hint={t('users.passwordHint')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy}><ShieldCheck size={16} /> {t('users.add')}</Button>
        </div>
      </form>
    </Modal>
  );
}
