// Shop Intelligence DEMO-V1 — client. Plain ES module, no framework, no inline script (strict CSP).
// Every number on screen comes from the local API, which calls the existing database functions. Nothing is computed
// here beyond formatting, client-side paging of an already-returned history, and grouping for display.
const CSRF = document.querySelector('meta[name="si-csrf"]').content;
const main = document.getElementById('main');
const NETWORKS = ['GOOGLE', 'META', 'OTHER', 'PINTEREST', 'TIKTOK'];
const ACTIVITY_NOTE = 'Observed advertising activity only. The evidence contains no sales, revenue, spend, reach, impressions or conversions, and none is inferred.';
const ABSENCE_NOTE = 'An advertisement that is no longer observed has not necessarily stopped running: absence of observations proves nothing.';

// ------------------------------------------------------------------ helpers
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTs = v => (v ? `${v.slice(0, 10)} ${v.slice(11, 16)} UTC` : '—');
const fmtDate = v => (v ? v.slice(0, 10) : '—');
const fmtNum = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
const short = v => (v ? `${String(v).slice(0, 8)}…` : '—');
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

const ERROR_TEXT = {
  SOURCE_UNAVAILABLE: 'The source is not readable right now.',
  NOT_AUTHORIZED: 'The analyst principal is not granted this source.',
  NOT_GRANTED: 'The analyst principal is not granted this source.',
  BAD_ARGUMENT: 'The request was rejected as invalid.',
  BAD_CURSOR: 'The page cursor no longer matches this search. Start the search again.',
  AVAILABILITY_CHANGED: 'A source changed availability between pages. Start again for a consistent result.',
  RESULT_CHANGED: 'The evidence changed while it was being read. Reload for a consistent result.',
  SCAN_LIMIT: 'The result is larger than the bounded read allows.',
  RESOURCE_LIMIT: 'The database refused the request at its resource limit.',
  IDENTITY_CONFLICT: 'The advertiser key is ambiguous in this source; the database refused the page.',
  CSRF_REQUIRED: 'This action needs the page token. Reload the page.',
  INTERNAL: 'An internal error occurred. Nothing was shown in its place.'
};
const REASON_TEXT = { SUSPENDED: 'suspended by a source control', TERMINATED: 'rights terminated', RETIRED: 'source retired',
  RIGHTS_RESTRICTED: 'rights do not allow evaluation', RETENTION_RESTRICTED: 'retention does not allow reads', NOT_SYNTHETIC: 'not synthetic', UNAVAILABLE: 'unavailable' };

