import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { BadgeCheck, ExternalLink } from 'lucide-react';

/** Where to get the paid subscription each platform asks for. */
const signUp = { x: 'https://x.com/i/premium_sign_up' } as const;

/** "Paid account required": X only lets subscribers (X Premium) go live from a streaming tool such as Restream. */
export function PaidNotice({ provider, className }: { provider: keyof typeof signUp; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={clsx('mb-4 flex gap-2.5 rounded-xl border border-warn/40 bg-warn/[0.06] px-3 py-2.5', className)}>
      <BadgeCheck size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-semibold text-warn">{t(`accounts.paid.${provider}.title`)}</span>
        <span className="text-xs leading-relaxed text-fg-2">{t(`accounts.paid.${provider}.text`)}</span>
        <a href={signUp[provider]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-xs">
          {t(`accounts.paid.${provider}.link`)} <ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
}
