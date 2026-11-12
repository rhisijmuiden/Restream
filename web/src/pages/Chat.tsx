import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Radio } from 'lucide-react';
import { useStreams } from '../lib/streams';
import { useLive } from '../lib/live';
import { Audience, ChatList } from '../components/live';
import { Badge, PageHeader } from '../components/ui';
import { Segmented } from '../components/media';

/** The combined chat on a full page, e.g. on a second screen next to the mixer. */
export function Chat() {
  const { t } = useTranslation();
  const q = useStreams();
  const [params, setParams] = useSearchParams();
  const streams = q.data?.streams ?? [];
  const stream = streams.find((s) => s.id === params.get('stream')) ?? streams.find((s) => s.destinations.some((d) => d.status.state === 'live')) ?? streams[0];
  const live = useLive(stream?.id);
  const b = live.data?.broadcast;

  return (
    <>
      <PageHeader
        eyebrow={t('nav.broadcast')} title={t('chat.title')} subtitle={t('chat.subtitle')}
        actions={b ? <Badge tone="live" dot>{b.title}</Badge> : <Badge><Radio size={11} /> {t('live.offAirShort')}</Badge>}
      />
      {streams.length > 1 && stream && (
        <Segmented
          label={t('dashboard.selectStream')} value={stream.id} className="mb-6 self-start"
          options={streams.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(id) => setParams({ stream: id })}
        />
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <ChatList
          messages={live.chat} destinations={live.data?.destinations}
          className="h-[calc(100dvh-260px)] min-h-[420px]"
          empty={b ? undefined : t('live.chatOffAir')}
        />
        <div className="flex flex-col gap-6">
          <Audience data={live.data} />
          <p className="text-xs leading-relaxed text-fg-3">{t('chat.readOnly')}</p>
        </div>
      </div>
    </>
  );
}
