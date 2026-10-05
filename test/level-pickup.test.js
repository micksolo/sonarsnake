import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function slice(from, to){
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  assert.ok(start > 0 && end > start, `${from} .. ${to}`);
  return html.slice(start, end);
}

function loadGame(){
  const decl = html.match(/const COLS=(\d+),ROWS=(\d+),CELL=(\d+);/);
  assert.ok(decl, 'grid constants');
  const context = {
    COLS: Number(decl[1]),
    ROWS: Number(decl[2]),
    CELL: Number(decl[3]),
    grid: null,
    snake: null,
    dir: {x: 1, y: 0},
    dirQueue: [],
    level: 1,
    food: null,
    foods: 0,
    score: 0,
    best: 0,
    moveInterval: 260,
    beaconT: 2.4,
    flashHold: 0,
    flashT: 0,
    flashes: 3,
    pings: [],
    shakeT: 0,
    shakeMax: 1,
    shakeAmp: 0,
    state: 'playing',
    runStats: {firstFoodMs: 0, startT: 0, pingsUsed: 0, emptyPings: 0},
    scoreEl: {textContent: '0'},
    bestEl: {textContent: '0'},
    levelEl: {textContent: '1'},
    localStorage: {setItem(){}, getItem(){return '0';}},
    track(){},
    tone(){},
    updateFlashHUD(){},
    died: null
  };
  context.idx = (x, y) => y * context.COLS + x;
  context.inB = (x, y) => x >= 0 && y >= 0 && x < context.COLS && y < context.ROWS;
  context.isSnakeCell = (x, y) => context.snake.some(s => s.x === x && s.y === y);
  context.die = (cause) => {context.died = cause; context.state = 'dead';};
  vm.createContext(context);
  vm.runInContext(slice('function computeReachable', 'function pingNote'), context);
  vm.runInContext(slice('function flash(free)', 'function beginRun'), context);
  vm.runInContext(slice('function levelUp()', 'function die('), context);
  vm.runInContext(slice('function step()', 'function update('), context);
  return context;
}

function openBoard(context){
  context.grid = [];
  for (let y = 0; y < context.ROWS; y++) {
    for (let x = 0; x < context.COLS; x++) {
      context.grid.push({
        wall: x === 0 || y === 0 || x === context.COLS - 1 || y === context.ROWS - 1,
        reveal: 0,
        seen: false
      });
    }
  }
}

function onSnake(context){
  return context.snake.some(s => s.x === context.food.x && s.y === context.food.y);
}

test('a level change puts a live pickup down with the new walls', () => {
  for (let n = 0; n < 30; n++) {
    const context = loadGame();
    openBoard(context);
    context.level = 1 + (n % 4);
    context.foods = 4;
    context.beaconT = 2.4;
    context.snake = [];
    for (let i = 0; i < 8; i++) context.snake.push({x: 8 - i, y: 8});
    context.dir = {x: 1, y: 0};
    context.dirQueue = [];
    context.food = {x: 9, y: 8};
    const wallsBefore = context.grid.reduce((k, c) => k + (c.wall ? 1 : 0), 0);

    context.step();

    assert.equal(context.died, null);
    assert.equal(context.level, 2 + (n % 4));
    assert.equal(context.foods, 5);
    assert.equal(context.score, 10 + (1 + (n % 4)) * 2);
    assert.ok(context.food, 'pickup exists in the same step as the new walls');
    assert.equal(onSnake(context), false, 'pickup is not buried in the snake');
    assert.equal(context.grid[context.idx(context.food.x, context.food.y)].wall, false);
    assert.ok(context.computeReachable(context.snake[0].x, context.snake[0].y).has(context.idx(context.food.x, context.food.y)));
    assert.ok(Math.max(Math.abs(context.food.x - context.snake[0].x), Math.abs(context.food.y - context.snake[0].y)) > 3);
    assert.equal(context.beaconT, 0, 'beacon pulse restarts with the level, same as a new run');
    assert.equal(context.grid[context.idx(context.food.x, context.food.y)].reveal, 1);
    const wallsAfter = context.grid.reduce((k, c) => k + (c.wall ? 1 : 0), 0);
    assert.ok(wallsAfter >= wallsBefore, 'new blocks are in place when the pickup is');
    assert.equal(context.state, 'playing');
  }
});

