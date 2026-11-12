import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Button, ErrorText, Field, Input } from '../components/ui';

export function PasswordForm({ onDone, forced }: { onDone?: () => void; forced?: boolean }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(false);
    if (next !== repeat) return setError(new Error('mismatch'));
    setBusy(true);
    try {
      await api('/api/auth/password', { method: 'POST', body: { current, next } });
      setCurrent(''); setNext(''); setRepeat(''); setDone(true);
      onDone?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {forced && <p className="text-sm leading-relaxed text-fg-2">{t('changePassword.forced')}</p>}
      {error instanceof Error && error.message === 'mismatch'
        ? <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">{t('changePassword.mismatch')}</p>
        : <ErrorText error={error} />}
      {done && <p role="status" className="rounded-xl border border-ok/40 bg-ok/10 px-3.5 py-2.5 text-sm text-ok">{t('changePassword.done')}</p>}
      <Field label={t('changePassword.current')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
      <Field label={t('changePassword.new')} hint={t('changePassword.hint')}>{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
      <Field label={t('changePassword.repeat')}>{(id) => <Input id={id} type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />}</Field>
      <Button type="submit" variant="primary" loading={busy}>{t('changePassword.submit')}</Button>
    </form>
  );
}
