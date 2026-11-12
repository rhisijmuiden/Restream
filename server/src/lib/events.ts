import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** Events other projects can subscribe to with a webhook. */
export const webhookEvents = [
  'stream.ingest.started', 'stream.ingest.stopped', 'stream.source.changed',
  'output.live', 'output.reconnecting', 'output.stopped',
  'broadcast.started', 'broadcast.ended',
  'recording.started', 'recording.finished',
  'event.started', 'event.ended',
  'backup.finished',
] as const;
export type WebhookEvent = (typeof webhookEvents)[number] | 'ping';

export interface BusEvent {
  id: string;
  type: WebhookEvent;
  createdAt: string;
  data: Record<string, unknown>;
}

/**
 * In-process event bus: the media supervisor, live monitor, scheduler and backups publish here,
 * the webhook dispatcher turns every event into deliveries.
 */
class Bus extends EventEmitter {
  publish(type: WebhookEvent, data: Record<string, unknown>): BusEvent {
    const ev: BusEvent = { id: randomUUID(), type, createdAt: new Date().toISOString(), data };
    this.emit('event', ev);
    return ev;
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
