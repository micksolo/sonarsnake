import { getStore } from '@netlify/blobs';

const MAX_ENTRIES = 10;

export function arcadeName(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return s.length === 3 ? s : '';
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function presentBoard(list) {
  const rows = [];
  for (const e of Array.isArray(list) ? list : []) {
    const name = arcadeName(e && e.name);
    if (!name) continue;
    rows.push({
      name,
      score: clampInt(e.score, 0, 999999, 0),
      level: clampInt(e.level, 1, 200, 1),
      ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : 0
    });
  }
  rows.sort((a, b) => b.score - a.score || a.ts - b.ts);
  return rows.slice(0, MAX_ENTRIES);
}

export function placeScore(list, entry) {
  const name = arcadeName(entry && entry.name);
  if (!name) return { error: 'name' };
  const board = presentBoard(list);
  const row = {
    name,
    score: clampInt(entry && entry.score, 0, 999999, 0),
    level: clampInt(entry && entry.level, 1, 200, 1),
    ts: typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : 0
  };
  if (board.length >= MAX_ENTRIES && row.score <= board[board.length - 1].score) {
    return { qualified: false, list: board, rank: 0 };
  }
  const next = board.concat(row);
  next.sort((a, b) => b.score - a.score || a.ts - b.ts);
  const trimmed = next.slice(0, MAX_ENTRIES);
  const rank = trimmed.findIndex(e => e.ts === row.ts && e.name === row.name && e.score === row.score) + 1;
  return { qualified: rank > 0, list: trimmed, rank: Math.max(rank, 0) };
}

async function loadList(store) {
  try {
    const list = JSON.parse((await store.get('top')) || '[]');
    if (Array.isArray(list)) return list;
  } catch (e) {}
  return [];
}

async function saveIfChanged(store, raw, board) {
  if (JSON.stringify(raw) === JSON.stringify(board)) return;
  await store.set('top', JSON.stringify(board));
}

export default async (req) => {
  const store = getStore('sonar-snake-lb');
  if (req.method === 'GET') {
    const raw = await loadList(store);
    const board = presentBoard(raw);
    await saveIfChanged(store, raw, board);
    return Response.json(board);
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) {
      return new Response('bad json', { status: 400 });
    }
    const raw = await loadList(store);
    const placed = placeScore(raw, {
      name: body && body.name,
      score: body && body.score,
      level: body && body.level,
      ts: Date.now()
    });
    if (placed.error) {
      await saveIfChanged(store, raw, presentBoard(raw));
      return new Response('name must be 3 letters or digits', { status: 400 });
    }
    await saveIfChanged(store, raw, placed.list);
    return Response.json({ qualified: placed.qualified, list: placed.list, rank: placed.rank });
  }

  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/leaderboard' };
