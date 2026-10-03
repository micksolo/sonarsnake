// Fold analytics events into shard documents and summarize them.
// Live events update agg:<shard>. Older blobs that were stored before rollup
// are folded once into leg:<shard>. Same-client sets are unioned at read time
// so a player is not counted twice across those two documents.

const CAP = {
  clients: 20000,
  sessions: 20000,
  gaps: 4000,
  sessionRuns: 20000,
  sessionMs: 20000,
  dayClients: 8000,
  seen: 5000,
  names: 48
};

const NUMS = [
  'events', 'loads', 'touch', 'runs', 'runsEnded', 'scoreSum', 'maxScore', 'secondsSum',
  'pingsSum', 'emptyPingsSum', 'firstFoodCount', 'firstFoodSum', 'noFoodRuns',
  'lbOpens', 'lbSubmits', 'mutes', 'abandons', 'abandonsDuringRun', 'levelUps',
  'adBefore', 'adAfter', 'adBreaks', 'adRewards', 'sessionStarts', 'versionT',
  'clientN', 'sessionN', 'sessionRunN', 'sessionMsN'
];

const BOOLS = [
  'clientOverflow', 'sessionOverflow', 'sessionRunOverflow', 'sessionMsOverflow',
  'gapsTruncated', 'dayClientOverflow'
];

const MAPS = [
  'clients', 'sessions', 'byForm', 'byPointer', 'abandonByLocation', 'levelUpByLevel',
  'deathCause', 'levelFunnel', 'deathCells', 'adBreakStatus', 'sessionRuns', 'sessionMs',
  'names', 'seen'
];

const KNOWN = new Set([
  'load', 'run_start', 'run_end', 'level_up', 'lb_open', 'lb_submit', 'mute', 'abandon',
  'session_start', 'session_ping', 'session_end', 'before_ad', 'after_ad', 'ad_break_done', 'ad_reward'
]);

function safeKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 200
    && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bump(map, key) {
  if (!safeKey(key)) return;
  map[key] = (map[key] || 0) + 1;
}

function copyMap(dest, src) {
  if (!src || typeof src !== 'object') return;
  for (const k of Object.keys(src)) {
    if (!safeKey(k)) continue;
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) dest[k] = v;
    else if (v) dest[k] = 1;
  }
}

function dayOf(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function emptyAgg() {
  const agg = { v: 1, gaps: [], gameVersion: null, byDay: Object.create(null) };
  for (const k of NUMS) agg[k] = 0;
  for (const k of BOOLS) agg[k] = false;
  for (const k of MAPS) agg[k] = Object.create(null);
  return agg;
}

function normalizeDays(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const day of Object.keys(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const src = raw[day] || {};
    const clients = Object.create(null);
    copyMap(clients, src.clients);
    out[day] = {
      events: num(src.events),
      clients,
      clientN: Object.keys(clients).length
    };
  }
  return out;
}

export function normalizeAgg(raw) {
  const agg = emptyAgg();
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return agg;
  for (const k of NUMS) if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) agg[k] = raw[k];
  for (const k of BOOLS) if (raw[k] === true) agg[k] = true;
  if (typeof raw.gameVersion === 'string') agg.gameVersion = raw.gameVersion.slice(0, 16);
  if (Array.isArray(raw.gaps)) {
    agg.gaps = raw.gaps.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0).slice(0, CAP.gaps);
  }
  for (const k of MAPS) copyMap(agg[k], raw[k]);
  agg.byDay = normalizeDays(raw.byDay);
  agg.clientN = Object.keys(agg.clients).length;
  agg.sessionN = Object.keys(agg.sessions).length;
  agg.sessionRunN = Object.keys(agg.sessionRuns).length;
  agg.sessionMsN = Object.keys(agg.sessionMs).length;
  return agg;
}

