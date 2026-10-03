import { getStore } from '@netlify/blobs';

const MAX_EVENTS = 50;
const AGG_CAP = 8000;

function clampStr(v, n) {
  return String(v == null ? '' : v).slice(0, n);
}

export default async (req) => {
  const store = getStore('sonar-snake-analytics');

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
    const clientId = clampStr(body.clientId, 64);
    const sessionId = clampStr(body.sessionId, 64);
    const gameVersion = clampStr(body.gameVersion, 16);
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
    if (!clientId || !events.length) return new Response('ok', { status: 200 });
    const rnd = () => Math.random().toString(36).slice(2, 10);
    for (const ev of events) {
      const name = clampStr(ev && ev.name, 32).replace(/[^a-zA-Z_]/g, '');
      if (!name) continue;
      let props = {};
      if (ev && ev.props && typeof ev.props === 'object' && !Array.isArray(ev.props)) props = ev.props;
      let s;
      try { s = JSON.stringify(props); } catch (e) { s = '{}'; }
      if (s.length > 600) props = {};
      const rec = { c: clientId, s: sessionId, n: name, t: Number(ev.t) || Date.now(), v: gameVersion, p: props };
      await store.set(`e:${rec.t}:${rnd()}`, JSON.stringify(rec));
    }
    return new Response('ok', { status: 200 });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const expect = process.env.ANALYTICS_TOKEN;
    if (!expect || token !== expect) return new Response('unauthorized', { status: 401 });

    const { blobs } = await store.list();
    const raw = [];
    const cap = Math.min(blobs.length, AGG_CAP);
    for (let i = 0; i < cap; i++) {
      try {
        const v = await store.get(blobs[i].key);
        if (v) raw.push(JSON.parse(v));
      } catch (e) {}
    }
    raw.sort((a, b) => a.t - b.t);
    if (url.searchParams.get('raw')) return Response.json(raw);

    const clients = new Set(), sessions = new Set();
    const byDay = {}, deathCause = {}, levelFunnel = {}, runsPerSession = {}, deathCells = {};
    let loads = 0, touch = 0, runs = 0, runsEnded = 0, scoreSum = 0, maxScore = 0,
        secondsSum = 0, pingsSum = 0, emptyPingsSum = 0, firstFoodCount = 0, firstFoodSum = 0,
        noFoodRuns = 0, lbOpens = 0, lbSubmits = 0, mutes = 0, abandons = 0;
    const gaps = [], sessionRunCounts = {};

    for (const e of raw) {
      clients.add(e.c); sessions.add(e.s);
      const day = new Date(e.t).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { events: 0, clients: new Set() };
      byDay[day].events++; byDay[day].clients.add(e.c);
      const p = e.p || {};
      switch (e.n) {
        case 'load': loads++; if (p.touch) touch++; break;
        case 'run_start':
          runs++; sessionRunCounts[e.s] = (sessionRunCounts[e.s] || 0) + 1;
          if (typeof p.gapMs === 'number') gaps.push(p.gapMs);
          break;
        case 'run_end': {
          runsEnded++;
          scoreSum += p.score || 0; maxScore = Math.max(maxScore, p.score || 0);
          secondsSum += p.seconds || 0;
          const c = p.cause || '?'; deathCause[c] = (deathCause[c] || 0) + 1;
          const lv = p.level || 1; levelFunnel[lv] = (levelFunnel[lv] || 0) + 1;
          pingsSum += p.pingsUsed || 0; emptyPingsSum += p.emptyPings || 0;
          if (p.firstFoodMs != null) { firstFoodCount++; firstFoodSum += p.firstFoodMs; }
          else noFoodRuns++;
          if (p.deathX != null) { const k = p.deathX + ',' + p.deathY; deathCells[k] = (deathCells[k] || 0) + 1; }
          break;
        }
        case 'lb_open': lbOpens++; break;
        case 'lb_submit': lbSubmits++; break;
        case 'mute': mutes++; break;
        case 'abandon': abandons++; break;
      }
    }
    for (const k in sessionRunCounts) {
      const n = sessionRunCounts[k];
      runsPerSession[n] = (runsPerSession[n] || 0) + 1;
    }
    const avg = (sum, n) => n ? Math.round((sum / n) * 10) / 10 : 0;
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : null;
    const funnel = Object.keys(levelFunnel).map(Number).sort((a, b) => a - b)
      .map(lv => ({ level: lv, deaths: levelFunnel[lv] }));
    const topCells = Object.entries(deathCells).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([k, n]) => { const [x, y] = k.split(','); return { x: +x, y: +y, deaths: n }; });
    const days = Object.keys(byDay).sort().map(d => ({ day: d, events: byDay[d].events, clients: byDay[d].clients.size }));

    return Response.json({
      gameVersion: raw.length ? raw[raw.length - 1].v : null,
      events: raw.length,
      truncated: blobs.length > cap,
      uniqueClients: clients.size,
      uniqueSessions: sessions.size,
      sessionsWithRuns: Object.keys(sessionRunCounts).length,
      runs,
      runsEnded,
      avgScore: avg(scoreSum, runsEnded),
      maxScore,
      avgRunSeconds: avg(secondsSum, runsEnded),
      deathCause,
      avgPingsPerRun: avg(pingsSum, runsEnded),
      avgEmptyPingsPerRun: avg(emptyPingsSum, runsEnded),
      firstFoodRate: runsEnded ? Math.round(100 * firstFoodCount / runsEnded) : 0,
      avgFirstFoodSeconds: firstFoodCount ? Math.round(firstFoodSum / firstFoodCount / 100) / 10 : 0,
      noFoodRuns,
      levelFunnel: funnel,
      runsPerSession,
      medianReplayGapSeconds: medianGap != null ? Math.round(medianGap / 100) / 10 : null,
      touchShareOfLoads: loads ? Math.round(100 * touch / loads) : 0,
      leaderboardOpens: lbOpens,
      leaderboardSubmits: lbSubmits,
      mutes,
      abandons,
      activeDays: days
    });
  }

  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/analytics' };
