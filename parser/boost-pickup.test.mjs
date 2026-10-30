import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {test} from "node:test";

const html = fs.readFileSync(new URL("../SPARK.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../static-download-server.mjs", import.meta.url), "utf8");

// Exercise the shipped HTML functions without starting its browser UI or sockets.
function functionSource(source, name){
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(match, `Missing production function ${name}`);
  return match[0];
}

function harness(){
  const context = vm.createContext({console, Date, Map, Set});
  const names = [
    "makeEmptyLiveApiState", "firstDefined", "valueByKey", "toNumber", "toBoolean",
    "cleanReplayName", "isBadReplayName", "liveApiMatchGuid", "stableLiveSeed",
    "syncLiveApiMatchBoundary", "resetLiveApiForNewMatch", "livePayloadGame",
    "liveApiReplayFlag", "liveApiPlayerName", "normalizeLiveTeam", "vectorFromApi",
    "ensureLivePlayer", "liveElapsedSeconds", "handleLiveBoostPickup",
    "pickupFieldCoord", "nearestBoostPadIndexFromCoord", "pickupPadIndex",
    "playerBoostPickups", "boostPickupCounts", "boostPickupTotals", "largeBoostSteals",
    "supersonicBoostUsed", "boostManagementMetrics", "liveApiDashboardActive",
    "normalizeLiveApiMessage", "handleLiveApiMessage", "livePlayersForBuildData",
    "applyLiveApiMetricsToData"
  ];
  const coordinates = html.match(/const standardBoostPadCoords = \[[^]*?\n\];/)[0];
  vm.runInContext(`${coordinates}
    const boostPadLayout = standardBoostPadCoords.map((pad,index)=>({...pad,index}));
    let liveApiState = makeEmptyLiveApiState();
    let liveApiSocket = {}, isObsOverlayMode = false, liveRenderTimer = null;
    let obsForceLiveOverlayAt = 0, obsForceLiveOverlayActive = false;
    let data = null, renders = 0;
    function scheduleLiveRender(){ renders++; }
    function scaleRating(){ return 0; }
    ${names.map(name=>functionSource(html, name)).join("\n")}
  `, context);
  return code=>vm.runInContext(code, context);
}

const pickup = (overrides={})=>({
  MatchGuid:"match-one", Player:{Name:"Alice", TeamNum:0},
  Location:{X:-3072, Y:4096, Z:73},
  BoostType:"BoostType_Pill", BoostAmount:7, bReplay:false,
  ...overrides
});

function send(run, payload){
  return run(`handleLiveApiMessage(${JSON.stringify({Event:"BoostPickup", Data:payload})})`);
}

test("official events drive live player, team map and management counters", ()=>{
  const run = harness();
  send(run, pickup());
  send(run, pickup({BoostType:"BoostType_Pad", BoostAmount:12, Location:{X:0,Y:-4240,Z:70}}));
  // A partial large pickup is still a large pad; zero granted boost still counts.
  send(run, pickup({BoostAmount:0}));
  send(run, pickup({Player:{Name:"Bobby",TeamNum:1}, Location:{X:3072,Y:-4096,Z:73}}));
  const result = JSON.parse(run(`JSON.stringify((()=>{
    const ps = [...liveApiState.players.values()];
    const scope = {ps};
    return {totals:boostPickupTotals(scope), stolen:largeBoostSteals(scope),
      pad29:boostPickupCounts(scope)[29].count, pad0:boostPickupCounts(scope)[0].count,
      metrics:boostManagementMetrics(scope).slice(0,3).map(metric=>metric.value),
      alice:boostPickupTotals({ps:[ps[0]]}), renders};
  })())`));
  assert.deepEqual(result.totals, {total:4,large:3,small:1,exact:4,collected:26});
  assert.deepEqual(result.metrics, [1,3,3]);
  assert.equal(result.stolen, 3);
  assert.equal(result.pad29, 2);
  assert.equal(result.pad0, 1);
  assert.equal(result.alice.total, 3);
  assert.equal(result.renders, 4);
});