export function normalizeMeta(raw) {
  const meta = { cursor: '', done: false, epoch: 0 };
  if (!raw || typeof raw !== 'object') return meta;
  if (typeof raw.cursor === 'string') meta.cursor = raw.cursor.slice(0, 200);
  if (raw.done === true) meta.done = true;
  if (typeof raw.epoch === 'number' && Number.isFinite(raw.epoch)) meta.epoch = raw.epoch;
  return meta;
}

function remember(map, countField, overflowField, id, cap, agg) {
  if (!id || !safeKey(id) || map[id]) return;
  if (agg[countField] >= cap) {
    agg[overflowField] = true;
    return;
  }
  map[id] = 1;
  agg[countField]++;
}

function noteSession(agg, sid, ms) {
  if (!sid || !safeKey(sid) || typeof ms !== 'number' || !Number.isFinite(ms)) return;
  const clamped = Math.max(0, Math.min(ms, 24 * 60 * 60 * 1000));
  const prev = agg.sessionMs[sid];
  if (prev == null) {
    if (agg.sessionMsN >= CAP.sessionMs) {
      agg.sessionMsOverflow = true;
      return;
    }
    agg.sessionMs[sid] = clamped;
    agg.sessionMsN++;
    return;
  }
  if (clamped > prev) agg.sessionMs[sid] = clamped;
}

function noteName(agg, name) {
  if (!safeKey(name)) return;
  if (agg.names[name]) {
    agg.names[name]++;
    return;
  }
  if (Object.keys(agg.names).length >= CAP.names && !KNOWN.has(name)) {
    agg.names.other = (agg.names.other || 0) + 1;
    return;
  }
  agg.names[name] = 1;
}

