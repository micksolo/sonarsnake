import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extract(source, name){
  const token = 'function ' + name + '(';
  const start = source.indexOf(token);
  assert.ok(start >= 0, name);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++){
    const c = source[i];
    if (c === "'" || c === '"'){
      const q = c;
      i++;
      while (i < source.length && source[i] !== q){
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}'){
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function between(from, to){
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  assert.ok(start >= 0 && end > start, from);
  return html.slice(start, end);
}

function loadGame(){
  const grace = html.match(/const START_GRACE=(\d+(?:\.\d+)?);/);
  assert.ok(grace, 'start grace constant');
  const src = [
    grace[0],
    extract(html, 'beginRun'),
    extract(html, 'step'),
    extract(html, 'update'),
    extract(html, 'queueDir')
  ].join('\n');
  const context = {
    Math,
    Date,
    START_GRACE: Number(grace[1]),
    state: 'title',
    grid: [],
    snake: null,
    dir: { x: 1, y: 0 },
    dirQueue: [],
    food: null,
    pings: [],
    score: 0,
    level: 1,
    foods: 0,
    moveInterval: 260,
    moveAcc: 0,
    startGrace: 0,
    flashes: 3,
    flashHold: 0,
    tGlobal: 0,
    deathT: 0,
    flashT: 0,
    firePulse: 0,
    pingBanner: null,
    shakeT: 0,
    beaconT: 0,
    submitted: false,
    deathPanelShown: false,
    adHold: false,
    adHoldAccum: 0,
    runCount: 0,
    lastRunEndT: null,
    runStats: null,
    events: [],
    COLS: 18,
    ROWS: 18,
    scoreEl: { textContent: '0' },
    levelEl: { textContent: '1' },
    pbtnreward: { hidden: true },
    panel: { hidden: true },
    clearAdLeave(){},
    hidePanel(){ context.panel.hidden = true; },
    track(name, props){ context.events.push({ name, props }); },
    spawnFood(){ context.food = { x: 3, y: 3 }; },
    updateFlashHUD(){},
    flash(){},
    tone(){},
    showPanel(){},
    offerContinueAd(){},
    die(cause){ context.state = 'dead'; context.died = cause; }
  };
  context.idx = (x, y) => y * context.COLS + x;
  context.inB = (x, y) => x >= 0 && y >= 0 && x < context.COLS && y < context.ROWS;
  context.genMaze = () => {
    context.snake = [
      { x: 10, y: 8 },
      { x: 9, y: 8 },
      { x: 8, y: 8 },
      { x: 7, y: 8 },
      { x: 6, y: 8 }
    ];
    context.dir = { x: 1, y: 0 };
    context.dirQueue = [];
    context.grid = [];
    for (let y = 0; y < 18; y++){
      for (let x = 0; x < 18; x++){
        context.grid.push({
          wall: x === 0 || y === 0 || x === 17 || y === 17,
          reveal: 0,
          seen: false
        });
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

function advance(game, seconds){
  const frames = Math.round(seconds / 0.05);
  for (let i = 0; i < frames; i++) game.update(0.05);
}

test('the game version moves past the 1.3.0 straight-start deaths', () => {
  assert.match(html, /const GAME_VERSION='1\.4\.0';/);
  const grace = html.match(/const START_GRACE=(\d+(?:\.\d+)?);/);
  assert.ok(grace);
  const seconds = Number(grace[1]);
  assert.ok(seconds >= 0.75 && seconds <= 1.25, `grace ${seconds}s should be long enough to turn and short of feeling stuck`);
});

test('a new run sits still, keeps a turn made during the pause, then moves that way', () => {
  const game = loadGame();
  game.beginRun();
  assert.equal(game.state, 'playing');
  assert.equal(game.startGrace, game.START_GRACE);
  assert.equal(game.events.at(-1).name, 'run_start');
  const head = { ...game.snake[0] };

  advance(game, game.START_GRACE - 0.05);
  assert.deepEqual(game.snake[0], head, 'the snake must not move during the opening pause');
  assert.equal(game.state, 'playing');

  game.queueDir([0, -1]);
  assert.equal(game.dirQueue.length, 1);
  advance(game, 0.05);
  assert.equal(game.startGrace, 0);
  assert.equal(game.snake[0].x, head.x);
  assert.equal(game.snake[0].y, head.y - 1);
  assert.equal(game.dir.y, -1);
  assert.equal(game.state, 'playing');
});

test('with no turn, the first move is still straight ahead and only after the pause', () => {
  const game = loadGame();
  game.beginRun();
  const head = { ...game.snake[0] };
  advance(game, game.START_GRACE - 0.05);
  assert.deepEqual(game.snake[0], head);
  advance(game, 0.05);
  assert.equal(game.snake[0].x, head.x + 1);
  assert.equal(game.snake[0].y, head.y);
  advance(game, 0.2);
  assert.equal(game.snake[0].x, head.x + 1, 'the next cell waits for the normal move interval');
});

test('a restart pauses again and does not keep the previous heading', () => {
  const game = loadGame();
  game.beginRun();
  game.queueDir([0, -1]);
  advance(game, game.START_GRACE + 0.3);
  assert.equal(game.dir.y, -1);
  assert.ok(game.snake[0].y < 8);

  game.beginRun();
  assert.equal(game.startGrace, game.START_GRACE);
  assert.equal(game.dir.x, 1);
  assert.equal(game.dir.y, 0);
  assert.equal(game.dirQueue.length, 0);
  assert.equal(game.snake[0].x, 10);
  assert.equal(game.snake[0].y, 8);
  advance(game, game.START_GRACE - 0.05);
  assert.equal(game.snake[0].x, 10);
  assert.equal(game.snake[0].y, 8);
  game.queueDir([0, 1]);
  advance(game, 0.05);
  assert.equal(game.snake[0].x, 10);
  assert.equal(game.snake[0].y, 9);
});

test('the opening pause does not swallow the first keyboard or swipe turn', () => {
  const keys = between("window.addEventListener('keydown'", "document.addEventListener('touchmove'");
  assert.match(keys, /newGame\(\);if\(KEYDIRS\[k\]\)queueDir\(KEYDIRS\[k\]\)/);
  assert.doesNotMatch(keys, /startGrace/);

  const move = between("cv.addEventListener('pointermove'", "cv.addEventListener('pointerup'");
  assert.match(move, /if\(state==='playing'\)queueDir\(d\)/);
  assert.doesNotMatch(move, /startGrace/);

  const up = between("cv.addEventListener('pointerup'", 'let last=performance.now()');
  assert.match(up, /newGame\(\);\s*if\(gesture\.dir\)queueDir\(gesture\.dir\)/);
  assert.doesNotMatch(up, /startGrace/);

  const game = loadGame();
  game.beginRun();
  game.queueDir([0, -1]);
  game.queueDir([-1, 0]);
  advance(game, game.START_GRACE);
  assert.equal(game.snake[0].x, 10);
  assert.equal(game.snake[0].y, 7);
  assert.equal(game.dirQueue.length, 1);
  assert.equal(game.dirQueue[0].x, -1);
  assert.equal(game.dirQueue[0].y, 0);
  game.update(0.26);
  assert.equal(game.snake[0].x, 9);
  assert.equal(game.snake[0].y, 7);
});
