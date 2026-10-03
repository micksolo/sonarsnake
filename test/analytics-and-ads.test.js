import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEvent,
  backfillLegacy,
  emptyAgg,
  foldLive,
  loadSummary,
  shardOf,
  summarize
} from '../netlify/functions/_shared/analytics-agg.js';
import { publicAdsConfig, readAdsEnv } from '../netlify/functions/_shared/ads-config.js';

function ev(name, props = {}, extra = {}) {
  return {
    clientId: extra.clientId || 'client-a',
    sessionId: extra.sessionId || 'session-a',
    name,
    t: extra.t || 1_700_000_000_000,
    version: extra.version || '1.2.0',
    props
  };
}

function memoryStore() {
  const data = new Map();
  const etags = new Map();
  let n = 1;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      if (opts && opts.type === 'json') return typeof v === 'string' ? JSON.parse(v) : clone(v);
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async getWithMetadata(key, opts) {
      if (!data.has(key)) return null;
      return { data: await this.get(key, opts), etag: etags.get(key), metadata: {} };
    },
    async set(key, value) {
      data.set(key, String(value));
      etags.set(key, String(++n));
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfNew && data.has(key)) return { modified: false };
      if (opts.onlyIfMatch && etags.get(key) !== opts.onlyIfMatch) return { modified: false };
      data.set(key, clone(value));
      const etag = String(++n);
      etags.set(key, etag);
      return { modified: true, etag };
    },
    list({ prefix = '', paginate = false } = {}) {
      const blobs = [...data.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((key) => ({ key, etag: etags.get(key) }));
      const pages = [];
      for (let i = 0; i < blobs.length; i += 1000) pages.push({ blobs: blobs.slice(i, i + 1000), directories: [] });
      if (!pages.length) pages.push({ blobs: [], directories: [] });
      if (paginate) return (async function* () { for (const p of pages) yield p; })();
      return Promise.resolve({ blobs: pages[0].blobs, directories: [] });
    }
  };
}