export function applyEvent(agg, ev) {
  if (!ev || typeof ev !== 'object') return;
  const p = ev.props && typeof ev.props === 'object' ? ev.props : {};
  const name = typeof ev.name === 'string' ? ev.name : '';
  agg.events++;
  noteName(agg, name);
  remember(agg.clients, 'clientN', 'clientOverflow', ev.clientId, CAP.clients, agg);
  remember(agg.sessions, 'sessionN', 'sessionOverflow', ev.sessionId, CAP.sessions, agg);
  if (ev.version && (!agg.versionT || num(ev.t) >= agg.versionT)) {
    agg.gameVersion = String(ev.version).slice(0, 16);
    agg.versionT = num(ev.t);
  }
  const day = dayOf(ev.t);
  if (day) {
    if (!agg.byDay[day]) agg.byDay[day] = { events: 0, clients: Object.create(null), clientN: 0 };
    const bucket = agg.byDay[day];
    bucket.events++;
    if (ev.clientId && safeKey(ev.clientId) && !bucket.clients[ev.clientId]) {
      if (bucket.clientN >= CAP.dayClients) agg.dayClientOverflow = true;
      else {
        bucket.clients[ev.clientId] = 1;
        bucket.clientN++;
      }
    }
  }
  switch (name) {
    case 'load': {
      agg.loads++;
      if (p.touch) agg.touch++;
      const form = p.form === 'phone' || p.form === 'tablet' || p.form === 'desktop' ? p.form : 'unknown';
      bump(agg.byForm, form);
      let pointer = p.pointer;
      if (pointer !== 'coarse' && pointer !== 'fine' && pointer !== 'both' && pointer !== 'none') {
        pointer = p.touch == null ? 'unknown' : (p.touch ? 'coarse' : 'fine');
      }
      bump(agg.byPointer, pointer);
      break;
    }
    case 'run_start': {
      agg.runs++;
      const sid = ev.sessionId;
      if (sid && safeKey(sid)) {
        if (!agg.sessionRuns[sid] && agg.sessionRunN >= CAP.sessionRuns) agg.sessionRunOverflow = true;
        else {
          if (!agg.sessionRuns[sid]) agg.sessionRunN++;
          agg.sessionRuns[sid] = (agg.sessionRuns[sid] || 0) + 1;
        }
      }
      if (typeof p.gapMs === 'number' && p.gapMs >= 0 && p.gapMs < 7 * 86400000) {
        if (agg.gaps.length < CAP.gaps) agg.gaps.push(p.gapMs);
        else agg.gapsTruncated = true;
      }
      break;
    }
    case 'run_end': {
      agg.runsEnded++;
      const score = num(p.score);
      agg.scoreSum += score;
      if (score > agg.maxScore) agg.maxScore = score;
      agg.secondsSum += num(p.seconds);
      bump(agg.deathCause, String(p.cause || '?').slice(0, 24));
      bump(agg.levelFunnel, String(Math.round(num(p.level)) || 1));
      agg.pingsSum += num(p.pingsUsed);
      agg.emptyPingsSum += num(p.emptyPings);
      if (p.firstFoodMs != null) {
        agg.firstFoodCount++;
        agg.firstFoodSum += num(p.firstFoodMs);
      } else agg.noFoodRuns++;
      if (p.deathX != null && p.deathY != null && Number.isFinite(Number(p.deathX)) && Number.isFinite(Number(p.deathY))) {
        bump(agg.deathCells, Math.round(Number(p.deathX)) + ',' + Math.round(Number(p.deathY)));
      }
      break;
    }
    case 'level_up': {
      agg.levelUps++;
      const lv = Math.round(num(p.level));
      if (lv > 0 && lv < 500) bump(agg.levelUpByLevel, String(lv));
      break;
    }
    case 'lb_open': agg.lbOpens++; break;
    case 'lb_submit': agg.lbSubmits++; break;
    case 'mute': agg.mutes++; break;
    case 'abandon': {
      agg.abandons++;
      const loc = typeof p.location === 'string' && p.location ? p.location.slice(0, 16) : 'playing';
      bump(agg.abandonByLocation, loc);
      if (loc === 'playing') agg.abandonsDuringRun++;
      noteSession(agg, ev.sessionId, p.durationMs);
      break;
    }
    case 'session_start': agg.sessionStarts++; break;
    case 'session_ping':
    case 'session_end':
      noteSession(agg, ev.sessionId, p.durationMs);
      break;
    case 'before_ad': agg.adBefore++; break;
    case 'after_ad': agg.adAfter++; break;
    case 'ad_reward': agg.adRewards++; break;
    case 'ad_break_done': {
      agg.adBreaks++;
      const st = typeof p.breakStatus === 'string' && p.breakStatus ? p.breakStatus.slice(0, 32) : 'unknown';
      bump(agg.adBreakStatus, st);
      break;
    }
    default: break;
  }
}

function mergeAdd(into, src) {
  for (const k of Object.keys(src || {})) {
    if (!safeKey(k)) continue;
    into[k] = (into[k] || 0) + num(src[k]);
  }
}

function mergeMax(into, src) {
  for (const k of Object.keys(src || {})) {
    if (!safeKey(k)) continue;
    const v = num(src[k]);
    into[k] = into[k] == null ? v : Math.max(into[k], v);
  }
}

function mergeSet(into, src) {
  for (const k of Object.keys(src || {})) {
    if (!safeKey(k)) continue;
    into[k] = 1;
  }
}

function avg(sum, n) {
  return n ? Math.round((sum / n) * 10) / 10 : 0;
}

