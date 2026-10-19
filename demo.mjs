import { readFileSync } from 'node:fs';
import { FixtureAdapter, ingestOffline, diagnostics } from './dist/index.js';
const data=JSON.parse(readFileSync(new URL('./fixtures/synthetic-ads.json',import.meta.url),'utf8'));
const adapter=new FixtureAdapter('synthetic-fixture',['META','TIKTOK'],data);
const rights={sourceId:'synthetic-fixture',basis:'Author-created fictional sample data, offline test only',evaluation:'ALLOWED',retain:'UNKNOWN',subscriber_display:'DENIED',media_mirror:'DENIED',export:'DENIED'};
const result=await ingestOffline(adapter,rights,'B001-demo','2026-10-19T00:00:00Z');
console.log(JSON.stringify({run:result.run,diagnostics:diagnostics(result),ids:result.ads.map(a=>a.identityKey)},null,2));