class ApiError extends Error { constructor(status, body) { super(body?.error?.code ?? `HTTP_${status}`); this.status = status; this.info = body?.error ?? {}; } }
async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SI-CSRF': CSRF }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
function errorBox(e, context = '') {
  const code = e instanceof ApiError ? e.message : 'NETWORK';
  const reasons = e?.info?.reasons?.length ? ` (${e.info.reasons.map(r => REASON_TEXT[r] ?? r).join(', ')})` : '';
  return `<div class="callout bad error-box" role="alert"><strong>${esc(context || 'Request failed')}:</strong> ${esc(ERROR_TEXT[code] ?? 'The request failed.')}${esc(reasons)}
    <div class="small muted">Code <code>${esc(code)}</code>${e?.info?.sourceId ? ` · source <code>${esc(e.info.sourceId)}</code>` : ''}</div></div>`;
}
function accessBadge(a) {
  if (!a) return '<span class="badge">unknown</span>';
  if (a.state === 'AVAILABLE') return '<span class="badge ok">Available</span>';
  if (a.state === 'NOT_GRANTED') return '<span class="badge">Not granted</span>';
  return `<span class="badge bad" title="${esc(a.reasons.join(', '))}">Unavailable · ${esc(a.reasons.map(r => r.toLowerCase()).join(', '))}</span>`;
}
function statusBadge(status, outcome) {
  const cls = status === 'COMPLETED' ? 'ok' : status === 'FAILED' || status === 'REJECTED' ? 'bad' : status === 'RUNNING' ? 'warn' : '';
  return `<span class="badge ${cls}">${esc(status)}</span>${outcome ? ` <code class="small">${esc(outcome)}</code>` : ''}`;
}
const netBadges = list => `<span class="badges">${(list ?? []).map(n => `<span class="badge info">${esc(n)}</span>`).join('')}</span>`;
const kpi = (label, value, hint = '', cls = '') => `<div class="kpi"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
const pageHead = (title, sub, right = '') => `<div class="page-head"><div><h1>${esc(title)}</h1><p>${sub}</p></div>${right}</div>`;
const setMain = html => { main.innerHTML = html; };
function setNav(name) { document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name)); }

// ------------------------------------------------------------------ router
const routes = { overview: viewOverview, explorer: viewExplorer, advertiser: viewAdvertiser, operations: viewOperations };
let renderSeq = 0;
async function route() {
  const [path, query] = (location.hash.replace(/^#\/?/, '') || 'overview').split('?');
  const name = routes[path] ? path : 'overview';
  setNav(name === 'advertiser' ? 'explorer' : name);
  const seq = ++renderSeq;
  setMain('<div class="loading">Loading…</div>');
  try { await routes[name](new URLSearchParams(query ?? ''), () => seq === renderSeq); }
  catch (e) { if (seq === renderSeq) setMain(errorBox(e, 'This view could not be loaded')); }
  if (seq === renderSeq) main.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ A. overview
async function viewOverview(_p, current) {
  const d = await api('/api/overview');
  if (!current()) return;
  const t = d.totals;
  const sourceRows = d.sources.map(s => {
    const e = s.evidence, st = s.status;
    const verified = st ? `${fmtNum(st.runsVerifiedValid)} valid${st.runsVerificationPending ? ` · ${st.runsVerificationPending} pending` : ''}${st.runsVerifiedUnverifiable ? ` · ${st.runsVerifiedUnverifiable} unverifiable` : ''}` : '—';
    return `<tr>
      <td><strong>${esc(s.displayName)}</strong><div class="small muted"><code>${esc(s.sourceId)}</code></div></td>
      <td>${netBadges(s.networks)}</td>
      <td>${accessBadge(s.access)}${s.error ? `<div class="small muted">${esc(s.error)}</div>` : ''}</td>
      <td class="num">${e ? fmtNum(e.advertisers) : '—'}</td><td class="num">${e ? fmtNum(e.distinctAds) : '—'}</td>
      <td class="num">${e ? fmtNum(e.observations) : '—'}</td>
      <td class="small">${esc(verified)}</td>
      <td class="nowrap small">${st ? fmtTs(st.latestSuccessfulCollectionAt) : '—'}</td></tr>`;
  }).join('');
  const runRows = d.recentRuns.map(r => `<tr><td class="nowrap small">${fmtTs(r.finishedAt ?? r.startedAt)}</td><td><code class="small">${esc(r.sourceId)}</code></td>
    <td>${statusBadge(r.status, r.outcomeCode)}</td><td class="num">${fmtNum(r.counts.published)}</td><td class="num">${fmtNum(r.counts.duplicate)}</td></tr>`).join('');
  const ctlRows = d.recentControls.length ? d.recentControls.map(c => `<tr><td class="nowrap small">${fmtTs(c.occurredAt)}</td><td><code class="small">${esc(c.sourceId)}</code></td>
    <td><span class="badge ${c.kind === 'SUSPEND' ? 'bad' : 'ok'}">${esc(c.kind)}</span></td><td class="small">${esc(c.reason)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted small">No source control has been recorded.</td></tr>';
  setMain(`
    ${pageHead('Overview', 'What the analyst principal can read right now, per source, plus the collection and publication record behind it.',
      `<button id="refresh">Refresh</button>`)}
    <div class="callout info">${esc(ACTIVITY_NOTE)}</div>
    <div class="kpis" data-u="mt16">
      ${kpi('Advertisers discovered', fmtNum(t.advertiserIdentities), 'identities, counted per source')}
      ${kpi('Distinct advertisements', fmtNum(t.distinctAds), 'network + native ad id, per source')}
      ${kpi('Available evidence', fmtNum(t.readableObservations), 'readable observations')}
      ${kpi('Published runs', fmtNum(t.runs.published), `${fmtNum(t.runs.completed)} completed · ${fmtNum(t.runs.failed)} failed`)}
      ${kpi('Sources available', `${fmtNum(t.sourcesAvailable)} / ${fmtNum(t.sources)}`, 'readable by the analyst now')}
    </div>
    <div class="card"><h2>Sources</h2><div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Networks</th><th>Analyst access</th><th class="num">Advertisers</th><th class="num">Ads</th><th class="num">Observations</th><th>Verified runs (30 days)</th><th>Last collection</th></tr></thead>
      <tbody>${sourceRows}</tbody></table></div>
      <p class="small muted">Counts come from the evidence the database releases to the analyst (si_read_evidence, audited pages) and from the content-free source status (si_read_source_status). Unavailable or ungranted sources show no counts: the database releases nothing for them.</p></div>
    <div class="grid two">
      <div class="card"><h2>Recent collection runs</h2><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Source</th><th>Status</th><th class="num">Published</th><th class="num">Duplicates</th></tr></thead><tbody>${runRows}</tbody></table></div>
        <p class="small"><a href="#/operations">Open collection &amp; publication →</a></p></div>
      <div class="card"><h2>Recent source controls</h2><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Source</th><th>Control</th><th>Reason</th></tr></thead><tbody>${ctlRows}</tbody></table></div></div>
    </div>`);
  document.getElementById('refresh').onclick = route;
}