test('summary counts level-ups, device, session length, abandons, and ads past 8000 events', () => {
  const agg = emptyAgg();
  applyEvent(agg, ev('load', { touch: true, pointer: 'coarse', form: 'phone' }));
  applyEvent(agg, ev('load', { touch: false, form: 'desktop' }, { clientId: 'client-b', sessionId: 'session-b' }));
  applyEvent(agg, ev('session_start'));
  applyEvent(agg, ev('run_start', { gapMs: 2500 }));
  applyEvent(agg, ev('run_start', { gapMs: 4500 }, { sessionId: 'session-b', clientId: 'client-b' }));
  applyEvent(agg, ev('level_up', { level: 2 }));
  applyEvent(agg, ev('level_up', { level: 3 }));
  applyEvent(agg, ev('run_end', { cause: 'wall', score: 10, level: 1, seconds: 2, pingsUsed: 1, emptyPings: 0, firstFoodMs: 1000, deathX: 1, deathY: 2 }));
  applyEvent(agg, ev('run_end', { cause: 'self', score: 30, level: 2, seconds: 4, pingsUsed: 3, emptyPings: 1, deathX: 1, deathY: 2 }, { sessionId: 'session-b', clientId: 'client-b' }));
  applyEvent(agg, ev('abandon', { level: 1, score: 10 }));
  applyEvent(agg, ev('abandon', { location: 'title', durationMs: 8000, level: 0, score: 0 }, { sessionId: 'session-c', clientId: 'client-c' }));
  applyEvent(agg, ev('abandon', { location: 'dead', durationMs: 12000 }, { sessionId: 'session-b', clientId: 'client-b' }));
  applyEvent(agg, ev('session_ping', { durationMs: 1000 }));
  applyEvent(agg, ev('session_ping', { durationMs: 5000 }));
  applyEvent(agg, ev('session_end', { durationMs: 4000 }));
  applyEvent(agg, ev('session_end', { durationMs: 9000 }, { sessionId: 'session-b', clientId: 'client-b' }));
  applyEvent(agg, ev('lb_open'));
  applyEvent(agg, ev('lb_submit'));
  applyEvent(agg, ev('mute', { muted: true }));
  applyEvent(agg, ev('before_ad', { breakType: 'next', breakName: 'restart-game' }));
  applyEvent(agg, ev('after_ad', { breakType: 'next', breakName: 'restart-game' }));
  applyEvent(agg, ev('ad_break_done', { breakType: 'next', breakName: 'restart-game', breakFormat: 'interstitial', breakStatus: 'viewed' }));
  applyEvent(agg, ev('ad_reward', { breakName: 'continue-run' }));
  for (let i = 0; i < 8001; i++) applyEvent(agg, ev('level_up', { level: 2 }, { t: 1_700_000_000_000 + i }));

  const summary = summarize([agg], { scanComplete: true });
  assert.equal(summary.levelUps, 8003);
  assert.equal(summary.levelUpByLevel.find((row) => row.level === 2).count, 8002);
  assert.equal(summary.levelFunnel.find((row) => row.level === 1).deaths, 1);
  assert.equal(summary.runs, 2);
  assert.equal(summary.runsEnded, 2);
  assert.equal(summary.avgScore, 20);
  assert.equal(summary.maxScore, 30);
  assert.equal(summary.avgRunSeconds, 3);
  assert.equal(summary.touchShareOfLoads, 50);
  assert.equal(summary.loadsByForm.phone, 1);
  assert.equal(summary.loadsByForm.desktop, 1);
  assert.equal(summary.loadsByPointer.coarse, 1);
  assert.equal(summary.loadsByPointer.fine, 1);
  assert.equal(summary.abandons, 3);
  assert.equal(summary.abandonsDuringRun, 1);
  assert.equal(summary.abandonByLocation.title, 1);
  assert.equal(summary.abandonByLocation.dead, 1);
  assert.equal(summary.abandonByLocation.playing, 1);
  assert.equal(summary.sessionsMeasured, 3);
  assert.equal(summary.avgSessionSeconds, 8.3);
  assert.equal(summary.leaderboardOpens, 1);
  assert.equal(summary.leaderboardSubmits, 1);
  assert.equal(summary.mutes, 1);
  assert.equal(summary.adImpressions, 1);
  assert.equal(summary.adAfter, 1);
  assert.equal(summary.adBreaks, 1);
  assert.equal(summary.adBreakStatus.viewed, 1);
  assert.equal(summary.adRewards, 1);
  assert.equal(summary.truncated, false);
  assert.equal(summary.scanComplete, true);
  assert.equal(summary.noFoodRuns, 1);
  assert.equal(summary.firstFoodRate, 50);
  assert.equal(Object.hasOwn(summary, 'playingNow'), false);
  assert.equal(summary.eventNames.level_up, 8003);
});

test('session length comes only from stored durations', () => {
  const agg = emptyAgg();
  applyEvent(agg, ev('load', { touch: false }, { t: 1_000 }));
  applyEvent(agg, ev('run_end', { score: 1, seconds: 4, level: 1, cause: 'wall' }, { t: 50_000 }));
  const summary = summarize([agg]);
  assert.equal(summary.sessionsMeasured, 0);
  assert.equal(summary.avgSessionSeconds, 0);
  assert.equal(summary.medianSessionSeconds, null);
  assert.equal(summary.avgRunSeconds, 4);
});

test('legacy blobs are counted across list pages and rolled events are not doubled', async () => {
  const store = memoryStore();
  const live = [];
  for (let i = 0; i < 10; i++) live.push(ev('run_start', {}, { clientId: 'aa-player', sessionId: 'aa-session', t: 1_600_000_000_000 + i }));
  await foldLive(store, 'aa-player', live);
  for (let i = 0; i < 10; i++) {
    const rec = { c: 'aa-player', s: 'aa-session', n: 'run_start', t: 1_600_000_000_000 + i, v: '1.1.0', p: {}, rolled: true };
    await store.set(`e:${rec.t}:live${i}`, JSON.stringify(rec));
  }
  for (let i = 0; i < 1001; i++) {
    const rec = { c: 'aa-player', s: 'legacy-session', n: 'run_start', t: 1_500_000_000_000 + i, v: '1.0.0', p: {} };
    await store.set(`e:${rec.t}:old${i}`, JSON.stringify(rec));
  }
  const summary = await loadSummary(store);
  assert.equal(summary.runs, 1011);
  assert.equal(summary.uniqueClients, 1);
  assert.equal(summary.scanComplete, true);
  assert.equal(summary.truncated, false);
  const again = await loadSummary(store);
  assert.equal(again.runs, 1011);
  assert.equal(shardOf('aa-player'), 'aa');
});

