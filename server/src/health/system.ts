import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';

/**
 * Server figures read from /proc (Linux). Every reader returns null where the figure is not available
 * (another OS, a container without /proc), so the health page shows "—" instead of failing.
 */

interface CpuTimes { idle: number; total: number }

function readCpuTimes(): CpuTimes | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal (guest time is already part of user).
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  } catch {
    return null;
  }
}

interface NetBytes { rx: number; tx: number }

/** Bytes received and sent on all interfaces except loopback (the local RTSP readers would count double). */
function readNetBytes(): NetBytes | null {
  try {
    const lines = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0; let tx = 0; let seen = false;
    for (const l of lines) {
      const [name, rest] = l.split(':');
      if (!rest || !name) continue;
      const iface = name.trim();
      if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth')) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] ?? 0; tx += f[8] ?? 0; seen = true;
    }
    return seen ? { rx, tx } : null;
  } catch {
    return null;
  }
}

function readMemory(): { totalBytes: number; usedBytes: number } | null {
  try {
    const m = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => {
      const [k, v] = l.split(':');
      return [k?.trim(), Number.parseInt(v ?? '0', 10) * 1024];
    }));
    const total = m.MemTotal; const avail = m.MemAvailable;
    if (!total || avail === undefined) return null;
    return { totalBytes: total, usedBytes: total - avail };
  } catch {
    const total = os.totalmem();
    return total ? { totalBytes: total, usedBytes: total - os.freemem() } : null;
  }
}

/** CPU time (user + system) of a process in clock ticks, or null when it is gone. */
function readProcTicks(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is in parentheses and may contain spaces: count fields after the last ")".
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return null;
  }
}

/** Linux uses 100 ticks per second on every common architecture. */
const TICKS = 100;

export interface ServerSample {
  at: number;
  /** Whole machine, 0-100 across all cores. */
  cpuPercent: number | null;
  cores: number;
  memory: { totalBytes: number; usedBytes: number } | null;
  /** Network traffic of the machine, in kbit/s. */
  uploadKbps: number | null;
  downloadKbps: number | null;
  disk: { totalBytes: number; freeBytes: number } | null;
  load1: number;
}

/** Samples the server; rates are computed against the previous call. */
export class SystemSampler {
  private cpu: CpuTimes | null = null;
  private net: (NetBytes & { at: number }) | null = null;
  private procs = new Map<number, { ticks: number; at: number }>();

  constructor(private diskPath: string) {}

  sample(now = Date.now()): ServerSample {
    const cpu = readCpuTimes();
    let cpuPercent: number | null = null;
    if (cpu && this.cpu && cpu.total > this.cpu.total) {
      cpuPercent = Math.round((1 - (cpu.idle - this.cpu.idle) / (cpu.total - this.cpu.total)) * 1000) / 10;
    }
    this.cpu = cpu;

    const net = readNetBytes();
    let up: number | null = null; let down: number | null = null;
    if (net && this.net && now > this.net.at && net.tx >= this.net.tx && net.rx >= this.net.rx) {
      up = Math.round(((net.tx - this.net.tx) * 8) / (now - this.net.at));
      down = Math.round(((net.rx - this.net.rx) * 8) / (now - this.net.at));
    }
    this.net = net ? { ...net, at: now } : null;

    let disk: ServerSample['disk'] = null;
    try {
      const fs = statfsSync(this.diskPath);
      disk = { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
    } catch { /* data dir not there yet */ }

    return {
      at: now, cpuPercent: cpuPercent === null ? null : Math.max(0, Math.min(100, cpuPercent)), cores: os.cpus().length || 1,
      memory: readMemory(), uploadKbps: up, downloadKbps: down, disk, load1: Math.round(os.loadavg()[0]! * 100) / 100,
    };
  }

  /**
   * CPU use of a process since the previous call, as a percentage of one core (200 = two full cores).
   * Null on the first call for a pid or when the process is gone.
   */
  processCpu(pid: number | undefined, now = Date.now()): number | null {
    if (!pid) return null;
    const ticks = readProcTicks(pid);
    const prev = this.procs.get(pid);
    if (ticks === null) { this.procs.delete(pid); return null; }
    this.procs.set(pid, { ticks, at: now });
    if (!prev || now <= prev.at || ticks < prev.ticks) return null;
    return Math.round((((ticks - prev.ticks) / TICKS) / ((now - prev.at) / 1000)) * 1000) / 10;
  }

  /** Forgets processes that are no longer sampled. */
  keepOnly(pids: Set<number>) {
    for (const pid of [...this.procs.keys()]) if (!pids.has(pid)) this.procs.delete(pid);
  }
}
