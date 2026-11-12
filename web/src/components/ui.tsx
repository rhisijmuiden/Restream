import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, X } from 'lucide-react';
import { ApiError } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-ink hover:bg-accent-hover glow font-semibold',
        variant === 'secondary' && 'border border-line bg-surface-2 text-fg hover:border-line-strong',
        variant === 'ghost' && 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'border border-danger/50 text-danger hover:bg-danger/10',
        className,
      )}
    >
      {loading && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-bg px-3.5 text-[15px] text-fg placeholder:text-fg-3 transition-colors hover:border-line-strong focus:border-accent focus:outline-none';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputClass, 'appearance-none bg-[length:16px] pr-9', props.className)} />;
}

export function Field({ label, hint, children, id }: { label: ReactNode; hint?: ReactNode; children: (id: string) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fid} className="text-[13px] font-medium text-fg-2">{label}</label>
      {children(fid)}
      {hint && <p className="text-xs leading-relaxed text-fg-3">{hint}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx('flex cursor-pointer items-center gap-3 text-sm text-fg', disabled && 'opacity-50')}>
      <button
        type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-6 w-11 shrink-0 rounded-full border transition-colors', checked ? 'border-accent bg-accent/25' : 'border-line bg-surface-2')}
      >
        <span className={clsx('absolute top-0.5 size-4.5 rounded-full transition-all', checked ? 'left-[22px] bg-accent' : 'left-0.5 bg-fg-3')} />
      </button>
      <span>{label}</span>
    </label>
  );
}

export function Card({ className, children, title, actions, eyebrow }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <section className={clsx('rounded-2xl border border-line bg-surface p-5 sm:p-6', className)}>
      {(title || actions || eyebrow) && (
        <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h2 className="font-display text-lg font-semibold">{title}</h2>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children, dot }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'live'; children: ReactNode; dot?: boolean }) {
  const tones = {
    neutral: 'border-line text-fg-2', accent: 'border-accent/40 text-accent', ok: 'border-ok/40 text-ok',
    warn: 'border-warn/40 text-warn', danger: 'border-danger/40 text-danger', live: 'border-live/50 text-live',
  };
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-wide', tones[tone])}>
      {dot && <span className={clsx('size-1.5 rounded-full bg-current', tone === 'live' && 'pulse-dot')} />}
      {children}
    </span>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="flex max-w-2xl flex-col gap-1.5">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="text-sm leading-relaxed text-fg-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={clsx('m-auto w-[calc(100%-32px)] rounded-2xl border border-line bg-surface p-0 text-fg backdrop:bg-black/70 backdrop:backdrop-blur-sm', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 className="font-display text-lg font-semibold">{title}</h2>
            <button onClick={onClose} aria-label={t('common.close')} className="-m-1 rounded-lg p-1 text-fg-3 hover:text-fg"><X size={18} /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button" variant="ghost" className={className}
      onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}
    >
      {done ? <Check size={16} /> : <Copy size={16} />} {done ? t('common.copied') : t('common.copy')}
    </Button>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation();
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error);
  const key = `errors.${code}`;
  return (
    <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
      {i18n.exists(key) ? t(key) : t('errors.generic')}
    </p>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="min-w-0 truncate text-right font-mono text-[13px] text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <div className="flex shrink-0 items-center justify-center rounded-[11px] bg-accent glow" style={{ width: size, height: size }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="#070A12" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 12h5M16 5h5M16 12h5M16 19h5M8 12l8-7M8 12h8M8 12l8 7" />
      </svg>
    </div>
  );
}