// ------------------------------------------------------------------ B. explorer
let sourceCache = null;
async function getSources(force = false) { if (!sourceCache || force) sourceCache = (await api('/api/sources')).sources; return sourceCache; }

async function viewExplorer(p, current) {
  const sources = await getSources(true);
  if (!current()) return;
  const sel = new Set((p.get('sources') ?? '').split(',').filter(Boolean));
  const nets = new Set((p.get('networks') ?? '').split(',').filter(Boolean));
  const q = p.get('q') ?? '';
  setMain(`
    ${pageHead('Advertiser explorer', 'Search advertisers by name across the sources the analyst may read. Results are computed by the database (summary-backed search), one authorized and audited request per source and page; identities are never merged across sources.')}
    <div class="card">
      <form class="filters" id="search-form" autocomplete="off">
        <label class="field"><span>Advertiser name contains</span><input type="search" name="q" maxlength="300" required placeholder="e.g. northwind, foods, synthetic" value="${esc(q)}"></label>
        <label class="field"><span>Collected from</span><input type="date" name="from" value="${esc(p.get('from') ?? '')}"></label>
        <label class="field"><span>Collected to</span><input type="date" name="to" value="${esc(p.get('to') ?? '')}"></label>
        <button class="primary" type="submit">Search</button>
      </form>
      <div class="filters-extra">
        <div class="field"><span>Sources (none selected = every readable source)</span><div class="checks" id="src-checks">
          ${sources.map(s => `<label class="${s.access.state === 'AVAILABLE' ? '' : 'disabled'}"><input type="checkbox" value="${esc(s.sourceId)}" ${sel.has(s.sourceId) ? 'checked' : ''}>
            ${esc(s.displayName)} ${s.access.state === 'AVAILABLE' ? '' : accessBadge(s.access)}</label>`).join('')}</div></div>
        <div class="field"><span>Networks (none selected = all)</span><div class="checks" id="net-checks">
          ${NETWORKS.map(n => `<label><input type="checkbox" value="${n}" ${nets.has(n) ? 'checked' : ''}> ${n}</label>`).join('')}</div></div>
      </div>
      <p class="small muted" data-u="mt10">Matching is on the normalized name (Unicode NFKC, case-folded, whitespace collapsed). The date range filters by collection time (when the run was published), not by the source-reported dates.</p>
    </div>
    <div class="card" id="results">${q ? '<div class="loading">Searching…</div>' : `<div class="empty"><strong>Start with a name</strong>Try
      ${['northwind', 'foods', 'synthetic', 'aurora'].map(x => `<a href="#/explorer?${qs({ q: x })}" class="chip badge info">${x}</a>`).join(' ')}</div>`}</div>`);
  document.getElementById('search-form').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const srcs = [...document.querySelectorAll('#src-checks input:checked')].map(i => i.value);
    const ns = [...document.querySelectorAll('#net-checks input:checked')].map(i => i.value);
    location.hash = `#/explorer?${qs({ q: f.get('q').trim(), from: f.get('from'), to: f.get('to'), sources: srcs.join(','), networks: ns.join(',') })}`;
  };
  if (q) await runSearch(p, current, []);
}