test('an ordinary eat still scores and replaces the pickup without restarting the beacon clock', () => {
  const context = loadGame();
  openBoard(context);
  context.foods = 1;
  context.beaconT = 1.7;
  context.snake = [{x: 4, y: 4}, {x: 3, y: 4}, {x: 2, y: 4}, {x: 1, y: 4}];
  context.food = {x: 5, y: 4};
  context.step();
  assert.equal(context.level, 1);
  assert.equal(context.foods, 2);
  assert.equal(context.score, 12);
  assert.equal(context.beaconT, 1.7);
  assert.ok(context.food);
  assert.equal(onSnake(context), false);
  assert.equal(context.died, null);
});

test('a level change adds fewer walls than the old batch, and later levels add more', () => {
  function samples(level){
    const added = [];
    for (let n = 0; n < 40; n++) {
      const context = loadGame();
      openBoard(context);
      context.level = level;
      context.snake = [];
      for (let i = 0; i < 8; i++) context.snake.push({x: 8 - i, y: 8});
      context.food = {x: 14, y: 3};
      const before = context.grid.reduce((k, c) => k + (c.wall ? 1 : 0), 0);
      context.addWalls();
      const after = context.grid.reduce((k, c) => k + (c.wall ? 1 : 0), 0);
      added.push(after - before);
    }
    return added;
  }
  const early = samples(2);
  const later = samples(8);
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const earlyMean = mean(early);
  const laterMean = mean(later);
  assert.ok(Math.max(...early) <= 18, `level 2 dumped ${Math.max(...early)} walls`);
  assert.ok(earlyMean < 14, `level 2 averaged ${earlyMean} walls`);
  assert.ok(Math.max(...later) <= 36, `level 8 dumped ${Math.max(...later)} walls`);
  assert.ok(laterMean > earlyMean, `later levels (${laterMean}) should tighten more than early ones (${earlyMean})`);
  assert.match(html, /wallCount<COLS\*ROWS\*0\.5/);
});

test('walls still fill toward the half-board cap over a run', () => {
  const count = (context) => context.grid.reduce((k, c) => k + (c.wall ? 1 : 0), 0);
  for (let n = 0; n < 12; n++) {
    const context = loadGame();
    context.level = 1;
    context.genMaze();
    context.spawnFood();
    const cap = context.COLS * context.ROWS * 0.5;
    context.level = 2;
    context.addWalls();
    const early = count(context);
    assert.ok(early < cap - 40, `level 2 already has ${early} walls`);
    for (let lv = 3; lv <= 14; lv++) {
      context.level = lv;
      context.addWalls();
    }
    const late = count(context);
    assert.ok(late > early + 40, `walls only grew from ${early} to ${late}`);
    assert.ok(late >= cap - 20, `run ended at ${late}, short of the ${cap} cap`);
  }
});

function assertPlayable(context){
  const f = context.food;
  assert.ok(f, 'a pickup was placed');
  assert.equal(context.grid[context.idx(f.x, f.y)].wall, false);
  assert.equal(context.snake.some(s => s.x === f.x && s.y === f.y), false);
  const head = context.snake[0];
  const reach = context.floodOpen(head.x, head.y);
  const dist = Math.max(Math.abs(f.x - head.x), Math.abs(f.y - head.y));
  const deg = context.openDegree(f.x, f.y);
  const cul = context.isCulDeSac(f.x, f.y);
  if (deg >= 2 && !cul && dist > 3 && reach.has(context.idx(f.x, f.y))) return;
  let strict = 0;
  for (let y = 1; y < context.ROWS - 1; y++){
    for (let x = 1; x < context.COLS - 1; x++){
      if (context.grid[context.idx(x, y)].wall) continue;
      if (context.snake.some(s => s.x === x && s.y === y)) continue;
      if (Math.max(Math.abs(x - head.x), Math.abs(y - head.y)) <= 3) continue;
      if (!reach.has(context.idx(x, y))) continue;
      if (context.openDegree(x, y) < 2) continue;
      if (context.isCulDeSac(x, y)) continue;
      strict++;
      break;
    }
    if (strict) break;
  }
  assert.equal(strict, 0, `pickup at ${f.x},${f.y} deg ${deg} cul ${cul} dist ${dist} ignored a safe cell`);
}

