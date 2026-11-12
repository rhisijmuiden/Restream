/**
 * Restream embed player (served at /embed/<playbackId>). Plain TypeScript, no React, to stay small.
 * Plays LL-HLS by default (hls.js, or natively in Safari) and WebRTC (WHEP) with ?mode=webrtc,
 * falling back to HLS when WebRTC cannot connect. Options: ?autoplay=1 &muted=1 &title=0 &mode=webrtc.
 */
import Hls from 'hls.js/light';
import './embed.css';

interface EmbedConfig { state: 'ok' | 'not_found' | 'restricted'; mediaBase: string; title: string; instance: string; reloadAt: number }

const cfg: EmbedConfig = (() => {
  const raw = document.querySelector<HTMLMetaElement>('meta[name="restream-embed"]')?.content;
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
})() ?? { state: 'not_found', mediaBase: '', title: '', instance: 'Restream', reloadAt: 0 };

const params = new URLSearchParams(location.search);
const opt = {
  autoplay: params.get('autoplay') === '1',
  muted: params.get('muted') === '1' || params.get('autoplay') === '1',
  showTitle: params.get('title') !== '0',
  webrtc: params.get('mode') === 'webrtc',
};

const nl = /^nl\b/i.test(params.get('lang') ?? navigator.language ?? '');
const T = nl ? {
  live: 'Live', offline: 'Offline', waitingTitle: 'De uitzending begint zo', waitingText: 'Zodra het signaal binnenkomt, start de speler vanzelf.',
  restrictedTitle: 'Deze stream kan hier niet worden afgespeeld', restrictedText: 'De eigenaar heeft afspelen beperkt tot bepaalde websites of links.',
  notFoundTitle: 'Stream niet gevonden', notFoundText: 'Deze link werkt niet (meer).', play: 'Afspelen', pause: 'Pauzeren', mute: 'Geluid uit',
  unmute: 'Geluid aan', fullscreen: 'Volledig scherm', pip: 'Beeld-in-beeld', volume: 'Volume', toLive: 'Naar live',
} : {
  live: 'Live', offline: 'Offline', waitingTitle: 'The broadcast starts soon', waitingText: 'The player starts by itself as soon as the signal comes in.',
  restrictedTitle: 'This stream cannot be played here', restrictedText: 'The owner limited playback to certain websites or links.',
  notFoundTitle: 'Stream not found', notFoundText: 'This link does not work (any more).', play: 'Play', pause: 'Pause', mute: 'Mute',
  unmute: 'Unmute', fullscreen: 'Full screen', pip: 'Picture in picture', volume: 'Volume', toLive: 'Go to live',
};
document.documentElement.lang = nl ? 'nl' : 'en';
document.title = cfg.title ? `${cfg.title} · ${T.live}` : T.live;

const icon = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  play: icon('<path d="M6 4l14 8-14 8z" fill="currentColor"/>'),
  pause: icon('<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>'),
  vol: icon('<path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/>'),
  muted: icon('<path d="M11 5L6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/>'),
  full: icon('<path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/>'),
  pip: icon('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/>'),
  signal: icon('<path d="M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.4M16.2 7.8a6 6 0 010 8.4"/><circle cx="12" cy="12" r="2"/>'),
  lock: icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="#070A12" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h5M16 5h5M16 12h5M16 19h5M8 12l8-7M8 12h8M8 12l8 7"/></svg>',
};

const root = document.getElementById('player')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function message(kind: 'restricted' | 'not_found') {
  root.innerHTML = `<div class="rp-scan"></div><div class="rp-center"><div class="rp-badge">${I.lock}</div>
    <h1 class="rp-h">${kind === 'restricted' ? T.restrictedTitle : T.notFoundTitle}</h1>
    <p class="rp-p">${kind === 'restricted' ? T.restrictedText : T.notFoundText}</p></div>`;
}

if (cfg.state !== 'ok') {
  message(cfg.state);
} else {
  player();
}

