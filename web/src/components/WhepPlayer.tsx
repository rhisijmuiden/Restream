import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';

/**
 * Low-latency WebRTC (WHEP) preview. Connects while `active` is true and reconnects after failures.
 * `url` is a same-origin WHEP endpoint; requests carry the console's CSRF header.
 */
export function WhepPlayer({ url, active, sessionKey }: { url: string; active: boolean; sessionKey: string }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!active) { setPlaying(false); return; }
    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let session: string | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      pc?.close(); pc = null;
      if (session) fetch(session, { method: 'DELETE', headers: { 'x-restream': '1' } }).catch(() => {});
      session = null;
    };
    const scheduleRetry = () => {
      cleanup();
      setPlaying(false);
      if (!stopped) retry = setTimeout(connect, 3000);
    };

    async function connect() {
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
          if (pc.connectionState === 'connected') setPlaying(true);
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') scheduleRetry();
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
  }, [url, active, sessionKey]);

  return (
    <div className="absolute inset-0">
      <video ref={video} autoPlay playsInline muted={muted} className={playing ? 'size-full bg-black object-contain' : 'hidden'} />
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
