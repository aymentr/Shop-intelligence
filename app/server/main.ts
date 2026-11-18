/**
 * DEMO-V1 entry point: (re)creates the disposable demo database, seeds the synthetic dataset through the existing
 * mechanisms, and serves the local interface on 127.0.0.1.
 *
 * Environment (normally set by demo/app.sh, which also starts and removes a disposable PostgreSQL 16.15 container):
 *   SI_APP_PGHOST          loopback only (default 127.0.0.1)
 *   SI_APP_PGPORT          PostgreSQL port (required)
 *   SI_APP_ADMIN_USER      cluster superuser used ONLY for setup (default si_bootstrap)
 *   SI_APP_ADMIN_PASSWORD  its password (required)
 *   SI_APP_DB              demo database name (default si_demo_v1); it is DROPPED and recreated on every start
 *   SI_APP_PORT            HTTP port on 127.0.0.1 (default 4173)
 * Role passwords are random per start and never printed. SYNTHETIC DATA ONLY.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from './server.js';
import { DemoService } from './service.js';
import { prepareDatabase, seedDemo, type RolePasswords } from './seed.js';

const env = process.env;
const host = env.SI_APP_PGHOST ?? '127.0.0.1';
const port = Number(env.SI_APP_PGPORT);
const httpPort = Number(env.SI_APP_PORT ?? 4173);
const database = env.SI_APP_DB ?? 'si_demo_v1';
const admin = { user: env.SI_APP_ADMIN_USER ?? 'si_bootstrap', password: env.SI_APP_ADMIN_PASSWORD ?? '' };

if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || !admin.password || !Number.isInteger(httpPort)) {
  console.error('DEMO_REFUSED: set SI_APP_PGPORT and SI_APP_ADMIN_PASSWORD for a loopback, disposable PostgreSQL (or use: npm run app)');
  process.exit(2);
}
const pw = (): string => randomBytes(18).toString('hex');
const passwords: RolePasswords = { collector: pw(), rightsAdmin: pw(), monitor: pw(), analyst: pw(), migrator: pw() };
const db = { host, port, database };

const t0 = performance.now();
const applied = await prepareDatabase(db, admin, passwords);
console.log(`setup: database ${database} recreated, migrations ${applied[0]}-${applied[applied.length - 1]} applied`);
const seeded = await seedDemo(db, admin, passwords);
const byOutcome = seeded.runs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] ?? 0) + 1 }), {});
console.log(`seed: ${seeded.runs.length} runs (${Object.entries(byOutcome).map(([k, v]) => `${v} ${k}`).join(', ')}), ${seeded.verified} receipts verified, ` +
            `${Math.round(performance.now() - t0)} ms`);

const service = new DemoService({ db, passwords });
const { server } = createServer({ port: httpPort, service, log: line => console.log(line) });
server.on('listening', () => {
  const a = server.address() as { port: number };
  console.log(`\nShop Intelligence DEMO-V1 (SYNTHETIC DATA) — open http://127.0.0.1:${a.port}/\nPress Ctrl+C to stop.`);
});
const stop = () => { server.close(); void service.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