export function summarize(shards, opts = {}) {
  const clients = Object.create(null);
  const sessions = Object.create(null);
  const sessionRuns = Object.create(null);
  const sessionMs = Object.create(null);
  const byDay = Object.create(null);
  const maps = {
    byForm: Object.create(null),
    byPointer: Object.create(null),
    abandonByLocation: Object.create(null),
    levelUpByLevel: Object.create(null),
    deathCause: Object.create(null),
    levelFunnel: Object.create(null),
    deathCells: Object.create(null),
    adBreakStatus: Object.create(null),
    names: Object.create(null)
  };
  const gaps = [];
  let gapsTruncated = false;
  let clientOverflow = false;
  let sessionOverflow = false;
  let sessionRunOverflow = false;
  let sessionMsOverflow = false;
  let dayClientOverflow = false;
  const totals = emptyAgg();
  let gameVersion = null;
  let versionT = 0;

  for (const shard of shards) {
    const a = shard && shard.v === 1 ? shard : normalizeAgg(shard);
    for (const k of NUMS) totals[k] += a[k] || 0;
    clientOverflow = clientOverflow || a.clientOverflow;
    sessionOverflow = sessionOverflow || a.sessionOverflow;
    sessionRunOverflow = sessionRunOverflow || a.sessionRunOverflow;
    sessionMsOverflow = sessionMsOverflow || a.sessionMsOverflow;
    dayClientOverflow = dayClientOverflow || a.dayClientOverflow;
    gapsTruncated = gapsTruncated || a.gapsTruncated;
    if (a.versionT >= versionT && a.gameVersion) {
      versionT = a.versionT;
      gameVersion = a.gameVersion;
    }
    mergeSet(clients, a.clients);
    mergeSet(sessions, a.sessions);
    mergeAdd(sessionRuns, a.sessionRuns);
    mergeMax(sessionMs, a.sessionMs);
    for (const key of Object.keys(maps)) mergeAdd(maps[key], a[key]);
    for (const g of a.gaps || []) gaps.push(g);
    for (const day of Object.keys(a.byDay || {})) {
      if (!byDay[day]) byDay[day] = { events: 0, clients: Object.create(null) };
      byDay[day].events += a.byDay[day].events || 0;
      mergeSet(byDay[day].clients, a.byDay[day].clients);
    }
  }

  const runsPerSession = {};
  let sessionsWithRuns = 0;
  for (const sid of Object.keys(sessionRuns)) {
    sessionsWithRuns++;
    const n = sessionRuns[sid];
    runsPerSession[n] = (runsPerSession[n] || 0) + 1;
  }
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : null;
  const durations = Object.values(sessionMs).filter((n) => typeof n === 'number');
  durations.sort((a, b) => a - b);
  const durationSum = durations.reduce((s, n) => s + n, 0);
  const medianDur = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const funnel = Object.keys(maps.levelFunnel).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
    .map((lv) => ({ level: lv, deaths: maps.levelFunnel[String(lv)] }));
  const levelUpByLevel = Object.keys(maps.levelUpByLevel).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
    .map((lv) => ({ level: lv, count: maps.levelUpByLevel[String(lv)] }));
  const topCells = Object.entries(maps.deathCells).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([k, n]) => {
      const [x, y] = k.split(',');
      return { x: +x, y: +y, deaths: n };
    });
  const days = Object.keys(byDay).sort().map((d) => ({
    day: d,
    events: byDay[d].events,
    clients: Object.keys(byDay[d].clients).length
  }));
  const scanComplete = opts.scanComplete !== false;

  return {
    gameVersion,
    events: totals.events,
    truncated: !scanComplete,
    scanComplete,
    uniqueClients: Object.keys(clients).length,
    uniqueClientsExact: !clientOverflow,
    uniqueSessions: Object.keys(sessions).length,
    uniqueSessionsExact: !sessionOverflow,
    sessionsWithRuns,
    sessionsWithRunsExact: !sessionRunOverflow,
    runs: totals.runs,
    runsEnded: totals.runsEnded,
    avgScore: avg(totals.scoreSum, totals.runsEnded),
    maxScore: totals.maxScore,
    avgRunSeconds: avg(totals.secondsSum, totals.runsEnded),
    deathCause: { ...maps.deathCause },
    avgPingsPerRun: avg(totals.pingsSum, totals.runsEnded),
    avgEmptyPingsPerRun: avg(totals.emptyPingsSum, totals.runsEnded),
    firstFoodRate: totals.runsEnded ? Math.round(100 * totals.firstFoodCount / totals.runsEnded) : 0,
    avgFirstFoodSeconds: totals.firstFoodCount ? Math.round(totals.firstFoodSum / totals.firstFoodCount / 100) / 10 : 0,
    noFoodRuns: totals.noFoodRuns,
    levelFunnel: funnel,
    levelUps: totals.levelUps,
    levelUpByLevel,
    runsPerSession,
    medianReplayGapSeconds: medianGap != null ? Math.round(medianGap / 100) / 10 : null,
    replayGapSampleTruncated: gapsTruncated,
    touchShareOfLoads: totals.loads ? Math.round(100 * totals.touch / totals.loads) : 0,
    loadsByForm: { ...maps.byForm },
    loadsByPointer: { ...maps.byPointer },
    leaderboardOpens: totals.lbOpens,
    leaderboardSubmits: totals.lbSubmits,
    mutes: totals.mutes,
    abandons: totals.abandons,
    abandonsDuringRun: totals.abandonsDuringRun,
    abandonByLocation: { ...maps.abandonByLocation },
    sessionStarts: totals.sessionStarts,
    sessionsMeasured: durations.length,
    sessionsMeasuredExact: !sessionMsOverflow,
    avgSessionSeconds: avg(durationSum / 1000, durations.length),
    medianSessionSeconds: medianDur != null ? Math.round(medianDur / 100) / 10 : null,
    adImpressions: totals.adBefore,
    adAfter: totals.adAfter,
    adBreaks: totals.adBreaks,
    adBreakStatus: { ...maps.adBreakStatus },
    adRewards: totals.adRewards,
    activeDays: days,
    activeDayClientsExact: !dayClientOverflow,
    eventNames: { ...maps.names }
  };
}