async function runSearch(p, current, history, cursor = null, sources = null) {
  const box = document.getElementById('results');
  const params = { q: p.get('q'), from: p.get('from'), to: p.get('to'), networks: p.get('networks'), limit: 10,
                   sources: cursor ? sources.join(',') : p.get('sources'), cursor };
  if ((params.from && !params.to) || (!params.from && params.to)) { box.innerHTML = '<div class="callout warn">Choose both dates, or neither.</div>'; return; }
  box.innerHTML = '<div class="loading">Searching…</div>';
  let r;
  try { r = await api(`/api/search?${qs(params)}`); } catch (e) { if (current()) box.innerHTML = errorBox(e, 'Search refused'); return; }
  if (!current()) return;
  const excluded = r.excluded?.length ? `<div class="callout warn">Not searched: ${r.excluded.map(x => `<code>${esc(x.sourceId)}</code> (${esc(x.state === 'NOT_GRANTED' ? 'not granted to the analyst' : x.reasons.map(v => REASON_TEXT[v] ?? v).join(', '))})`).join(', ')}</div>` : '';
  const rows = r.hits.map(h => `<tr class="clickable" data-source="${esc(h.sourceId)}" data-name="${esc(h.names[0] ?? h.normalizedName)}">
      <td><strong>${esc(h.names[0] ?? h.normalizedName)}</strong>${h.names.length > 1 ? `<div class="small muted">+${h.names.length - 1} spelling(s)</div>` : ''}<div class="small muted mono">${esc(h.normalizedName)}</div></td>
      <td><code class="small">${esc(h.sourceId)}</code></td><td>${netBadges(h.networks)}</td>
      <td class="num">${fmtNum(h.distinctAds)}</td><td class="num">${fmtNum(h.observations)}</td><td class="num">${fmtNum(h.runsWithEvidence)}</td>
      <td class="nowrap small">${fmtTs(h.firstObservedAt)}</td><td class="nowrap small">${fmtTs(h.lastObservedAt)}</td></tr>`).join('');
  const page = history.length + 1;
  box.innerHTML = `${excluded}
    ${r.hits.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Advertiser</th><th>Source</th><th>Networks</th><th class="num">Distinct ads</th><th class="num">Observations</th><th class="num">Runs</th><th>First observed</th><th>Last observed</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : `<div class="empty"><strong>No advertisers match</strong>Nothing readable in the searched sources matches this name${p.get('from') ? ' in this collection period' : ''}.</div>`}
    <div class="pager"><span class="small muted">Page ${page} · ${r.sources.length} source(s) searched · ${r.scannedPages} audited request(s)</span><span class="spacer"></span>
      <button id="prev" ${history.length ? '' : 'disabled'}>← Previous</button><button id="next" ${r.nextCursor ? '' : 'disabled'}>Next →</button></div>
    <p class="small muted">"First/last observed" are collection times of verified evidence. Distinct ads are counted as distinct advertisements, not summed per run.</p>`;
  box.querySelectorAll('tr.clickable').forEach(tr => { tr.onclick = () => { location.hash = `#/advertiser?${qs({ source: tr.dataset.source, name: tr.dataset.name, from: p.get('from'), to: p.get('to'), networks: p.get('networks') })}`; }; });
  document.getElementById('next').onclick = () => runSearch(p, current, [...history, cursor], r.nextCursor, r.sources);
  document.getElementById('prev').onclick = () => { const h = [...history]; const c = h.pop(); runSearch(p, current, h, c, c ? r.sources : null); };
}

