import { getStore } from '@netlify/blobs';

const MAX_ENTRIES = 10;

function sanitizeName(raw) {
  const s = String(raw || '').replace(/[^a-zA-Z0-9 _\-!.]/g, '').trim().slice(0, 12);
  return s || 'ANON';
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

async function loadList(store) {
  try {
    const list = JSON.parse((await store.get('top')) || '[]');
    if (Array.isArray(list)) return list;
  } catch (e) {}
  return [];
}

export default async (req) => {
  if (req.method === 'GET') {
    const list = await loadList(getStore('sonar-snake-lb'));
    return Response.json(list);
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) {
      return new Response('bad json', { status: 400 });
    }
    const entry = {
      name: sanitizeName(body && body.name),
      score: clampInt(body && body.score, 0, 999999, 0),
      level: clampInt(body && body.level, 1, 200, 1),
      ts: Date.now()
    };
    const store = getStore('sonar-snake-lb');
    const list = await loadList(store);
    if (list.length >= MAX_ENTRIES && entry.score <= list[list.length - 1].score) {
      return Response.json({ qualified: false, list });
    }
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const trimmed = list.slice(0, MAX_ENTRIES);
    await store.set('top', JSON.stringify(trimmed));
    const rank = trimmed.findIndex(e => e.ts === entry.ts) + 1;
    return Response.json({ qualified: rank > 0, list: trimmed, rank: Math.max(rank, 0) });
  }

  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/leaderboard' };
