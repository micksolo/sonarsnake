import { getStore } from '@netlify/blobs';
import {
  foldLive,
  listKeys,
  loadSummary,
  markLegacyPending
} from './_shared/analytics-agg.js';

const MAX_EVENTS = 50;
const RAW_CAP = 8000;

function clampStr(v, n) {
  return String(v == null ? '' : v).slice(0, n);
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
    const folded = [];
    const records = [];
    for (const ev of events) {
      const name = clampStr(ev && ev.name, 32).replace(/[^a-zA-Z_]/g, '');
      if (!name) continue;
      let props = {};
      if (ev && ev.props && typeof ev.props === 'object' && !Array.isArray(ev.props)) props = ev.props;
      let s;
      try { s = JSON.stringify(props); } catch (e) { s = '{}'; }
      if (s.length > 600) props = {};
      const t = Number(ev.t) || Date.now();
      folded.push({ clientId, sessionId, name, t, version: gameVersion, props });
      records.push({ c: clientId, s: sessionId, n: name, t, v: gameVersion, p: props, rolled: true });
    }
    if (!folded.length) return new Response('ok', { status: 200 });
    let rolled = true;
    try {
      await foldLive(store, clientId, folded);
    } catch (e) {
      rolled = false;
    }
    for (const rec of records) {
      rec.rolled = rolled;
      await store.set(`e:${rec.t}:${rnd()}`, JSON.stringify(rec));
    }
    if (!rolled) {
      try { await markLegacyPending(store); } catch (e) {}
    }
    return new Response('ok', { status: 200 });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const expect = envGet('ANALYTICS_TOKEN');
    if (!expect || token !== expect) return new Response('unauthorized', { status: 401 });

    if (url.searchParams.get('raw')) {
      const keys = (await listKeys(store, 'e:')).filter((k) => k.startsWith('e:')).sort();
      const slice = keys.slice(0, RAW_CAP);
      const raw = [];
      const bodies = await mapPool(slice, 20, async (key) => {
        try { return await store.get(key); } catch (e) { return null; }
      });
      for (const v of bodies) {
        if (!v) continue;
        try { raw.push(JSON.parse(v)); } catch (e) {}
      }
      raw.sort((a, b) => a.t - b.t);
      return Response.json(raw, {
        headers: { 'x-analytics-truncated': keys.length > RAW_CAP ? '1' : '0' }
      });
    }

    try {
      const summary = await loadSummary(store);
      return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return new Response('summary failed', { status: 500 });
    }
  }

  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/analytics' };