// ------------------------------------------------------------------ C/D. advertiser detail and evidence history
async function viewAdvertiser(p, current) {
  const source = p.get('source'), name = p.get('name');
  let d;
  try { d = await api(`/api/advertiser?${qs({ source, name, from: p.get('from'), to: p.get('to'), networks: p.get('networks') })}`); }
  catch (e) {
    if (!current()) return;
    setMain(`${pageHead(name ?? 'Advertiser', `Source <code>${esc(source)}</code>`)}${errorBox(e, 'The history was refused')}
      <p><a href="#/explorer">← Back to the explorer</a></p>`);
    return;
  }
  if (!current()) return;
  const h = d.history, st = d.sourceStatus;
  const back = `<a href="#/explorer?${qs({ q: name, from: p.get('from'), to: p.get('to'), networks: p.get('networks') })}">← Back to results</a>`;
  const empty = h.observations.length === 0;
  const adRows = d.ads.map(a => `<tr><td>${netBadges([a.network])}</td><td><code class="small">${esc(a.nativeAdId)}</code></td><td>${esc(a.title ?? '—')}</td>
      <td class="num">${fmtNum(a.observations)}</td><td class="nowrap small">${fmtTs(a.firstCollectedAt)} → ${fmtTs(a.lastCollectedAt)}</td>
      <td class="nowrap small">${fmtDate(a.firstSeenAt)} → ${fmtDate(a.lastSeenAt)}</td><td class="url">${esc(a.sourceUrl)}</td></tr>`).join('');
  setMain(`
    ${pageHead(h.advertiser.names[0] ?? h.advertiser.normalizedName,
      `Source <code>${esc(h.sourceId)}</code> · identity <code>${esc(h.advertiser.normalizedName)}</code>${h.advertiser.names.length > 1 ? ` · spellings: ${h.advertiser.names.map(esc).join(', ')}` : ''}`, back)}
    <div class="callout info">${esc(ACTIVITY_NOTE)}</div>
    <div class="kpis" data-u="mt16">
      ${kpi('Distinct advertisements', fmtNum(h.distinctAds))}
      ${kpi('Observations', fmtNum(h.observations.length))}
      ${kpi('Runs with evidence', fmtNum(h.runsWithEvidence))}
      ${kpi('First observed (collected)', fmtTs(h.firstObservedAt), '', 'date')}
      ${kpi('Last observed (collected)', fmtTs(h.lastObservedAt), '', 'date')}
      ${kpi('Source-reported seen', `${fmtDate(h.sourceReportedFirstSeen)} → ${fmtDate(h.sourceReportedLastSeen)}`, 'source-reported dates (else the observation time); not verified', 'date')}
    </div>
    <div class="callout" data-u="mt12"><strong>End of activity: unknown.</strong> ${esc(ABSENCE_NOTE)}</div>
    ${empty ? '<div class="card"><div class="empty"><strong>No readable evidence</strong>Nothing matches these filters in this source.</div></div>' : `
    <div class="card"><h2>Activity timeline</h2>${timeline(h.observations)}
      <p class="small muted">Each row is one advertisement; each dot is one observation at its source-reported time (seen at). Collection times are listed in the history below.</p></div>
    <div class="card"><h2>Advertisements (${fmtNum(d.ads.length)})</h2><div class="table-wrap"><table>
      <thead><tr><th>Network</th><th>Ad id</th><th>Title</th><th class="num">Obs.</th><th>Collected (first → last)</th><th>Source-reported seen</th><th>Source URL (not fetched)</th></tr></thead>
      <tbody>${adRows}</tbody></table></div></div>
    <div class="card" id="history"></div>`}
    <div class="grid two" data-u="mt16">
      <div class="card"><h2>Provenance</h2><dl class="kv">
        <dt>Read by</dt><dd>analyst principal, via <code>si_advertiser_history</code> (one audited request per page)</dd>
        <dt>Availability</dt><dd>${esc(h.availability.state)} · checked ${fmtTs(h.availability.checkedFrom)}</dd>
        <dt>Networks</dt><dd>${netBadges(h.networks)}</dd>
        <dt>Verification</dt><dd>Only runs with a VALID receipt verdict are readable; every observation shown is from such a run.</dd>
        <dt>Identity</dt><dd>Normalized name within this one source. The same name in another source is a separate identity.</dd></dl></div>
      <div class="card"><h2>Source verification (${fmtDate(st.period.from)} → ${fmtDate(st.period.to)})</h2><dl class="kv">
        <dt>Runs with evidence</dt><dd>${fmtNum(st.runsWithEvidence)}</dd><dt>Verified VALID</dt><dd>${fmtNum(st.runsVerifiedValid)}</dd>
        <dt>Pending verification</dt><dd>${fmtNum(st.runsVerificationPending)}</dd><dt>Unverifiable / invalid</dt><dd>${fmtNum(st.runsVerifiedUnverifiable)} / ${fmtNum(st.runsVerifiedInvalid)}</dd>
        <dt>Latest verified evidence</dt><dd>${fmtTs(st.latestVerifiedEvidenceAt)}</dd></dl>
        <p class="small muted">Content-free status from <code>si_read_source_status</code>.</p></div>
    </div>`);
  if (!empty) renderHistory(h.observations, 0);
}