export function shardOf(clientId) {
  const s = String(clientId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (s + 'xx').slice(0, 2);
}

export function fromRecord(rec) {
  return {
    clientId: rec && rec.c ? String(rec.c) : '',
    sessionId: rec && rec.s ? String(rec.s) : '',
    name: rec && rec.n ? String(rec.n) : '',
    t: rec && Number(rec.t) ? Number(rec.t) : 0,
    version: rec && rec.v ? String(rec.v) : '',
    props: rec && rec.p && typeof rec.p === 'object' ? rec.p : {}
  };
}

function pruneSeen(agg, cursor) {
  if (!agg.seen || !cursor) return;
  for (const k of Object.keys(agg.seen)) {
    if (k <= cursor) delete agg.seen[k];
  }
}

async function writeJson(store, key, value, etag) {
  if (etag) return store.setJSON(key, value, { onlyIfMatch: etag });
  return store.setJSON(key, value, { onlyIfNew: true });
}

export async function mergeShard(store, key, events, options = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(key, { type: 'json' });
    const agg = normalizeAgg(cur && cur.data);
    if (options.trackSeen) pruneSeen(agg, options.cursor || '');
    for (const ev of events) {
      if (options.trackSeen && ev._key && agg.seen[ev._key]) continue;
      applyEvent(agg, ev);
      if (options.trackSeen && ev._key && safeKey(ev._key) && Object.keys(agg.seen).length < CAP.seen) {
        agg.seen[ev._key] = 1;
      }
    }
    const res = await writeJson(store, key, agg, cur && cur.etag);
    if (!res || res.modified !== false) return;
  }
  throw new Error('analytics shard conflict');
}