test('a pickup does not spawn in the boxed-in corner', () => {
  for (let n = 0; n < 30; n++){
    const context = loadGame();
    openBoard(context);
    context.grid[context.idx(16, 15)].wall = true;
    context.snake = [];
    for (let i = 0; i < 5; i++) context.snake.push({x: 10 - i, y: 8});
    context.spawnFood();
    assert.ok(!(context.food.x === 16 && context.food.y === 16));
    assert.ok(context.openDegree(context.food.x, context.food.y) >= 2);
    assert.equal(context.isCulDeSac(context.food.x, context.food.y), false);
  }
});

test('a pickup does not spawn inside a 1-wide dead-end corridor', () => {
  for (let n = 0; n < 20; n++){
    const context = loadGame();
    openBoard(context);
    for (let x = 8; x <= 16; x++) context.grid[context.idx(x, 15)].wall = true;
    context.snake = [];
    for (let i = 0; i < 5; i++) context.snake.push({x: 4 - i, y: 8});
    context.spawnFood();
    assert.ok(context.food.y !== 16 || context.food.x < 8, `corridor cell ${context.food.x},${context.food.y}`);
    assertPlayable(context);
  }
});

test('a crowded board still places a pickup', () => {
  const context = loadGame();
  openBoard(context);
  for (let y = 1; y < context.ROWS - 1; y++){
    for (let x = 1; x < context.COLS - 1; x++){
      if (y !== 8) context.grid[context.idx(x, y)].wall = true;
    }
  }
  context.snake = [];
  for (let i = 0; i < 5; i++) context.snake.push({x: 8 - i, y: 8});
  context.spawnFood();
  assert.ok(context.food);
  assert.equal(context.grid[context.idx(context.food.x, context.food.y)].wall, false);
  assert.equal(context.snake.some(s => s.x === context.food.x && s.y === context.food.y), false);
  assert.equal(context.food.y, 8);
});

test('walls that trap an existing pickup move it', () => {
  const context = loadGame();
  openBoard(context);
  context.snake = [];
  for (let i = 0; i < 5; i++) context.snake.push({x: 10 - i, y: 8});
  context.food = {x: 16, y: 16};
  context.grid[context.idx(16, 15)].wall = true;
  assert.equal(context.openDegree(16, 16), 1);
  context.level = 2;
  context.addWalls();
  assert.ok(!(context.food.x === 16 && context.food.y === 16), 'the corner beacon was left in a dead end');
  assertPlayable(context);
});

test('pickups across levels stay out of dead ends', () => {
  for (let n = 0; n < 16; n++){
    const context = loadGame();
    const start = 1 + (n % 6);
    context.level = start;
    context.genMaze();
    context.spawnFood();
    assertPlayable(context);
    for (let lv = start + 1; lv <= start + 4; lv++){
      context.level = lv;
      context.addWalls();
      assertPlayable(context);
    }
  }
});

test('hitting a wall still ends the run', () => {
  const context = loadGame();
  openBoard(context);
  context.snake = [{x: 16, y: 4}, {x: 15, y: 4}, {x: 14, y: 4}];
  context.food = {x: 1, y: 1};
  context.dir = {x: 1, y: 0};
  context.step();
  assert.equal(context.died, 'wall');
  assert.equal(context.state, 'dead');
  assert.equal(context.level, 1);
  assert.equal(context.foods, 0);
});