const HISTORY_PAGE = 25;
function renderHistory(obs, page) {
  const box = document.getElementById('history');
  const sorted = [...obs].sort((a, b) => (b.collectedAt.localeCompare(a.collectedAt)) || (a.ordinal - b.ordinal));
  const pages = Math.max(1, Math.ceil(sorted.length / HISTORY_PAGE));
  const slice = sorted.slice(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE);
  box.innerHTML = `<h2>Evidence history (${fmtNum(obs.length)} observations)</h2><div class="table-wrap"><table>
    <thead><tr><th>Collected</th><th>Run · ordinal</th><th>Network</th><th>Ad id</th><th>Title</th><th>Seen at (source)</th><th>Content SHA-256</th><th>Verdict</th><th>Source URL</th></tr></thead>
    <tbody>${slice.map(o => `<tr><td class="nowrap small">${fmtTs(o.collectedAt)}</td><td class="nowrap"><code class="small" title="${esc(o.runId)}">${esc(short(o.runId))}</code> · ${o.ordinal}</td>
      <td>${netBadges([o.network])}</td><td><code class="small">${esc(o.nativeAdId)}</code></td><td>${esc(o.title ?? '—')}</td>
      <td class="nowrap small">${fmtTs(o.seenAt)}</td><td><code class="small" title="${esc(o.contentSha256)}">${esc(short(o.contentSha256))}</code></td>
      <td><span class="badge ok">${esc(o.verification)}</span></td><td class="url">${esc(o.sourceUrl)}</td></tr>`).join('')}</tbody></table></div>
    <div class="pager"><span class="small muted">Page ${page + 1} of ${pages}. The database returned this history in keyset pages of at most 100 (bounded at 5,000 observations); the list is paged here for reading.</span><span class="spacer"></span>
      <button id="hprev" ${page ? '' : 'disabled'}>← Newer</button><button id="hnext" ${page + 1 < pages ? '' : 'disabled'}>Older →</button></div>`;
  document.getElementById('hprev').onclick = () => renderHistory(obs, page - 1);
  document.getElementById('hnext').onclick = () => renderHistory(obs, page + 1);
}

function timeline(obs) {
  const byAd = new Map();
  for (const o of obs) { const k = `${o.network} · ${o.nativeAdId}`; if (!byAd.has(k)) byAd.set(k, []); byAd.get(k).push(Date.parse(o.seenAt)); }
  const all = obs.map(o => Date.parse(o.seenAt));
  let min = Math.min(...all), max = Math.max(...all);
  if (max - min < 86400000) { min -= 43200000; max += 43200000; }
  const L = 150, R = 16, W = 760, rowH = 24, top = 8, H = top + byAd.size * rowH + 26;
  const x = t => L + ((t - min) / (max - min)) * (W - L - R);
  const rows = [...byAd.entries()].map(([k, ts], i) => {
    const y = top + i * rowH + rowH / 2;
    return `<text x="0" y="${y + 3}">${esc(k)}</text>
      ${ts.length > 1 ? `<line class="bar" x1="${x(Math.min(...ts))}" x2="${x(Math.max(...ts))}" y1="${y}" y2="${y}"/>` : ''}
      ${ts.map(t => `<circle class="dot" cx="${x(t)}" cy="${y}" r="4"><title>${esc(new Date(t).toISOString().slice(0, 16).replace('T', ' '))} UTC</title></circle>`).join('')}`;
  }).join('');
  const ticks = [0, .25, .5, .75, 1].map(f => { const t = min + f * (max - min); return `<text x="${x(t)}" y="${H - 6}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${new Date(t).toISOString().slice(0, 10)}</text>`; }).join('');
  return `<svg class="timeline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Observation timeline by advertisement">
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - 20}" y2="${H - 20}"/>${rows}${ticks}</svg>`;
}

