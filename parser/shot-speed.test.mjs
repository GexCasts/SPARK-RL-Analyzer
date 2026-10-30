import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {test} from "node:test";

const html = fs.readFileSync(new URL("../SPARK.html", import.meta.url), "utf8");

function harness(){
  const names = [
    "makeEmptyLiveApiState", "firstDefined", "valueByKey", "toNumber", "toBoolean",
    "cleanReplayName", "isBadReplayName", "liveApiMatchGuid", "stableLiveSeed",
    "syncLiveApiMatchBoundary", "livePayloadGame", "liveApiReplayFlag", "liveApiPlayerName",
    "normalizeLiveTeam", "vectorFromApi", "ensureLivePlayer", "liveElapsedSeconds",
    "nonNegativeBallSpeed", "handleLiveBallHit", "recordLiveKickoffTouch", "addLiveTimelineEvent",
    "lastLiveHitForPlayer", "liveShotContactForPlayer", "handleLiveCrossbar", "handleLiveGoal",
    "goalFaceFromImpactLocation", "distanceFromHitToOpponentNet", "targetFromGoalFacePosition",
    "getFrameAccurateShootingSamples", "normalizeShotResult", "optionalBallSpeedText",
    "formatSpeedFromUUPerSecond"
  ];
  const context = vm.createContext({console, Date, Map, Set});
  const functions = names.map(name=>{
    const match = html.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, `Missing production function ${name}`);
    return match[0];
  });
  vm.runInContext(`
    let liveApiState = makeEmptyLiveApiState(), useImperialUnits = false;
    liveApiState.lastKnownClock = 190;
    function normalizeShotFaceForDisplay(shot,result,x,y){ return {x,y,target:"test"}; }
    function scoreboardElapsedFromSample(){ return null; }
    function scoreboardClockFromSample(){ return null; }
    function shotClockFromElapsed(){ return "3:10"; }
    function replayObservedDurationSeconds(){ return 300; }
    function playerDisplayName(player){ return player.name; }
    ${functions.join("\n")}
  `, context);
  return code=>vm.runInContext(code, context);
}

function hit(run, overrides={}){
  const payload = {
    MatchGuid:"match-one", Players:[{Name:"Alice",TeamNum:0}],
    Ball:{Location:{X:0,Y:1000,Z:200},PreHitSpeed:900,PostHitSpeed:2000},
    ...overrides
  };
  return run(`handleLiveBallHit(${JSON.stringify(payload)})`);
}

function crossbar(run, overrides={}){
  const payload = {
    BallLastTouch:{Player:{Name:"Alice",TeamNum:0}},
    BallLocation:{X:0,Y:5120,Z:640}, BallSpeed:1400,
    ...overrides
  };
  run(`handleLiveCrossbar(${JSON.stringify(payload)})`);
  return JSON.parse(run('JSON.stringify(liveApiState.players.get("Alice").shotSamples.at(-1))'));
}

test("touches do not become shots; crossbar misses use outgoing rather than impact speed", ()=>{
  const run = harness();
  hit(run);
  assert.equal(run('liveApiState.players.get("Alice").shotSamples.length'), 0);
  const sample = crossbar(run);
  assert.equal(sample.ballSpeed, 2000);
  assert.equal(sample.ballSpeedSource, "live-api post-hit speed");
  assert.equal(sample.preHitSpeedUUPerSecond, undefined);
  assert.equal(sample.ballSpeedChangeUUPerSecond, undefined);
  assert.equal(run("optionalBallSpeedText(2000)"), "72 kmph");
  run("useImperialUnits = true");
  assert.equal(run("optionalBallSpeedText(2000)"), "45 mph");
});

test("stale, intervening, contested and previous-round touches are not attributed", ()=>{
  for(const change of [
    run=>hit(run,{Players:[{Name:"Bobby",TeamNum:1}]}),
    run=>hit(run,{Players:[{Name:"Alice",TeamNum:0},{Name:"Bobby",TeamNum:1}]}),
    run=>run("liveApiState.kickoffStarts.push({elapsedSeconds:111})")
  ]){
    const run = harness();
    hit(run);
    change(run);
    assert.equal(crossbar(run).ballSpeed, 1400);
  }
});

test("missing speed falls back to reported crossbar speed, never an unrelated state sample", ()=>{
  const run = harness();
  hit(run,{Ball:{Location:{X:0,Y:1000,Z:200},PostHitSpeed:null}});
  assert.equal(crossbar(run).ballSpeed, 1400);
  run("liveApiState.lastBallSpeed = 9999");
  assert.equal(crossbar(run,{BallSpeed:null}).ballSpeed, null);
});

test("replay, ended and foreign-match ball contacts are ignored", ()=>{
  const run = harness();
  hit(run);
  assert.equal(hit(run,{bReplay:true}), false);
  assert.equal(hit(run,{MatchGuid:"different-match"}), false);
  run("liveApiState.replayActive = true");
  assert.equal(hit(run), false);
  run("liveApiState.replayActive = false; liveApiState.matchEnded = true");
  assert.equal(hit(run), false);
  assert.equal(run("liveApiState.ballHits.length"), 1);
});

test("misses prefer explicit post-hit speeds, including zero; goals and saves stay unchanged", ()=>{
  const run = harness();
  const results = JSON.parse(run(`JSON.stringify(getFrameAccurateShootingSamples({ps:[{
    name:"Alice", id:1, team:"Blue", shotSamples:[
      {result:"miss",xPercent:110,yPercent:30,ballSpeed:1000,postHitSpeedUUPerSecond:2000},
      {result:"post",xPercent:50,yPercent:0,ballSpeed:1000,postHitSpeedUUPerSecond:0},
      {result:"goal",xPercent:50,yPercent:50,ballSpeed:1500,postHitSpeedUUPerSecond:2000},
      {result:"save",xPercent:50,yPercent:50,ballSpeed:1700,postHitSpeedUUPerSecond:2000},
      {result:"miss",xPercent:110,yPercent:30,ballSpeed:1200,postHitSpeedUUPerSecond:null}
    ]
  }]}).map(sample=>sample.ballSpeed))`));
  assert.deepEqual(results, [2000,0,1500,1700,1200]);
});

test("goal speed is unchanged even when a matching ball-contact speed exists", ()=>{
  const run = harness();
  hit(run);
  run('handleLiveGoal({Scorer:{Name:"Alice",TeamNum:0},ImpactLocation:{X:0,Y:5120,Z:200},GoalSpeed:1500})');
  assert.equal(run('liveApiState.players.get("Alice").shotSamples[0].ballSpeed'), 1500);
});
