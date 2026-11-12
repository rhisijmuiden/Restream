import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useRefreshMe } from '../lib/auth';
import { Button, CopyButton, ErrorText, Field, Input } from '../components/ui';
import { AuthShell } from './AuthShell';

interface Enrol { secret: string; uri: string; qr: string }

/** TOTP enrolment form; used for forced setup after sign-in and from the account page. */
export function TotpEnrol({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [enrol, setEnrol] = useState<Enrol | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<Enrol>('/api/auth/mfa/setup', { method: 'POST' }).then(setEnrol).catch(setError);
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/setup/confirm', { method: 'POST', body: { code } });
      setCodes(r.recoveryCodes);
    } catch (err) { setError(err); setCode(''); } finally { setBusy(false); }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;

  return (
    <form onSubmit={confirm} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-[22px] font-semibold">{t('setup2fa.title')}</h2>
        <p className="text-sm leading-relaxed text-fg-3">{t('setup2fa.text')}</p>
      </div>
      <ErrorText error={error} />
      {enrol && (
        <>
          <div className="flex justify-center">
            <img src={enrol.qr} alt="QR code" width={200} height={200} className="rounded-xl bg-white p-2" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-3">{t('setup2fa.manual')}</span>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2">
              <code className="flex-1 font-mono text-xs break-all text-fg-2">{enrol.secret}</code>
              <CopyButton value={enrol.secret} className="min-h-8 px-2" />
            </div>
          </div>
        </>
      )}
      <Field label={t('setup2fa.code')}>
        {(id) => <Input id={id} autoComplete="one-time-code" inputMode="numeric" required maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="000 000" className="font-mono tracking-[0.25em]" />}
      </Field>
      <Button type="submit" variant="primary" loading={busy} disabled={!enrol}>{t('setup2fa.confirm')}</Button>
    </form>
  );
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const text = codes.join('\n');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-[22px] font-semibold">{t('setup2fa.codesTitle')}</h2>
        <p className="text-sm leading-relaxed text-fg-3">{t('setup2fa.codesText')}</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-bg p-4 font-mono text-sm text-fg">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-2">
        <CopyButton value={text} className="flex-1 border border-line" />
        <a
          className="inline-flex min-h-10 flex-1 items-center justify-center rounded-xl border border-line text-sm text-fg-2 no-underline hover:text-fg"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}`} download="restream-recovery-codes.txt"
        >{t('common.download')}</a>
      </div>
      <Button variant="primary" onClick={onDone}>{t('setup2fa.codesDone')}</Button>
    </div>
  );
}

export function Setup2fa() {
  const refresh = useRefreshMe();
  const nav = useNavigate();
  return (
    <AuthShell>
      <TotpEnrol onDone={async () => { await refresh(); nav('/'); }} />
    </AuthShell>
  );
}

