/**
 * DEMO-V1 — minimal local HTTP layer (node:http, no framework). Loopback only.
 *
 * Security posture (local synthetic demonstration, not a deployment):
 *   - binds 127.0.0.1; requests whose Host is not the loopback origin are refused (DNS-rebinding guard);
 *   - database credentials never leave this process; responses are JSON results and fixed error codes only;
 *   - every input is validated here and again by the library and the database (parameterized calls only);
 *   - state-changing requests (POST) need JSON, a same-origin Origin when present, and the per-process CSRF token
 *     that is embedded in the page;
 *   - strict CSP (no inline script), nosniff, no framing, no referrer, no caching of API responses.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Period } from '../../dist/persistence/intelligence.js';
import { AppError, DemoService, toAppError } from './service.js';

export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const NETWORKS = new Set(['GOOGLE', 'META', 'OTHER', 'PINTEREST', 'TIKTOK']);
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

const STATIC: Record<string, [string, string]> = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8']
};

function list(v: string | null, max: number, re?: RegExp, allowed?: Set<string>): string[] | undefined {
  if (v === null || v === '') return undefined;
  const items = v.split(',');
  if (items.length > max || !items.every(x => (re ? re.test(x) : true) && (allowed ? allowed.has(x) : true))) throw new AppError(400, 'BAD_ARGUMENT');
  return items;
}
/** Inclusive calendar-day range in UTC -> the library's half-open period [from 00:00, to + 1 day 00:00). */
function period(from: string | null, to: string | null): Period | undefined {
  if (!from && !to) return undefined;
  if (!from || !to || !DATE.test(from) || !DATE.test(to)) throw new AppError(400, 'BAD_ARGUMENT');
  const f = new Date(`${from}T00:00:00.000Z`), t = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY);
  if (!Number.isFinite(f.getTime()) || !Number.isFinite(t.getTime()) || f >= t || t.getTime() - f.getTime() > 366 * DAY ||
      f.toISOString().slice(0, 10) !== from) throw new AppError(400, 'BAD_ARGUMENT');
  return { from: f, to: t };
}
function text(v: string | null, max: number): string {
  if (v === null || v.length < 1 || v.length > max) throw new AppError(400, 'BAD_ARGUMENT');
  return v;
}

export interface ServerOptions { port: number; host?: string; service: DemoService; log?: (line: string) => void }

export function createServer(opts: ServerOptions): { server: http.Server; csrfToken: string } {
  const csrfToken = randomBytes(24).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  const html = readFileSync(`${PUBLIC_DIR}index.html`, 'utf8').replace('__CSRF_TOKEN__', csrfToken);
  const svc = opts.service;
  const log = opts.log ?? (() => {});

  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    let status = 200, code = '';
    const send = (s: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
      status = s;
      res.writeHead(s, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra });
      res.end(body);
    };
    const json = (s: number, v: unknown) => send(s, JSON.stringify(v), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
    try {
      const port = (server.address() as { port: number }).port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!req.headers.host || !allowedHosts.has(req.headers.host)) throw new AppError(421, 'HOST_NOT_ALLOWED');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const p = url.pathname, q = url.searchParams;

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p] as [string, string];
        return send(200, readFileSync(`${PUBLIC_DIR}${file}`), type, { 'Cache-Control': 'no-cache' } as Record<string, string>);
      }
      if (req.method === 'GET' && p === '/api/health') return json(200, { ok: true, data: 'SYNTHETIC' });
      if (req.method === 'GET' && p === '/api/overview') return json(200, await svc.overview());
      if (req.method === 'GET' && p === '/api/sources') {
        const cat = await svc.catalog();
        const out = [];
        for (const s of cat) out.push({ ...s, access: await svc.access(s.sourceId) });
        return json(200, { sources: out });
      }
      if (req.method === 'GET' && p === '/api/search') {
        const limit = q.get('limit') === null ? 20 : Number(q.get('limit'));
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, 'BAD_ARGUMENT');
        const cursor = q.get('cursor');
        if (cursor !== null && (cursor.length < 1 || cursor.length > 200000)) throw new AppError(400, 'BAD_ARGUMENT');
        const sources = list(q.get('sources'), 10, SOURCE_ID), networks = list(q.get('networks'), 5, undefined, NETWORKS), per = period(q.get('from'), q.get('to'));
        return json(200, await svc.search({ query: text(q.get('q'), 300), cursor, limit,
          ...(sources ? { sources } : {}), ...(networks ? { networks } : {}), ...(per ? { period: per } : {}) }));
      }
      if (req.method === 'GET' && p === '/api/advertiser') {
        const source = text(q.get('source'), 63);
        if (!SOURCE_ID.test(source)) throw new AppError(400, 'BAD_ARGUMENT');
        const networks = list(q.get('networks'), 5, undefined, NETWORKS), per = period(q.get('from'), q.get('to'));
        return json(200, await svc.advertiser(source, text(q.get('name'), 1000), { ...(networks ? { networks } : {}), ...(per ? { period: per } : {}) }));
      }
      if (req.method === 'GET' && p === '/api/operations') return json(200, await svc.operations());

      if (req.method === 'POST' && p.startsWith('/api/ops/')) {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) throw new AppError(403, 'ORIGIN_NOT_ALLOWED');
        if (req.headers['x-si-csrf'] !== csrfToken) throw new AppError(403, 'CSRF_REQUIRED');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new AppError(415, 'JSON_REQUIRED');
        const body = await readJson(req, 4096);
        if (p === '/api/ops/collect') return json(200, await svc.collect(text(str(body.sourceId), 63), text(str(body.scenarioId), 40)));
        if (p === '/api/ops/verify') return json(200, await svc.verify());
        if (p === '/api/ops/control') return json(200, await svc.control(text(str(body.sourceId), 63), text(str(body.kind), 10), text(str(body.reason), 200)));
      }
      throw new AppError(404, 'NOT_FOUND');
    } catch (e) {
      const err = toAppError(e);
      code = err.code;
      if (err.code === 'INTERNAL') log(`internal error: ${(e as Error)?.name ?? 'unknown'}`);
      json(err.status, { error: { code: err.code, sourceId: err.detail.sourceId ?? null, reasons: err.detail.reasons ?? [] } });
    } finally {
      log(`${req.method} ${(req.url ?? '').split('?')[0]} ${status}${code ? ` ${code}` : ''} ${Math.round(performance.now() - t0)}ms`);
    }
  });
  server.listen(opts.port, host);
  return { server, csrfToken };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readJson(req: http.IncomingMessage, max: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new AppError(413, 'BODY_TOO_LARGE')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
        resolve(v as Record<string, unknown>);
      } catch { reject(new AppError(400, 'BAD_JSON')); }
    });
    req.on('error', () => reject(new AppError(400, 'BAD_JSON')));
  });
}
