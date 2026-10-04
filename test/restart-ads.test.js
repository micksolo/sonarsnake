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

function loadAds(){
  const names = [
    'beginAdHold', 'clearAdLeave', 'finishShownAd', 'declineRewardOffer', 'acceptReward',
    'endAdHold', 'placementProps', 'noteSession', 'offerContinueAd', 'reviveRun',
    'openSnake', 'borderClear', 'carveOpen', 'beginRun', 'newGame'
  ];
  const grace = html.match(/const START_GRACE=\d+(?:\.\d+)?;/);
  assert.ok(grace, 'start grace constant');
  const src = [
    'const COLS=18,ROWS=18;',
    'const OPEN_LEN=5;',
    'const OPEN_CLEAR=6;',
    grace[0],
    'const idx=(x,y)=>y*COLS+x;',
    ...names.map((name) => extract(html, name))
  ].join('\n');
  const events = [];
  const breaks = [];
  const context = {
    Math,
    Date,
    events,
    breaks,
    track(name, props){ events.push({ name, props: props || {} }); },
    adHold: false,
    adHoldStarted: 0,
    adHoldAccum: 0,
    adBreakBusy: false,
    rewardGen: 0,
    rewardShow: null,
    adOfferOpen: false,
    adLeave: null,
    adsReady: true,
    leaveTracked: false,
    sessionStartT: 1_000,
    runStats: null,
    state: 'dead',
    lastRunEndT: 500,
    level: 1,
    score: 20,
    runCount: 1,
    grid: null,
    snake: [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }],
    dir: { x: 1, y: 0 },
    dirQueue: [],
    flashes: 3,
    deathT: 1,
    deathPanelShown: true,
    foods: 1,
    moveInterval: 260,
    moveAcc: 0,
    flashHold: 0,
    pings: [],
    flashT: 0,
    beaconT: 0,
    submitted: false,
    muted: false,
    panel: { hidden: false },
    pbtnreward: { hidden: true },
    scoreEl: { textContent: '20' },
    levelEl: { textContent: '1' },
    hidePanel(){ context.panel.hidden = true; },
    genMaze(){},
    spawnFood(){},
    updateFlashHUD(){},
    flash(){},
    tone(){}
  };
  context.window = {
    adBreak(cfg){ breaks.push(cfg); }
  };
  context.grid = [];
  for (let y = 0; y < 18; y++){
    for (let x = 0; x < 18; x++){
      context.grid.push({ wall: x === 0 || y === 0 || x === 17 || y === 17, reveal: 0, seen: false });
    }
  }
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

function named(context, name){
  return context.events.filter((ev) => ev.name === name);
}

