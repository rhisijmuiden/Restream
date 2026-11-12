import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from '../db.js';
import { bus } from '../lib/events.js';

/** Scheduled events that were never started are closed this long after their (planned) end. */
const MISSED_AFTER_MS = 6 * 3600_000;

/**
 * Starts and stops scheduled events on time: at the start the event's destinations go live (and recording
 * starts when asked), at the end they stop. Registration on the platforms is done by the Provisioner.
 */
export class EventScheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  onChange: () => void = () => {};

  constructor(private sql: Sql, private log: FastifyBaseLogger) {}

  start(intervalMs = 5000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM events
        WHERE status = 'scheduled' AND auto_start AND starts_at <= ${now}
          AND COALESCE(ends_at, starts_at + interval '6 hours') > ${now}`;
      for (const e of due) {
        this.log.info({ event: e.id, title: e.title }, 'starting scheduled event');
        await this.startEvent(e.id);
      }
      const ending = await this.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM events WHERE status = 'live' AND auto_stop AND ends_at IS NOT NULL AND ends_at <= ${now}`;
      for (const e of ending) {
        this.log.info({ event: e.id, title: e.title }, 'ending scheduled event');
        await this.stopEvent(e.id);
      }
      await this.sql`
        UPDATE events SET status = 'ended', updated_at = now()
        WHERE status = 'scheduled' AND COALESCE(ends_at, starts_at) < ${new Date(now.getTime() - MISSED_AFTER_MS)}`;
    } catch (err) {
      this.log.error({ err }, 'event scheduler failed');
    } finally {
      this.busy = false;
    }
  }

  /** Puts the event's destinations live (they wait for the ingest when it is not there yet). */
  async startEvent(id: string): Promise<boolean> {
    const changed = await this.sql.begin(async (tx) => {
      const [e] = await tx<{ id: string; stream_id: string; record: boolean; title: string }[]>`
        UPDATE events SET status = 'live', started_at = now(), updated_at = now() WHERE id = ${id} AND status = 'scheduled'
        RETURNING id, stream_id, record, title`;
      if (!e) return false;
      bus.publish('event.started', { event: { id: e.id, title: e.title }, stream: { id: e.stream_id } });
      await tx`
        UPDATE destinations SET live = true, live_since = COALESCE(live_since, now()), updated_at = now()
        WHERE id IN (SELECT destination_id FROM event_targets WHERE event_id = ${id} AND status <> 'removed') AND NOT live`;
      if (e.record) await tx`UPDATE streams SET record = true, record_event = ${id} WHERE id = ${e.stream_id}`;
      return true;
    });
    if (changed) this.onChange();
    return changed;
  }

  /** Stops the event's destinations and the recording it started. */
  async stopEvent(id: string): Promise<boolean> {
    const changed = await this.sql.begin(async (tx) => {
      const [e] = await tx<{ stream_id: string; title: string }[]>`
        UPDATE events SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = ${id} AND status = 'live' RETURNING stream_id, title`;
      if (!e) return false;
      bus.publish('event.ended', { event: { id, title: e.title }, stream: { id: e.stream_id } });
      await tx`
        UPDATE destinations SET live = false, live_since = NULL, updated_at = now()
        WHERE id IN (SELECT destination_id FROM event_targets WHERE event_id = ${id}) AND live`;
      await tx`UPDATE streams SET record = false, record_event = NULL WHERE id = ${e.stream_id} AND record_event = ${id}`;
      return true;
    });
    if (changed) this.onChange();
    return changed;
  }
}
