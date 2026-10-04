import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, relative } from 'node:path';
import type { Api } from '../api';
import type { Services } from '../services';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_BODY = 10 * 1024 * 1024;

/**
 * Browser host: serves the IoT-OS UI and the same API as the Electron IPC
 * bridge over localhost HTTP (+ Server-Sent Events for push events). Used for
 * development, automated E2E tests, and running without the Electron binary.
 *
 * Security: binds to 127.0.0.1 only; every API request needs the per-run random
 * token; Host and Origin headers are checked to block DNS rebinding and
 * cross-site requests; static files are confined to the renderer build folder.
 */
export async function startHostServer(opts: { services: Services; api: Api; staticDir: string | null; port?: number; token?: string }): Promise<{ url: string; token: string; port: number; server: Server; close: () => Promise<void> }> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const clients = new Set<ServerResponse>();
  let port = 0;

  const validHost = (req: IncomingMessage) => {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };
  const validToken = (t: string | null | undefined) => {
    if (!t) return false;
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };

  const unsubscribe = opts.services.bus.onAny((topic, payload) => {
    const data = `event: message\ndata: ${JSON.stringify({ topic, payload })}\n\n`;
    for (const c of clients) c.write(data);
  });

  const server = createServer((req, res) => {
    void (async () => {
      if (!validHost(req)) return send(res, 421, '{"error":"invalid host"}');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (url.pathname === '/api/rpc') {
        if (req.method !== 'POST') return send(res, 405, '{"error":"method not allowed"}');
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, '{"error":"origin"}');
        if (!validToken(req.headers['x-iotos-token'] as string | undefined)) return send(res, 401, '{"error":"unauthorized"}');
        let raw = '';
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) return send(res, 413, '{"error":"too large"}');
          raw += chunk;
        }
        let msg: { method?: unknown; args?: unknown };
        try {
          msg = JSON.parse(raw) as { method?: unknown; args?: unknown };
        } catch {
          return send(res, 400, '{"error":"invalid json"}');
        }
        if (typeof msg.method !== 'string') return send(res, 400, '{"error":"method required"}');
        const result = await opts.api.call(msg.method, msg.args);
        return send(res, 200, JSON.stringify(result));
      }

      if (url.pathname === '/api/events') {
        if (!validToken(url.searchParams.get('token'))) return send(res, 401, '{"error":"unauthorized"}');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (!opts.staticDir) return send(res, 404, 'Not found', 'text/plain');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      const relPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const abs = normalize(join(opts.staticDir, relPath));
      const rel = relative(opts.staticDir, abs);
      if (rel.startsWith('..') || rel.includes('\0')) return send(res, 403, 'Forbidden', 'text/plain');
      const st = await stat(abs).catch(() => null);
      const file = st?.isFile() ? abs : join(opts.staticDir, 'index.html');
      const body = await readFile(file).catch(() => null);
      if (!body) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    })().catch((err: unknown) => {
      opts.services.logger.scope('host').error('request failed', { error: err });
      if (!res.headersSent) send(res, 500, '{"error":"internal"}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    token,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribe();
        for (const c of clients) c.end();
        server.close(() => resolve());
      }),
  };
}