test("replay, ended, foreign-match and malformed events cannot alter match state", ()=>{
  const run = harness();
  run('liveApiState.matchGuid = "match-one"');
  for(const bad of [
    {bReplay:true}, {MatchGuid:"different-match"}, {Player:{}},
    {Location:{}}, {Location:{X:"invalid",Y:0}}, {BoostType:"unknown"}
  ]) send(run, pickup(bad));
  assert.equal(run("liveApiState.players.size"), 0);
  assert.equal(run("liveApiState.matchGuid"), "match-one");
  run("liveApiState.replayActive = true");
  send(run, pickup({bReplay:undefined}));
  assert.equal(run("liveApiState.players.size"), 0);
  // The explicit event flag takes precedence over a delayed replay-state update.
  send(run, pickup());
  assert.equal(run('liveApiState.players.get("Alice").boostPickups.length'), 1);
  run("liveApiState.matchEnded = true");
  send(run, pickup());
  assert.equal(run('liveApiState.players.get("Alice").boostPickups.length'), 1);
  assert.equal(run("liveApiState.matchEnded"), true);
});

test("dashboard rebuild preserves pickups and a new match clears them", ()=>{
  const run = harness();
  send(run, pickup());
  assert.equal(run("livePlayersForBuildData()[0].boostPickups.length"), 1);
  run('data = {players:[{name:"Alice"}]}; applyLiveApiMetricsToData()');
  assert.equal(run("data.players[0].boostPickups.length"), 1);
  run("applyLiveApiMetricsToData()");
  assert.equal(run("data.players[0].boostPickups.length"), 1);
  run('resetLiveApiForNewMatch("match-two")');
  assert.equal(run("liveApiState.players.size"), 0);
  send(run, pickup({MatchGuid:"match-two"}));
  assert.equal(run('liveApiState.players.get("Alice").boostPickups.length'), 1);
});

test("saved replay pickups remain supported and aliases are not double-counted", ()=>{
  const run = harness();
  const totals = JSON.parse(run(`JSON.stringify(boostPickupTotals({ps:[{
    boostPickups:[{padIndex:3,type:"large"}], boostPadPickups:[{padIndex:3,type:"large"}]
  }, {boostPadPickups:[{padIndex:0,type:"small"}]}]}))`));
  assert.deepEqual(totals, {total:2,large:1,small:1,exact:2,collected:112});
  assert.equal(run("pickupPadIndex({padIndex:null})"), null);
  assert.equal(run("boostPickupTotals({ps:[{boostPickups:[],boostPadPickups:[{padIndex:3}]}]}).total"), 0);
});

test("unmapped locations are counted but never pinned to a guessed pad", ()=>{
  const run = harness();
  send(run, pickup({Location:{X:10000,Y:10000,Z:0}}));
  assert.equal(run('boostPickupTotals({ps:[...liveApiState.players.values()]}).total'), 1);
  assert.equal(run('boostPickupCounts({ps:[...liveApiState.players.values()]}).reduce((sum,pad)=>sum+pad.count,0)'), 0);
});

test("bridge broadcasts pickups and contacts without replaying them on reconnect", ()=>{
  const context = vm.createContext({Buffer});
  vm.runInContext(`
    let liveApiLatestMessage = null;
    const sent = [];
    const liveApiClients = new Set([{}]);
    function sendLiveApiWebSocketText(socket,text){ sent.push(text); }
    ${functionSource(server, "liveApiMessageEventName")}
    ${functionSource(server, "broadcastLiveApiMessage")}
    broadcastLiveApiMessage('{"Event":"UpdateState","Data":{}}');
    broadcastLiveApiMessage('{"Event":"BoostPickup","Data":{}}');
    broadcastLiveApiMessage('{"Event":"BallHit","Data":{}}');
  `, context);
  assert.equal(vm.runInContext("sent.length", context), 3);
  assert.equal(vm.runInContext("JSON.parse(liveApiLatestMessage).Event", context), "UpdateState");
});