// ------------------------------------------------------------------ E. collection and publication
let lastAction = null;
async function viewOperations(_p, current) {
  const d = await api('/api/operations');
  const sources = await getSources(true);
  if (!current()) return;
  const v = d.verification;
  const srcOptions = d.sources.map(s => `<option value="${esc(s.sourceId)}">${esc(s.displayName)} (${esc(s.networks.join(', '))})</option>`).join('');
  const scnOptions = d.scenarios.map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
  const ctlRows = sources.map(s => `<tr><td><strong>${esc(s.displayName)}</strong><div class="small muted"><code>${esc(s.sourceId)}</code></div></td>
      <td>${accessBadge(s.access)}</td><td>${s.lastControl ? `<span class="badge ${s.lastControl === 'SUSPEND' ? 'bad' : 'ok'}">${esc(s.lastControl)}</span>` : '<span class="muted small">none</span>'}</td>
      <td class="nowrap"><button class="danger" data-ctl="SUSPEND" data-src="${esc(s.sourceId)}">Suspend</button> <button data-ctl="LIFT" data-src="${esc(s.sourceId)}">Lift</button></td></tr>`).join('');
  const runRows = d.runs.map(r => `<tr><td class="nowrap small">${fmtTs(r.startedAt)}</td><td><code class="small">${esc(r.sourceId)}</code></td>
      <td><code class="small" title="${esc(r.runId)}">${esc(short(r.runId))}</code></td><td>${statusBadge(r.status, r.outcomeCode)}</td><td><span class="badge">${esc(r.retentionState)}</span></td>
      <td class="num">${fmtNum(r.counts.received)}</td><td class="num">${fmtNum(r.counts.published)}</td><td class="num">${fmtNum(r.counts.duplicate)}</td><td class="num">${fmtNum(r.counts.errors)}</td>
      <td class="nowrap small">${r.receiptAt ? fmtTs(r.receiptAt) : '—'}</td></tr>`).join('');
  setMain(`
    ${pageHead('Collection & publication', 'Run a synthetic collection through the real pipeline (T1 preflight → T2 validation and publication → receipt), verify receipts, and apply source controls. Every state shown is read back from the database after the action.', '<button id="refresh">Refresh</button>')}
    <div class="callout warn">Operator actions run against the local disposable database with the existing roles (collector, monitor, rights administrator). The scenarios are a fixed synthetic catalog; the browser never sends evidence.</div>
    <div class="grid two" data-u="mt16">
      <div class="card"><h2>1 · Collect and publish</h2>
        <div class="grid" data-u="cols2">
          <label class="field"><span>Source</span><select id="op-source">${srcOptions}</select></label>
          <label class="field"><span>Scenario</span><select id="op-scenario">${scnOptions}</select></label></div>
        <p class="small muted" id="op-desc"></p>
        <div class="row"><button class="primary" id="op-run">Run collection</button><button id="op-verify">2 · Verify receipts</button></div>
        <div id="op-result" data-u="mt12"></div></div>
      <div class="card"><h2>Receipt verification</h2>
        <div class="kpis">${kpi('Pending', fmtNum(v.pending))}${kpi('Valid', fmtNum(v.valid))}${kpi('Unverifiable', fmtNum(v.unverifiable))}${kpi('Invalid', fmtNum(v.invalid))}</div>
        <p class="small muted">From <code>si_verification_status</code> (monitor). Evidence becomes readable only after its run's receipt is verified VALID.</p></div>
    </div>
    <div class="card"><h2>3 · Source controls</h2>
      <div class="row" data-u="mb10"><label class="field" data-u="flex1"><span>Reason (recorded with the control)</span>
        <input type="text" id="ctl-reason" maxlength="200" value="Demo: operational safety check"></label></div>
      <div class="table-wrap"><table><thead><tr><th>Source</th><th>Analyst access now</th><th>Latest control</th><th></th></tr></thead><tbody>${ctlRows}</tbody></table></div>
      <div id="ctl-result" data-u="mt10"></div>
      <p class="small muted">Controls are recorded by <code>si_record_source_control</code> (rights administrator). LIFT uses the compare-and-set check of the current rights version and control sequence.</p></div>
    <div class="card"><h2>Collection runs (latest 50)</h2><div class="table-wrap"><table>
      <thead><tr><th>Started</th><th>Source</th><th>Run</th><th>Status</th><th>Retention</th><th class="num">Received</th><th class="num">Published</th><th class="num">Dupl.</th><th class="num">Errors</th><th>Receipt</th></tr></thead>
      <tbody>${runRows}</tbody></table></div></div>`);
  const desc = () => { const s = d.scenarios.find(x => x.id === document.getElementById('op-scenario').value); document.getElementById('op-desc').textContent = s?.description ?? ''; };
  document.getElementById('op-scenario').onchange = desc; desc();
  document.getElementById('refresh').onclick = route;
  if (lastAction) document.getElementById(lastAction.box).innerHTML = lastAction.html;
  lastAction = null;
  document.getElementById('op-run').onclick = async ev => {
    const btn = ev.target; btn.disabled = true;
    const box = document.getElementById('op-result'); box.innerHTML = '<div class="loading">Running T1 → T2…</div>';
    try {
      const r = await api('/api/ops/collect', { sourceId: document.getElementById('op-source').value, scenarioId: document.getElementById('op-scenario').value });
      lastAction = { box: 'op-result', html: collectResult(r) };
    } catch (e) { lastAction = { box: 'op-result', html: errorBox(e, 'Collection request failed') }; }
    route();
  };
  document.getElementById('op-verify').onclick = async ev => {
    ev.target.disabled = true;
    try {
      const r = await api('/api/ops/verify', {});
      lastAction = { box: 'op-result', html: `<div class="callout ok"><strong>Verification batch: ${r.result.outcome}.</strong> ${r.result.verified} receipt(s) verified — ${r.result.valid} valid, ${r.result.unverifiable} unverifiable, ${r.result.invalid} invalid. Pending now: ${r.status.pending}.</div>
        <p class="small"><a href="#/explorer?${qs({ q: 'aurora' })}">Search for “aurora” →</a></p>` };
    } catch (e) { lastAction = { box: 'op-result', html: errorBox(e, 'Verification failed') }; }
    route();
  };
  document.querySelectorAll('[data-ctl]').forEach(b => { b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api('/api/ops/control', { sourceId: b.dataset.src, kind: b.dataset.ctl, reason: document.getElementById('ctl-reason').value });
      lastAction = { box: 'ctl-result', html: `<div class="callout ${r.control.kind === 'SUSPEND' ? 'warn' : 'ok'}"><strong>${esc(r.control.kind)} recorded</strong> for <code>${esc(r.control.sourceId)}</code> (control #${r.control.controlSeq}, ${fmtTs(r.control.occurredAt)}, by <code>${esc(r.control.recordedBy)}</code>).
        Analyst access is now ${accessBadge(r.access)}. ${r.access.state === 'AVAILABLE' ? '' : 'Search, history and the overview now refuse this source with its reason; nothing is shown in its place.'}</div>` };
    } catch (e) { lastAction = { box: 'ctl-result', html: errorBox(e, `${b.dataset.ctl} refused by the database`) }; }
    route();
  }; });
}

