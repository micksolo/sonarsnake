import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { arcadeName, placeScore, presentBoard } from '../netlify/functions/leaderboard.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('arcade names are exactly 3 letters or digits', () => {
  assert.equal(arcadeName('hello'), 'HEL');
  assert.equal(arcadeName('A!B2'), 'AB2');
  assert.equal(arcadeName('  anon '), 'ANO');
  assert.equal(arcadeName('ab'), '');
  assert.equal(arcadeName('!!!'), '');
  assert.equal(arcadeName(''), '');
});

test('the board keeps 10 scores and 3-character tags', () => {
  const legacy = [
    { name: 'ANON', score: 50, level: 2, ts: 1 },
    { name: 'way-too-long', score: 80, level: 3, ts: 2 }
  ];
  const shown = presentBoard(legacy);
  assert.deepEqual(shown.map(e => e.name), ['WAY', 'ANO']);
  assert.equal(shown.length, 2);

  let board = [];
  for (let i = 0; i < 12; i++) {
    const placed = placeScore(board, { name: 'P' + (i % 10) + 'X', score: 100 + i, level: 1, ts: 10 + i });
    assert.equal(placed.error, undefined);
    board = placed.list;
  }
  assert.equal(board.length, 10);
  assert.equal(board[0].score, 111);
  assert.equal(board[9].score, 102);
  assert.ok(board.every(e => /^[A-Z0-9]{3}$/.test(e.name)));

  const missed = placeScore(board, { name: 'zzz', score: 1, level: 1, ts: 99 });
  assert.equal(missed.qualified, false);
  assert.equal(missed.list.length, 10);
  assert.equal(missed.list.some(e => e.name === 'ZZZ'), false);

  const rejected = placeScore(board, { name: 'no', score: 9999, level: 1, ts: 100 });
  assert.equal(rejected.error, 'name');
});

test('the client asks for a 3-character tag and shows at most 10 rows', () => {
  assert.match(html, /maxlength="3"/);
  assert.match(html, /\.slice\(0,10\)/);
  assert.equal(html.includes('ANON'), false);
  assert.equal(html.includes('maxlength="12"'), false);
});

test('firing and refilling a ping is a visible pulse, not only a dot swap', () => {
  assert.match(html, /updateFlashHUD\('spend'\)/);
  assert.match(html, /updateFlashHUD\('recharge'\)/);
  assert.match(html, /@keyframes pipSpent/);
  assert.match(html, /@keyframes pipReady/);
  assert.match(html, /function drawFirePulse/);
  assert.match(html, /PINGS READY/);
  assert.match(html, /id="flashdots"/);
  assert.equal(html.includes('●'), false);
});
