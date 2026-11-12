import type { ChatMessage } from '../platforms/api.js';

/** Parses one IRC line with IRCv3 tags; returns null for anything that is not a chat message. */
export function parseTwitchLine(line: string): ChatMessage | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=');
      const k = eq === -1 ? kv : kv.slice(0, eq);
      const v = eq === -1 ? '' : kv.slice(eq + 1);
      tags[k] = v.replace(/\\(.)/g, (_m, c: string) => (c === 's' ? ' ' : c === ':' ? ';' : c === 'r' ? '\r' : c === 'n' ? '\n' : c));
    }
    rest = rest.slice(sp + 1);
  }
  const m = /^:([^!\s]+)(?:![^\s]*)? PRIVMSG #\S+ :(.*)$/.exec(rest);
  if (!m) return null;
  let text = m[2];
  // /me messages arrive as CTCP ACTION.
  const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
  if (action) text = action[1];
  const ts = Number(tags['tmi-sent-ts']);
  const bits = Number(tags.bits);
  return {
    id: tags.id || `${m[1]}:${ts || Date.now()}:${text.slice(0, 20)}`,
    author: (tags['display-name'] || m[1]).slice(0, 100),
    text: text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000),
    at: new Date(Number.isFinite(ts) && ts > 0 ? ts : Date.now()),
    highlight: bits > 0 ? `${bits} bits` : null,
  };
}

/**
 * Reads a Twitch channel's chat anonymously (IRC over WebSocket, "justinfan" login).
 * Reconnects with backoff until stopped.
 */
export class TwitchChat {
  state: 'connecting' | 'on' | 'error' = 'connecting';
  error: string | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private url: string, private channel: string, private onMessage: (m: ChatMessage) => void) {
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${this.channel.toLowerCase()}`);
    };
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        if (/ JOIN #/.test(line) || / 366 /.test(line)) { this.state = 'on'; this.error = null; this.attempts = 0; continue; }
        if (/ RECONNECT/.test(line)) { ws.close(); continue; }
        if (/ NOTICE \* :Login/.test(line)) { this.error = line.slice(0, 200); continue; }
        const msg = parseTwitchLine(line);
        if (msg && msg.text) this.onMessage(msg);
      }
    };
    ws.onerror = () => { this.error = this.error ?? `cannot reach ${new URL(this.url).host}`; };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped) this.fail(this.error ?? 'connection closed');
    };
  }

  private fail(message: string) {
    this.state = 'error';
    this.error = message;
    this.attempts++;
    const delay = Math.min(60, 2 ** Math.min(this.attempts, 6)) * 1000;
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
  }
}
