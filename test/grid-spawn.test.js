import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function loadMaze(){
  const start = html.indexOf('function computeReachable');
  const end = html.indexOf('function spawnFood');
  assert.ok(start > 0 && end > start, 'maze functions are present');
  const src = html.slice(start, end);
  const context = {grid:null, snake:null, dir:null, dirQueue:null, level:1, COLS:0, ROWS:0};
  context.idx = (x,y)=>y*context.COLS+x;
  context.inB = (x,y)=>x>=0&&y>=0&&x<context.COLS&&y<context.ROWS;
  vm.createContext(context);
  const decl = html.match(/const COLS=(\d+),ROWS=(\d+),CELL=(\d+);/);
  assert.ok(decl, 'grid constants');
  context.COLS = Number(decl[1]);
  context.ROWS = Number(decl[2]);
  vm.runInContext(src, context);
  return context;
}

function nearestWall(context, x, y){
  let best = 99;
  for(let wy=0;wy<context.ROWS;wy++)for(let wx=0;wx<context.COLS;wx++){
    if(!context.grid[wy*context.COLS+wx].wall)continue;
    best = Math.min(best, Math.max(Math.abs(x-wx), Math.abs(y-wy)));
  }
  return best;
}

test('18x18 grid fills a 540 play area', ()=>{
  assert.match(html, /const COLS=18,ROWS=18,CELL=30;/);
  assert.match(html, /const VIEW=COLS\*CELL;/);
  assert.match(html, /<canvas id="cv" width="540" height="540"><\/canvas>/);
  assert.match(html, /#stage\{[^}]*540px/);
  assert.equal(18*30, 540);
});

test('level 1 spawn is as far from walls as an 18x18 board allows', ()=>{
  const context = loadMaze();
  assert.equal(context.COLS, 18);
  assert.match(html, /const OPEN_LEN=5;/);
  assert.match(html, /const OPEN_CLEAR=6;/);
  for(let n=0;n<24;n++){
    context.level = 1;
    context.genMaze();
    assert.equal(context.snake.length, 5);
    assert.equal(context.dir.x, 1);
    assert.equal(context.dir.y, 0);
    assert.equal(context.snake[0].x, 10);
    assert.equal(context.snake[0].y, 8);
    assert.equal(context.snake[4].x, 6);
    assert.equal(context.snake[4].y, 8);
    let minClear = 99;
    for(const s of context.snake){
      const c = nearestWall(context, s.x, s.y);
      const border = Math.min(s.x, s.y, 17-s.x, 17-s.y);
      minClear = Math.min(minClear, c);
      assert.equal(c, border, `segment ${s.x},${s.y} clearance ${c} is tighter than the border (${border})`);
    }
    assert.equal(minClear, 6, 'tail should meet the border at the maximum even clearance');
    for(let x=11;x<=16;x++){
      assert.equal(context.grid[8*18+x].wall, false, `heading cell ${x} is blocked`);
    }
    assert.equal(context.grid[8*18+17].wall, true);
    assert.equal(nearestWall(context, 10, 8), 7, 'head should have 7 cells of heading before the border');
  }
});

test('a longer continue snake stays on the board', ()=>{
  const context = loadMaze();
  const cells = context.openSnake(10);
  assert.equal(cells.length, 10);
  assert.equal(cells[0].y, 8);
  for(const c of cells){
    assert.ok(c.x>=1&&c.x<=16, `cell ${c.x} is off the interior`);
    assert.equal(c.y, 8);
  }
  assert.equal(cells[0].x-cells[9].x, 9);
});