test('the client no longer requests an interstitial before a new run', () => {
  assert.equal(html.includes('requestInterstitialThen'), false);
  assert.equal(html.includes('restart-game'), false);
  assert.equal(html.includes("type:'next'"), false);
  assert.equal(html.includes("name:'continue-run'"), true);
  assert.equal(html.includes("type:'reward'"), true);
  const update = extract(html, 'update');
  assert.match(update, /score>0&&!submitted&&!deathPanelShown/);
  const restart = extract(html, 'newGame');
  assert.match(restart, /beginRun\(\)/);
  assert.doesNotMatch(restart, /adBreak\(|interstitial|type:'next'|requestInterstitialThen/);
});

test('a restart, including the first one after a scored death, goes straight into play', () => {
  const game = loadAds();
  game.offerContinueAd();
  assert.equal(game.breaks.length, 1);
  game.breaks[0].beforeReward(() => {});
  assert.equal(named(game, 'ad_offer').length, 1);
  game.newGame();
  assert.equal(game.breaks.length, 1);
  assert.equal(game.breaks[0].type, 'reward');
  assert.equal(game.state, 'playing');
  assert.equal(named(game, 'run_start').length, 1);
  assert.equal(named(game, 'ad_dismiss')[0].props.reason, 'skipped');
  assert.equal(named(game, 'ad_leave').length, 0);
  game.breaks[0].beforeReward(() => {});
  game.breaks[0].adBreakDone({ breakType: 'reward', breakName: 'continue-run', breakStatus: 'ignored' });
  assert.equal(game.state, 'playing');
  assert.equal(game.adHold, false);
  assert.equal(named(game, 'ad_offer').length, 1);

  game.state = 'dead';
  game.score = 12;
  game.adHold = false;
  game.offerContinueAd();
  assert.equal(game.breaks.length, 2);
  assert.equal(game.breaks[1].type, 'reward');
  assert.equal(game.breaks[1].name, 'continue-run');
});

test('a rewarded continue still requires an opt-in and a scored death', () => {
  const game = loadAds();
  game.score = 0;
  game.offerContinueAd();
  assert.equal(game.breaks.length, 0);
  assert.equal(game.pbtnreward.hidden, true);

  game.score = 30;
  game.adsReady = false;
  game.offerContinueAd();
  assert.equal(game.breaks.length, 0);

  game.adsReady = true;
  game.offerContinueAd();
  const placement = game.breaks[0];
  assert.equal(placement.type, 'reward');
  assert.equal(placement.name, 'continue-run');
  let showed = 0;
  placement.beforeReward(() => { showed++; });
  assert.equal(game.pbtnreward.hidden, false);
  game.acceptReward();
  assert.equal(showed, 1);
  assert.equal(named(game, 'ad_accept').length, 1);
  placement.beforeAd();
  assert.equal(game.adHold, true);
  assert.equal(named(game, 'before_ad').length, 1);
  placement.adViewed();
  assert.equal(game.state, 'playing');
  assert.equal(named(game, 'ad_reward').length, 1);
  placement.afterAd();
  placement.adBreakDone({ breakStatus: 'viewed', breakFormat: 'reward' });
  assert.equal(game.adHold, false);
  assert.equal(game.adLeave, null);
  game.noteSession('pagehide');
  assert.equal(named(game, 'ad_leave').length, 0);
  assert.equal(named(game, 'abandon')[0].props.duringAd, false);
  assert.equal(named(game, 'abandon')[0].props.afterAd, false);
  assert.equal(named(game, 'session_end')[0].props.duringAd, false);
});

test('skipping or dismissing the rewarded ad stays on game over', () => {
  const game = loadAds();
  game.offerContinueAd();
  const placement = game.breaks[0];
  placement.beforeReward(() => {});
  game.acceptReward();
  placement.beforeAd();
  placement.adDismissed();
  placement.afterAd();
  placement.adBreakDone({ breakStatus: 'dismissed', breakFormat: 'reward' });
  assert.equal(game.state, 'dead');
  assert.equal(named(game, 'ad_reward').length, 0);
  assert.equal(named(game, 'ad_dismiss')[0].props.reason, 'ad');
  assert.equal(game.adLeave.phase, 'after');
  game.newGame();
  assert.equal(game.state, 'playing');
  assert.equal(game.adLeave, null);
  game.noteSession('pagehide');
  assert.equal(named(game, 'ad_leave').length, 0);
});

test('closing the tab during an ad, or after it with no new run, is a leave', () => {
  const during = loadAds();
  during.offerContinueAd();
  during.breaks[0].beforeReward(() => {});
  during.acceptReward();
  during.breaks[0].beforeAd();
  during.noteSession('pagehide');
  const left = named(during, 'ad_leave')[0];
  assert.equal(left.props.when, 'during');
  assert.equal(left.props.startedRun, false);
  assert.equal(left.props.breakName, 'continue-run');
  assert.equal(named(during, 'abandon')[0].props.duringAd, true);
  assert.equal(named(during, 'session_end')[0].props.duringAd, true);
  assert.equal(named(during, 'ad_dismiss').length, 0);

  const after = loadAds();
  after.offerContinueAd();
  after.breaks[0].beforeReward(() => {});
  after.acceptReward();
  after.breaks[0].beforeAd();
  after.breaks[0].adDismissed();
  after.breaks[0].adBreakDone({ breakStatus: 'dismissed' });
  assert.equal(after.state, 'dead');
  after.noteSession('pagehide');
  assert.equal(named(after, 'ad_leave')[0].props.when, 'after');
  assert.equal(named(after, 'ad_leave')[0].props.startedRun, false);
  assert.equal(named(after, 'abandon')[0].props.afterAd, true);
  assert.equal(named(after, 'session_end')[0].props.afterAd, true);
  assert.equal(named(after, 'run_start').length, 0);

  const offer = loadAds();
  offer.offerContinueAd();
  offer.breaks[0].beforeReward(() => {});
  offer.noteSession('pagehide');
  assert.equal(named(offer, 'ad_dismiss')[0].props.reason, 'left');
  assert.equal(named(offer, 'ad_leave').length, 0);
  assert.equal(named(offer, 'before_ad').length, 0);
});

test('a stale reward break cannot release a newer ad or start a run over it', () => {
  const game = loadAds();
  game.offerContinueAd();
  const first = game.breaks[0];
  first.beforeReward(() => {});
  game.newGame();
  game.state = 'dead';
  game.score = 18;
  game.adHold = false;
  game.offerContinueAd();
  const second = game.breaks[1];
  second.beforeReward(() => {});
  game.acceptReward();
  second.beforeAd();
  assert.equal(game.adHold, true);
  first.adBreakDone({ breakStatus: 'ignored' });
  first.adDismissed();
  assert.equal(game.adHold, true);
  assert.equal(game.state, 'dead');
  game.newGame();
  assert.equal(game.state, 'dead');
  assert.equal(named(game, 'run_start').length, 1);
});