export async function listKeys(store, prefix) {
  const keys = [];
  let listed = store.list({ prefix, paginate: true });
  if (listed && typeof listed.then === 'function') listed = await listed;
  if (listed && typeof listed[Symbol.asyncIterator] === 'function') {
    for await (const page of listed) {
      for (const b of (page && page.blobs) || []) if (b && b.key) keys.push(b.key);
    }
    return keys;
  }
  const page = await store.list({ prefix });
  for (const b of (page && page.blobs) || []) if (b && b.key) keys.push(b.key);
  return keys;
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Math.min(n, items.length);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  if (!items.length) return out;
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

async function saveMeta(store, loaded, next) {
  const res = await writeJson(store, 'aggmeta', next, loaded && loaded.etag);
  if (res && res.modified === false) {
    const again = await store.get('aggmeta', { type: 'json' });
    return normalizeMeta(again);
  }
  return next;
}

export async function backfillLegacy(store, opts = {}) {
  const peeked = await store.getWithMetadata('aggmeta', { type: 'json' });
  const peekedMeta = normalizeMeta(peeked && peeked.data);
  if (peekedMeta.done && !opts.force) return peekedMeta;
  const limit = opts.limit || 400;
  const deadline = Date.now() + (opts.budgetMs == null ? 8000 : opts.budgetMs);
  const keys = (await listKeys(store, 'e:')).filter((k) => k.startsWith('e:')).sort();
  for (let guard = 0; guard < 100000; guard++) {
    const loaded = await store.getWithMetadata('aggmeta', { type: 'json' });
    const meta = normalizeMeta(loaded && loaded.data);
    if (meta.done && !opts.force) return meta;
    let pending = keys.filter((k) => k > (meta.cursor || ''));
    if (!pending.length) {
      const fresh = (await listKeys(store, 'e:')).filter((k) => k.startsWith('e:')).sort();
      const more = fresh.filter((k) => k > (meta.cursor || ''));
      if (more.length) {
        keys.splice(0, keys.length, ...fresh);
        continue;
      }
      return saveMeta(store, loaded, { cursor: meta.cursor, done: true, epoch: meta.epoch });
    }
    if (Date.now() >= deadline) return meta;
    const batch = pending.slice(0, limit);
    const fetched = await mapPool(batch, 20, async (key) => {
      try {
        return { key, rec: await store.get(key, { type: 'json' }), error: false };
      } catch (e) {
        return { key, rec: null, error: true };
      }
    });
    fetched.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const grouped = Object.create(null);
    let cursor = meta.cursor || '';
    let processed = 0;
    for (const item of fetched) {
      if (item.error) break;
      cursor = item.key;
      processed++;
      if (!item.rec || item.rec.rolled) continue;
      const ev = fromRecord(item.rec);
      ev._key = item.key;
      const shard = shardOf(ev.clientId);
      if (!grouped[shard]) grouped[shard] = [];
      grouped[shard].push(ev);
    }
    if (!processed) return meta;
    for (const shard of Object.keys(grouped)) {
      await mergeShard(store, `leg:${shard}`, grouped[shard], { trackSeen: true, cursor: meta.cursor || '' });
    }
    const done = processed === pending.length;
    const saved = await saveMeta(store, loaded, { cursor, done, epoch: meta.epoch });
    if (saved.done) return saved;
    if ((saved.cursor || '') === (meta.cursor || '')) return saved;
  }
  const loaded = await store.get('aggmeta', { type: 'json' });
  return normalizeMeta(loaded);
}

export async function markLegacyPending(store) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata('aggmeta', { type: 'json' });
    const meta = normalizeMeta(cur && cur.data);
    meta.done = false;
    meta.epoch = (meta.epoch || 0) + 1;
    try {
      const res = await writeJson(store, 'aggmeta', meta, cur && cur.etag);
      if (!res || res.modified !== false) return;
    } catch (e) {}
  }
}

export async function foldLive(store, clientId, events) {
  if (!events.length) return;
  await mergeShard(store, `agg:${shardOf(clientId)}`, events, { trackSeen: false });
}

const SHARD_KEY = /^(?:agg|leg):[0-9a-z]{2}$/;

export async function loadSummary(store) {
  const meta = await backfillLegacy(store);
  const shards = [];
  for (const prefix of ['agg:', 'leg:']) {
    const keys = await listKeys(store, prefix);
    for (const key of keys) {
      if (!SHARD_KEY.test(key)) continue;
      try {
        const data = await store.get(key, { type: 'json' });
        if (data) shards.push(normalizeAgg(data));
      } catch (e) {}
    }
  }
  return summarize(shards, { scanComplete: !!(meta && meta.done) });
}
