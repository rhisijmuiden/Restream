/**
 * Reads FFmpeg's framecrc output (see probeArgs): one line per video frame, e.g.
 *   0,      -1024,          0,      512,     5064, 0x7e276d26
 *   0,       -512,       1536,      512,     2133, 0x944f373a, F=0x0
 * (stream, dts, pts, duration, size, checksum[, flags]). A line without "F=" is a key frame.
 * The header gives the time base: "#tb 0: 1/90000".
 */
export interface FrameWindow {
  /** Frames since the previous take(). */
  frames: number;
  /** Video bytes since the previous take(). */
  bytes: number;
  /** The last complete key-frame interval in seconds (null until two key frames were seen). */
  keyframeSeconds: number | null;
  /** Frames whose decoding time stamp did not move forward, since the previous take(). */
  timestampErrors: number;
}

const NOPTS = -9223372036854775808;

export class FrameStats {
  private buf = '';
  private tb = 1 / 90000;
  private frames = 0;
  private bytes = 0;
  private tsErrors = 0;
  private lastDts: number | null = null;
  private lastKeyPts: number | null = null;
  private keyInterval: number | null = null;

  push(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.line(line);
    }
    if (this.buf.length > 8192) this.buf = '';
  }

  private line(l: string) {
    if (l.startsWith('#')) {
      const m = /^#tb 0:\s*(\d+)\/(\d+)/.exec(l);
      if (m && Number(m[2]) > 0) this.tb = Number(m[1]) / Number(m[2]);
      return;
    }
    const f = l.split(',').map((x) => x.trim());
    if (f.length < 6 || f[0] !== '0') return;
    const dts = Number(f[1]); const pts = Number(f[2]); const size = Number(f[4]);
    if (!Number.isFinite(size)) return;
    this.frames++;
    this.bytes += size;
    if (Number.isFinite(dts) && dts !== NOPTS) {
      if (this.lastDts !== null && dts <= this.lastDts) this.tsErrors++;
      this.lastDts = dts;
    }
    const key = !f.some((x) => x.startsWith('F='));
    if (key && Number.isFinite(pts) && pts !== NOPTS) {
      if (this.lastKeyPts !== null && pts > this.lastKeyPts) this.keyInterval = Math.round((pts - this.lastKeyPts) * this.tb * 100) / 100;
      this.lastKeyPts = pts;
    }
  }

  take(): FrameWindow {
    const w = { frames: this.frames, bytes: this.bytes, keyframeSeconds: this.keyInterval, timestampErrors: this.tsErrors };
    this.frames = 0; this.bytes = 0; this.tsErrors = 0;
    return w;
  }
}

/** The common frame rate closest to a measured one (49.7 → 50), or null when nothing was measured. */
export function nominalFps(samples: number[]): number | null {
  const valid = samples.filter((v) => v > 1);
  if (valid.length < 3) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  const best = common.reduce((a, b) => (Math.abs(b - median) < Math.abs(a - median) ? b : a));
  return Math.abs(best - median) / best < 0.08 ? best : Math.round(median);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