function collectResult(r) {
  const run = r.run;
  const ok = r.outcome === 'COMPLETED';
  const t1ok = run && run.status !== 'REJECTED';
  const steps = [
    ['T1 preflight', t1ok ? 'done' : 'failed', t1ok ? `run ${short(run.runId)} started` : run ? `rejected: ${run.outcomeCode}` : `refused: ${r.code}`],
    ['T2 validate + publish', ok ? 'done' : t1ok ? 'failed' : '', ok ? `${r.published} published` : t1ok ? `${run.status} ${run.outcomeCode ?? ''}` : 'not reached'],
    ['Receipt', run?.receiptAt ? 'done' : ok ? 'pending' : '', run?.receiptAt ? fmtTs(run.receiptAt) : ok && r.published === 0 ? 'empty run: nothing to verify' : 'none'],
    ['Verification', ok && r.published > 0 ? 'pending' : '', ok && r.published > 0 ? 'run “Verify receipts”' : 'not applicable']
  ];
  const diag = r.diagnostics ? `<div class="small">Database diagnostics: ${r.diagnostics.errorCount} error(s) — ${r.diagnostics.errors.map(e => `<code>${esc(e.code ?? e.c ?? JSON.stringify(e))}</code>${e.field ? ` on <code>${esc(e.field)}</code>` : ''}${e.rowIndex !== undefined && e.rowIndex !== null ? ` (row ${esc(e.rowIndex)})` : ''}`).join(', ')}</div>` : '';
  return `<div class="callout ${ok ? 'ok' : 'bad'}"><strong>${ok ? (r.published ? 'Published' : 'Completed: nothing found (EMPTY)') : r.outcome === 'REFUSED' ? 'Refused before a run was created' : r.outcome === 'REJECTED' ? 'Run rejected at preflight (recorded)' : 'Publication refused by the database'}</strong>
      ${run ? ` — persisted state: ${statusBadge(run.status, run.outcomeCode)} · received ${run.counts.received}, published ${run.counts.published}, duplicates ${run.counts.duplicate}` : ` — code <code>${esc(r.code)}</code>`}${diag}</div>
    <div class="steps">${steps.map(([t, s, d]) => `<div class="step ${s}"><b>${esc(t)}</b>${esc(d)}</div>`).join('')}</div>`;
}

route();
