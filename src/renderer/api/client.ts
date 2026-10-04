import type { ApiArgs, ApiMethod, ApiResult, EventMap, EventTopic, RpcResponse } from '../../core/ipc/contract';
import type { SerializedError } from '../../core/errors';

/**
 * Renderer-side API client. The same typed contract runs over either transport:
 *  - Electron: window.iotosBridge from the sandboxed preload (IPC)
 *  - Browser host: HTTP POST /api/rpc + Server-Sent Events (/api/events)
 */

interface Bridge {
  call(method: string, args: unknown): Promise<RpcResponse<unknown>>;
  onEvent(cb: (topic: string, payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    iotosBridge?: Bridge;
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(e: SerializedError) {
    super(e.message);
    this.code = e.code;
    this.hint = e.hint;
    this.details = e.details;
  }
}

function readToken(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const fromHash = hash.get('token');
  if (fromHash) {
    try {
      sessionStorage.setItem('iotos-token', fromHash);
    } catch {
      /* storage unavailable */
    }
    // Remove the token from the visible URL.
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return fromHash;
  }
  try {
    return sessionStorage.getItem('iotos-token');
  } catch {
    return null;
  }
}

function createHttpBridge(): Bridge {
  const token = readToken();
  return {
    async call(method, args) {
      const res = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-iotos-token': token ?? '' },
        body: JSON.stringify({ method, args: args ?? null }),
      });
      if (res.status === 401) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Not authorised: open IoT-OS using the URL printed by `npm run host`.' } };
      if (!res.ok) return { ok: false, error: { code: 'INTERNAL', message: `Host returned HTTP ${res.status}` } };
      return (await res.json()) as RpcResponse<unknown>;
    },
    onEvent(cb) {
      const es = new EventSource(`/api/events?token=${encodeURIComponent(token ?? '')}`);
      es.onmessage = (ev: MessageEvent<string>) => {
        const msg = JSON.parse(ev.data) as { topic: string; payload: unknown };
        cb(msg.topic, msg.payload);
      };
      return () => es.close();
    },
  };
}

const bridge: Bridge = window.iotosBridge ?? createHttpBridge();
export const transport: 'electron' | 'browser-host' = window.iotosBridge ? 'electron' : 'browser-host';

export async function call<K extends ApiMethod>(method: K, ...args: ApiArgs<K> extends void ? [] : [ApiArgs<K>]): Promise<ApiResult<K>> {
  const r = await bridge.call(method, args[0]);
  if (!r.ok) throw new ApiError(r.error);
  return r.result as ApiResult<K>;
}

type Listener = (payload: never) => void;
const listeners = new Map<string, Set<Listener>>();
bridge.onEvent((topic, payload) => {
  for (const fn of listeners.get(topic) ?? []) {
    try {
      (fn as (p: unknown) => void)(payload);
    } catch (err) {
      console.error(`event handler for ${topic} failed`, err);
    }
  }
});

export function onEvent<K extends EventTopic>(topic: K, fn: (payload: EventMap[K]) => void): () => void {
  const set = listeners.get(topic) ?? new Set<Listener>();
  set.add(fn as Listener);
  listeners.set(topic, set);
  return () => set.delete(fn as Listener);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.hint ? `${err.message} — ${err.hint}` : err.message;
  return err instanceof Error ? err.message : String(err);
}
