import { useTranslation } from 'react-i18next';
import { Construction } from 'lucide-react';
import { PageHeader } from '../components/ui';

export function ComingSoon({ titleKey, phase }: { titleKey: string; phase: number }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t(titleKey)} />
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><Construction size={26} /></div>
        <h2 className="font-display text-xl font-semibold">{t('soon.title', { phase })}</h2>
        <p className="max-w-md text-sm leading-relaxed text-fg-2">{t('soon.text')}</p>
        <a href="https://github.com/rhisijmuiden/restream/blob/test/docs/ROADMAP.md" target="_blank" rel="noreferrer" className="text-sm">{t('soon.roadmap')} →</a>
      </div>
    </>
  );
}