test('same player is counted once when legacy and live shards both have them', async () => {
  const store = memoryStore();
  await foldLive(store, 'bb-player', [ev('run_start', {}, { clientId: 'bb-player', sessionId: 'bb-session' })]);
  const rec = { c: 'bb-player', s: 'bb-session', n: 'run_end', t: 1_700_000_000_100, v: '1.0.0', p: { score: 5, seconds: 1, level: 1, cause: 'wall' } };
  await store.set(`e:${rec.t}:only`, JSON.stringify(rec));
  const summary = await loadSummary(store);
  assert.equal(summary.uniqueClients, 1);
  assert.equal(summary.uniqueSessions, 1);
  assert.equal(summary.runs, 1);
  assert.equal(summary.runsEnded, 1);
  assert.equal(summary.avgScore, 5);
});

test('a lost rollup is picked up by the legacy scan', async () => {
  const store = memoryStore();
  const rec = { c: 'cc-player', s: 'cc-session', n: 'before_ad', t: 1_700_000_000_200, v: '1.2.0', p: { breakType: 'next' }, rolled: false };
  await store.set('aggmeta', JSON.stringify({ cursor: '', done: true, epoch: 1 }));
  await store.set(`e:${rec.t}:x`, JSON.stringify(rec));
  const { markLegacyPending } = await import('../netlify/functions/_shared/analytics-agg.js');
  await markLegacyPending(store);
  const summary = await loadSummary(store);
  assert.equal(summary.adImpressions, 1);
  assert.equal(summary.scanComplete, true);
});

test('ads config stays disabled until a real publisher id is provided', () => {
  assert.deepEqual(publicAdsConfig({ client: '' }), { enabled: false });
  assert.deepEqual(publicAdsConfig({ client: 'ca-pub-123' }), { enabled: false });
  assert.deepEqual(publicAdsConfig({ client: 'not-a-client' }), { enabled: false });
  const cfg = publicAdsConfig({
    client: 'ca-pub-1234567890123456',
    channel: '1234',
    host: 'nope',
    frequencyHint: '30s',
    test: 'on',
    apiKey: 'secret'
  });
  assert.deepEqual(cfg, {
    enabled: true,
    client: 'ca-pub-1234567890123456',
    channel: '1234',
    frequencyHint: '30s',
    test: true
  });
  assert.equal(Object.hasOwn(cfg, 'apiKey'), false);
  const fromEnv = publicAdsConfig(readAdsEnv({
    ADSENSE_CLIENT: 'ca-pub-9999888877776666',
    ADSENSE_FREQUENCY_HINT: 'nope',
    ADSENSE_TEST: '1'
  }));
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.client, 'ca-pub-9999888877776666');
  assert.equal(fromEnv.frequencyHint, '120s');
  assert.equal(fromEnv.test, true);
});

test('ads endpoint returns no publisher id when env is empty', async () => {
  const prev = process.env.ADSENSE_CLIENT;
  delete process.env.ADSENSE_CLIENT;
  const { default: handler } = await import('../netlify/functions/ads-config.js');
  const res = await handler();
  const body = await res.json();
  assert.deepEqual(body, { enabled: false });
  if (prev != null) process.env.ADSENSE_CLIENT = prev;
});

test('leaderboard and analytics modules still load', async () => {
  const lb = await import('../netlify/functions/leaderboard.js');
  const analytics = await import('../netlify/functions/analytics.js');
  assert.equal(typeof lb.default, 'function');
  assert.equal(typeof analytics.default, 'function');
  assert.equal(lb.config.path, '/api/leaderboard');
  assert.equal(analytics.config.path, '/api/analytics');
});

test('backfill keeps going after the first list page only if paginate is used', async () => {
  const store = memoryStore();
  let sawPaginate = false;
  const orig = store.list.bind(store);
  store.list = (opts = {}) => {
    if (opts.paginate) sawPaginate = true;
    return orig(opts);
  };
  for (let i = 0; i < 3; i++) {
    const rec = { c: 'dd-player', s: 'dd-session', n: 'mute', t: 1_400_000_000_000 + i, v: '1.0.0', p: { muted: true } };
    await store.set(`e:${rec.t}:${i}`, JSON.stringify(rec));
  }
  await backfillLegacy(store, { limit: 1, budgetMs: 5000 });
  const summary = await loadSummary(store);
  assert.equal(summary.mutes, 3);
  assert.equal(sawPaginate, true);
});
