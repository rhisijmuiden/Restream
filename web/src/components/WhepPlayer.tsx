import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import type HlsType from 'hls.js/light';

/**
 * Console preview. Starts with low-latency WebRTC (WHEP) and falls back to LL-HLS when WebRTC cannot play the feed:
 * MediaMTX refuses H264 with B-frames over WebRTC (the OBS x264 default), and WebRTC carries no AAC audio.
 * HLS also works where UDP is blocked. `url` is the same-origin WHEP endpoint; HLS is served next to it.
 */
export function WhepPlayer({ url, active, sessionKey }: { url: string; active: boolean; sessionKey: string }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<'webrtc' | 'hls'>('webrtc');

  // A new feed (or stream) tries WebRTC again.
  useEffect(() => { setMode('webrtc'); }, [url, sessionKey]);

  useEffect(() => {
    if (!active || mode !== 'webrtc') { if (!active) setPlaying(false); return; }
    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let session: string | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let frameCheck: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let connectedAt = 0;

    const cleanup = () => {
      if (frameCheck) clearTimeout(frameCheck);
      pc?.close(); pc = null;
      if (session) fetch(session, { method: 'DELETE', headers: { 'x-restream': '1' } }).catch(() => {});
      session = null;
    };
    const fallBack = () => { cleanup(); setPlaying(false); if (!stopped) setMode('hls'); };
    const scheduleRetry = () => {
      // Closed right after connecting means MediaMTX refused the tracks: WebRTC will not work for this feed.
      if (connectedAt && Date.now() - connectedAt < 15000) return fallBack();
      if (++failures >= 2) return fallBack();
      cleanup();
      setPlaying(false);
      if (!stopped) retry = setTimeout(connect, 3000);
    };

    async function connect() {
      connectedAt = 0;
      try {
        pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        const ms = new MediaStream();
        pc.ontrack = (e) => {
          ms.addTrack(e.track);
          if (video.current && video.current.srcObject !== ms) video.current.srcObject = ms;
        };
        pc.onconnectionstatechange = () => {
          if (!pc) return;
          if (pc.connectionState === 'connected') {
            connectedAt = Date.now();
            setPlaying(true);
            frameCheck = setTimeout(() => { if (!video.current?.videoWidth) fallBack(); }, 5000);
          }
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') scheduleRetry();
        };
        await pc.setLocalDescription(await pc.createOffer());
        // Wait briefly for ICE candidates, so the offer works without trickle ICE.
        await new Promise<void>((resolve) => {
          if (pc!.iceGatheringState === 'complete') return resolve();
          const done = () => { if (pc?.iceGatheringState === 'complete') resolve(); };
          pc!.addEventListener('icegatheringstatechange', done);
          setTimeout(resolve, 1500);
        });
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/sdp', 'x-restream': '1' },
          body: pc.localDescription!.sdp,
        });
        if (res.status !== 201) throw new Error(`WHEP ${res.status}`);
        const loc = res.headers.get('location');
        session = loc ? new URL(loc, window.location.href).toString() : null;
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch {
        scheduleRetry();
      }
    }
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); cleanup(); };
  }, [url, active, sessionKey, mode]);

  useEffect(() => {
    if (!active || mode !== 'hls') return;
    const el = video.current;
    if (!el) return;
    let stopped = false;
    let hls: HlsType | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const src = url.replace(/\/whep$/, '/index.m3u8');
    el.srcObject = null;
    const onPlaying = () => setPlaying(true);
    el.addEventListener('playing', onPlaying);

    const start = async () => {
      const { default: Hls } = await import('hls.js/light');
      if (stopped) return;
      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, liveSyncDurationCount: 2 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || stopped) return;
          hls?.destroy(); hls = null; setPlaying(false);
          retry = setTimeout(() => void start(), 3000);
        });
        hls.loadSource(src);
        hls.attachMedia(el);
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = src; // Safari plays HLS natively.
      }
      el.play().catch(() => {});
    };
    void start();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      el.removeEventListener('playing', onPlaying);
      hls?.destroy();
      el.removeAttribute('src'); el.load();
      setPlaying(false);
    };
  }, [url, active, sessionKey, mode]);

  return (
    <div className="absolute inset-0">
      <video ref={video} autoPlay playsInline muted={muted} className={playing ? 'size-full bg-black object-contain' : 'hidden'} />
      {playing && mode === 'hls' && (
        <span title={t('dashboard.previewHlsHint')} className="absolute bottom-4 left-4 rounded-full border border-line bg-bg/70 px-2.5 py-1 font-mono text-[11px] text-fg-2 backdrop-blur">
          {t('dashboard.previewHls')}
        </span>
      )}
      {playing && (
        <button
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? t('dashboard.unmute') : t('dashboard.mute')}
          className="absolute right-4 bottom-4 flex size-9 items-center justify-center rounded-full border border-line bg-bg/70 text-fg-2 backdrop-blur hover:text-fg"
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      )}
    </div>
  );
}
