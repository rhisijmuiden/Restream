import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { PageHeader } from '../components/ui';

interface Row { id: number; action: string; details: Record<string, unknown>; ip: string | null; created_at: string; email: string | null }

export function Audit() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<Row[]>('/api/audit?limit=200') });
  return (
    <>
      <PageHeader eyebrow={t('nav.administration')} title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-line">
            <tr className="eyebrow">
              <th className="px-5 py-3 font-normal">{t('audit.when')}</th>
              <th className="px-5 py-3 font-normal">{t('audit.who')}</th>
              <th className="px-5 py-3 font-normal">{t('audit.action')}</th>
              <th className="px-5 py-3 font-normal">{t('audit.ip')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {q.data?.map((r) => (
              <tr key={r.id}>
                <td className="px-5 py-3 whitespace-nowrap text-fg-3">{formatDate(r.created_at)}</td>
                <td className="px-5 py-3">{r.email ?? '—'}</td>
                <td className="px-5 py-3">
                  <code className="font-mono text-xs text-accent">{r.action}</code>
                  {Object.keys(r.details).length > 0 && <span className="ml-2 font-mono text-xs text-fg-3">{JSON.stringify(r.details)}</span>}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-fg-3">{r.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