function player() {
  root.innerHTML = `
    <video playsinline ${opt.muted ? 'muted' : ''} hidden></video>
    <div class="rp-scan" data-scan></div>
    <div class="rp-center" data-waiting hidden><div class="rp-badge">${I.signal}</div><h1 class="rp-h">${T.waitingTitle}</h1><p class="rp-p">${T.waitingText}</p></div>
    <div class="rp-center" data-loading><div class="rp-spin"></div></div>
    <div class="rp-center" data-start hidden><button class="rp-play" aria-label="${T.play}">${I.play}</button></div>
    <div class="rp-top"><span class="rp-live" data-badge data-off>${T.offline}</span>${opt.showTitle && cfg.title ? `<span class="rp-title">${esc(cfg.title)}</span>` : ''}</div>
    <div class="rp-bar">
      <button class="rp-btn" data-toggle aria-label="${T.play}">${I.play}</button>
      <button class="rp-btn" data-mute aria-label="${T.mute}">${I.vol}</button>
      <input class="rp-vol" data-vol type="range" min="0" max="1" step="0.05" value="1" aria-label="${T.volume}" />
      <span class="rp-spacer"></span>
      <span class="rp-brand"><span class="rp-mark">${I.mark}</span><span>${esc(cfg.instance)}</span></span>
      ${document.pictureInPictureEnabled ? `<button class="rp-btn" data-pip aria-label="${T.pip}">${I.pip}</button>` : ''}
      <button class="rp-btn" data-full aria-label="${T.fullscreen}">${I.full}</button>
    </div>`;

  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const video = $<HTMLVideoElement>('video');
  const waiting = $<HTMLElement>('[data-waiting]');
  const loading = $<HTMLElement>('[data-loading]');
  const start = $<HTMLElement>('[data-start]');
  const badge = $<HTMLElement>('[data-badge]');
  const toggle = $<HTMLButtonElement>('[data-toggle]');
  const mute = $<HTMLButtonElement>('[data-mute]');
  const vol = $<HTMLInputElement>('[data-vol]');
  const scan = $<HTMLElement>('[data-scan]');

  type View = 'loading' | 'waiting' | 'start' | 'playing';
  function show(v: View) {
    loading.hidden = v !== 'loading';
    waiting.hidden = v !== 'waiting';
    start.hidden = v !== 'start';
    video.hidden = v === 'waiting' || v === 'loading';
    scan.hidden = v === 'playing' || v === 'start';
    const live = v === 'playing' || v === 'start';
    badge.textContent = live ? T.live : T.offline;
    badge.toggleAttribute('data-off', !live);
  }

  const base = new URL(cfg.mediaBase, location.href).toString();
  let hls: Hls | null = null;
  let pc: RTCPeerConnection | null = null;
  let whepSession: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let webrtcFailed = false;

  function teardown() {
    hls?.destroy(); hls = null;
    pc?.close(); pc = null;
    if (whepSession) fetch(whepSession, { method: 'DELETE' }).catch(() => {});
    whepSession = null;
    video.removeAttribute('src');
    video.srcObject = null;
  }

  function later(ms = 5000) {
    teardown();
    show('waiting');
    if (retry) clearTimeout(retry);
    retry = setTimeout(connect, ms);
  }

  async function play() {
    try { await video.play(); show('playing'); } catch { show('start'); }
  }

  /** Is there something to play? MediaMTX answers 404 while the ingest is offline. */
  async function online() {
    try { return (await fetch(`${base}index.m3u8`, { method: 'GET', cache: 'no-store' })).ok; } catch { return false; }
  }

  async function connect() {
    retry = null;
    if (!(await online())) return later();
    if (opt.webrtc && !webrtcFailed && 'RTCPeerConnection' in window) return connectWebrtc();
    connectHls();
  }

  function connectHls() {
    if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, liveSyncDurationCount: 2 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (opt.autoplay) void play(); else show('start'); });
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) later(3000); });
      hls.loadSource(`${base}index.m3u8`);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = `${base}index.m3u8`;
      video.addEventListener('loadedmetadata', () => { if (opt.autoplay) void play(); else show('start'); }, { once: true });
      video.addEventListener('error', () => later(3000), { once: true });
    } else {
      later(10000);
    }
  }

  async function connectWebrtc() {
    try {
      pc = new RTCPeerConnection();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      const ms = new MediaStream();
      pc.ontrack = (e) => { ms.addTrack(e.track); if (video.srcObject !== ms) video.srcObject = ms; };
      pc.onconnectionstatechange = () => {
        if (pc?.connectionState === 'connected') { if (opt.autoplay) void play(); else show('start'); }
        if (pc?.connectionState === 'failed') { webrtcFailed = true; later(500); }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc!.iceGatheringState === 'complete') return resolve();
        pc!.addEventListener('icegatheringstatechange', () => { if (pc?.iceGatheringState === 'complete') resolve(); });
        setTimeout(resolve, 1500);
      });
      const res = await fetch(`${base}whep`, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription!.sdp });
      if (res.status !== 201) throw new Error(`WHEP ${res.status}`);
      const loc = res.headers.get('location');
      whepSession = loc ? new URL(loc, base).toString() : null;
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      // No media within 8 seconds (UDP blocked): fall back to HLS.
      setTimeout(() => { if (pc && pc.connectionState !== 'connected') { webrtcFailed = true; later(100); } }, 8000);
    } catch {
      webrtcFailed = true;
      later(500);
    }
  }

  // Controls
  const syncButtons = () => {
    toggle.innerHTML = video.paused ? I.play : I.pause;
    toggle.setAttribute('aria-label', video.paused ? T.play : T.pause);
    mute.innerHTML = video.muted || video.volume === 0 ? I.muted : I.vol;
    mute.setAttribute('aria-label', video.muted ? T.unmute : T.mute);
    vol.value = video.muted ? '0' : String(video.volume);
  };
  video.addEventListener('play', syncButtons);
  video.addEventListener('pause', syncButtons);
  video.addEventListener('volumechange', syncButtons);
  syncButtons();

  start.querySelector('button')!.addEventListener('click', () => { video.muted = false; void play(); });
  toggle.addEventListener('click', () => {
    if (video.paused) {
      // Back to the live edge after a pause.
      if (hls?.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
      void play();
    } else video.pause();
  });
  mute.addEventListener('click', () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 1; });
  vol.addEventListener('input', () => { video.volume = Number(vol.value); video.muted = video.volume === 0; });
  root.querySelector('[data-pip]')?.addEventListener('click', () => {
    if (document.pictureInPictureElement) void document.exitPictureInPicture(); else void video.requestPictureInPicture().catch(() => {});
  });
  $('[data-full]').addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (root.requestFullscreen) void root.requestFullscreen().catch(() => {});
    else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  });
  video.addEventListener('dblclick', () => $<HTMLButtonElement>('[data-full]').click());
  video.addEventListener('click', () => toggle.click());

  // Hide the controls after a few seconds without movement.
  let idle: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    root.classList.remove('rp-idle');
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (!video.paused) root.classList.add('rp-idle'); }, 3000);
  };
  root.addEventListener('pointermove', wake);
  root.addEventListener('keydown', wake);
  wake();

  // The media token in the URL runs out after a day: reload the page in time for a fresh one.
  if (cfg.reloadAt) setTimeout(() => location.reload(), Math.max(60_000, cfg.reloadAt - Date.now()));

  show('loading');
  void connect();
}
