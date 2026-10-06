import { getStore } from '@netlify/blobs';
import {
  foldLive,
  listKeys,
  loadSummary,
  markLegacyPending,
  selectRecentKeys
} from './_shared/analytics-agg.js';

const MAX_EVENTS = 50;
const RAW_CAP = 8000;

function clampStr(v, n) {
  return String(v == null ? '' : v).slice(0, n);
}

function flagOn(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function envGet(name) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      const v = Netlify.env.get(name);
      if (v) return v;
    }
  } catch (e) {}
  return process.env[name];
}

function analyticsStore() {
  return getStore('sonar-snake-analytics');
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  if (!items.length) return out;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export default async (req) => {
  const store = analyticsStore();

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
    const clientId = clampStr(body.clientId, 64);
    const sessionId = clampStr(body.sessionId, 64);
    const gameVersion = clampStr(body.gameVersion, 16);
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
    if (!clientId || !events.length) return new Response('ok', { status: 200 });
    const rnd = () => Math.random().toString(36).slice(2, 10);
    const batchTester = flagOn(body.tester);
    const live = [];
    const qa = [];
    const records = [];
    for (const ev of events) {
      const name = clampStr(ev && ev.name, 32).replace(/[^a-zA-Z_]/g, '');
      if (!name) continue;
      let props = {};
      if (ev && ev.props && typeof ev.props === 'object' && !Array.isArray(ev.props)) props = ev.props;
      let s;
      try { s = JSON.stringify(props); } catch (e) { s = '{}'; }
      if (s.length > 600) props = {};
      const tester = batchTester || flagOn(props.tester);
      if (tester) props.tester = true;
      const t = Number(ev.t) || Date.now();
      const row = { clientId, sessionId, name, t, version: gameVersion, props };
      if (tester) qa.push(row);
      else live.push(row);
      records.push({ c: clientId, s: sessionId, n: name, t, v: gameVersion, p: props, q: tester ? 1 : 0, rolled: true });
    }
    if (!records.length) return new Response('ok', { status: 200 });
    let liveRolled = true;
    let qaRolled = true;
    try {
      if (live.length) await foldLive(store, clientId, live);
    } catch (e) {
      liveRolled = false;
    }
    try {
      if (qa.length) await foldLive(store, clientId, qa, 'agqt');
    } catch (e) {
      qaRolled = false;
    }
    for (const rec of records) {
      rec.rolled = rec.q ? qaRolled : liveRolled;
      await store.set(`${rec.q ? 'eq' : 'e'}:${rec.t}:${rnd()}`, JSON.stringify(rec));
    }
    if (!liveRolled) {
      try { await markLegacyPending(store); } catch (e) {}
    }
    return new Response('ok', { status: 200 });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const expect = envGet('ANALYTICS_TOKEN');
    if (!expect || token !== expect) return new Response('unauthorized', { status: 401 });

    const includeTesters = flagOn(url.searchParams.get('includeTesters'));
    if (url.searchParams.get('raw')) {
      const keys = (await listKeys(store, 'e:')).filter((k) => k.startsWith('e:'));
      if (includeTesters) keys.push(...(await listKeys(store, 'eq:')).filter((k) => k.startsWith('eq:')));
      const picked = selectRecentKeys(keys, {
        limit: url.searchParams.get('limit') || RAW_CAP,
        since: url.searchParams.get('since'),
        until: url.searchParams.get('until'),
        includeTesters
      });
      const raw = [];
      const bodies = await mapPool(picked.keys, 20, async (key) => {
        try { return await store.get(key); } catch (e) { return null; }
      });
      for (const v of bodies) {
        if (!v) continue;
        try { raw.push(JSON.parse(v)); } catch (e) {}
      }
      return Response.json(raw, {
        headers: { 'x-analytics-truncated': picked.truncated ? '1' : '0' }
      });
    }

    try {
      const summary = await loadSummary(store, { includeTesters });
      return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return new Response('summary failed', { status: 500 });
    }
  }

  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/analytics' };
