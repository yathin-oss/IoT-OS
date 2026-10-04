import { EventEmitter } from 'node:events';
import type { EventMap } from '../core/ipc/contract';

/**
 * Typed in-process event bus. Services publish; transports (Electron IPC, the
 * HTTP/SSE host) forward every event to the UI.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof EventMap>(topic: K, payload: EventMap[K]): void {
    this.emitter.emit(topic, payload);
    this.emitter.emit('*', topic, payload);
  }

  on<K extends keyof EventMap>(topic: K, fn: (payload: EventMap[K]) => void): () => void {
    this.emitter.on(topic, fn as (p: unknown) => void);
    return () => this.emitter.off(topic, fn as (p: unknown) => void);
  }

  onAny(fn: (topic: keyof EventMap, payload: unknown) => void): () => void {
    this.emitter.on('*', fn);
    return () => this.emitter.off('*', fn);
  }
}
