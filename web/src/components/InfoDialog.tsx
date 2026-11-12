import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api, type SystemInfo } from '../lib/api';
import { formatDate, formatDuration, shortSha } from '../lib/format';
import { Badge, Button, KeyValue, Logo, Modal } from './ui';

export function InfoDialog({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin: boolean }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const info = useQuery({ queryKey: ['info'], queryFn: () => api<SystemInfo>('/api/system/info'), enabled: open });
  const d = info.data;
  return (
    <Modal open={open} onClose={onClose} title={t('info.title')}>
      <div className="flex items-center gap-4 rounded-xl border border-line bg-bg p-4">
        <Logo size={44} />
        <div className="flex flex-col gap-1">
          <span className="font-display text-lg font-semibold tracking-wide">RESTREAM</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-accent">v{d?.version ?? '…'}</span>
            {d && <Badge tone={d.channel === 'production' ? 'ok' : 'warn'} dot>{t(`channel.${d.channel}`)}</Badge>}
          </div>
        </div>
      </div>
      {d && (
        <KeyValue
          items={[
            [t('info.commit'), shortSha(d.commit)],
            [t('info.built'), d.builtAt ? formatDate(d.builtAt) : '—'],
            [t('info.server'), d.hostname],
            ['OS', d.os],
            ['Node.js', d.node],
            ['PostgreSQL', d.postgres],
            ['MediaMTX', d.mediamtx ?? '—'],
            ['FFmpeg', d.ffmpeg ?? '—'],
            [t('info.uptime'), formatDuration(d.uptimeSeconds)],
          ]}
        />
      )}
      <p className="text-xs text-fg-3">{t('info.license')} · <a href={`https://github.com/${d?.repository ?? 'rhisijmuiden/restream'}`} target="_blank" rel="noreferrer">GitHub</a></p>
      {isAdmin && (
        <Button variant="primary" onClick={() => { onClose(); nav('/admin/updates?check=1'); }}>
          <RefreshCw size={16} /> {t('info.checkUpdates')}
        </Button>
      )}
    </Modal>
  );
}
