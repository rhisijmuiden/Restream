import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '../components/ui';
import { setLanguage } from '../i18n';
import { clsx } from 'clsx';

/** Split screen used by sign-in, 2FA and forced password change. */
export function AuthShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="grid-bg flex min-h-dvh flex-col lg:flex-row">
      <div className="flex flex-1 flex-col justify-between gap-10 px-6 py-8 sm:px-12 lg:p-[72px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <span className="font-display text-xl font-bold tracking-[0.04em]">RESTREAM</span>
          </div>
          <div className="flex gap-1 rounded-xl border border-line bg-surface p-1 font-mono text-xs" role="group" aria-label={t('lang.switch')}>
            {(['en', 'nl'] as const).map((l) => (
              <button key={l} onClick={() => setLanguage(l)} aria-pressed={i18n.language === l}
                className={clsx('rounded-lg px-2.5 py-1.5', i18n.language === l ? 'bg-surface-2 text-accent' : 'text-fg-3 hover:text-fg-2')}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="hidden max-w-xl flex-col gap-6 lg:flex">
          <span className="font-mono text-[13px] tracking-[0.12em] text-accent uppercase">{t('login.eyebrow')}</span>
          <h1 className="font-display text-6xl leading-[1.05] font-semibold tracking-tight whitespace-pre-line">{t('login.hero')}</h1>
          <p className="text-[17px] leading-relaxed text-fg-2">{t('login.heroText')}</p>
        </div>
        <SignalDiagram />
      </div>
      <div className="flex items-center justify-center px-4 pb-10 sm:px-12 lg:w-[560px] lg:p-12">
        <div className="w-full max-w-[440px] rounded-[20px] border border-line bg-surface/90 p-6 shadow-[0_0_0_1px_rgba(46,230,214,0.06),0_30px_80px_rgba(0,0,0,0.5)] backdrop-blur sm:p-10">
          {children}
        </div>
      </div>
    </div>
  );
}

function SignalDiagram() {
  const outs = [['YouTube', 'var(--rs-youtube)'], ['Facebook', 'var(--rs-facebook)'], ['Twitch', 'var(--rs-twitch)']];
  return (
    <div aria-hidden className="hidden items-center lg:flex">
      <div className="rounded-[10px] border border-line bg-surface px-3.5 py-2.5 font-mono text-xs text-fg-2">SRT IN</div>
      <div className="h-px w-16 bg-accent shadow-[0_0_8px_var(--rs-accent)]" />
      <div className="size-3.5 rounded-full bg-accent shadow-[0_0_16px_var(--rs-accent)]" />
      <div className="flex flex-col gap-2.5">
        {outs.map(([name, color]) => (
          <div key={name} className="flex items-center">
            <div className="h-px w-12" style={{ background: color }} />
            <span className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-fg-2">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
