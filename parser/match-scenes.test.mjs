import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {test} from "node:test";

const overlay = fs.readFileSync(new URL("../overlay/SPARK_Overlay.html",import.meta.url),"utf8");
const controller = fs.readFileSync(new URL("../SPARK.html",import.meta.url),"utf8");
const roster = fs.readFileSync(new URL("../shared/spark-live-roster.js",import.meta.url),"utf8");

function functions(source,names){
  return names.map(name=>{
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`,"m"));
    assert.ok(match,`Missing production function ${name}`);
    return match[0];
  }).join("\n");
}

function harness(main=false){
  const context = vm.createContext({console,Date,Map,Set});
  vm.runInContext(roster,context);
  const common = `
    let timerId = 0, renders = 0, heatmapSchedules = 0, loads = 0;
    const timers = new Map();
    function setTimeout(callback,delay){ const id = ++timerId; timers.set(id,{callback,delay}); return id; }
    function clearTimeout(id){ timers.delete(id); }
    const config = {};
    const video = {readyState:0,classList:{add(){},remove(){}},pause(){},load(){loads++;},
      getAttribute(){return "";},setAttribute(){},removeAttribute(){},play(){return new Promise(()=>{});}};
    function $(id){ return id === "stingerTransition" ? video : {classList:{add(){},remove(){}},offsetWidth:100}; }
    function render(){ renders++; }
    function renderObsOverlay(){ renders++; }
    function scheduleLiveRender(){ renders++; }
    function resetAllMaskTickers(){}
    function readConfig(){ return config; }
    function stingerBrowserPlayable(){ return !!config.stingerTransitionUrl; }
    function triggerFinalFade(){}
    function scheduleRecentReplayHeatmap(){ heatmapSchedules++; }
    function focusNameFromPayload(){ return ""; }
    function unlockLiveStatsIfFocused(){}
    function gameClockState(payload){ return {clock:payload?.Game?.TimeSeconds ?? null,overtime:false}; }
  `;
  if(main){
    vm.runInContext(`${common}
      let liveApiState = makeEmptyLiveApiState();
      let obsForceLiveOverlayAt = 0, obsForceLiveOverlayActive = false, liveRenderTimer = null;
      let isObsOverlayMode = false;
      function handleLiveUpdateState(){}
      ${functions(controller,["makeEmptyLiveApiState","firstDefined","valueByKey","toNumber","toBoolean",
        "liveApiMatchGuid","stableLiveSeed","resetLiveApiForNewMatch","syncLiveApiMatchBoundary",
        "livePayloadGame","liveApiReplayFlag","setLiveReplayActive","liveApiNextMatchStartEvent",
        "clearLivePostGameIfNextFieldState","liveApiGameEnded","markLiveMatchEnded","liveElapsedSeconds",
        "normalizeLiveApiMessage","updateLiveTeamsFromPayload","normalizeLiveTeam","extractLivePlayers",
        "handleLiveKickoffStart","handleLiveApiMessage"])}
      liveApiState.matchGuid = "old-match";
      liveApiState.lastKnownClock = 100;
      liveApiState.teams.Blue.score = 2;
      liveApiState.overlayRoster.sync([{PrimaryId:"a",Name:"Alice",TeamNum:0,bHasCar:true,Score:300}]);
      function send(Event,Data={}){ handleLiveApiMessage({Event,Data:{MatchGuid:"old-match",...Data}}); }
      function scene(){ return {phase:liveApiState.scenePhase,ended:liveApiState.matchEnded,
        guid:liveApiState.matchGuid,final:liveApiState.matchEnded,replay:liveApiState.replayActive,
        score:liveApiState.teams.Blue.score,players:liveApiState.finalOverlayPlayers?.length || 0}; }
    `,context);
  }else{
    const stateSource = overlay.match(/^const state = \{[^]*?^\};/m)[0];
    vm.runInContext(`${common}
      const liveRoster = new SparkLiveRoster();
      ${stateSource}
      let finalTransitionQueueTimer = null, finalTransitionTimer = null, stingerTimer = null;
      let stingerFallbackTimer = null, finalTransitionRunId = 0, finalTransitionPending = false;
      let replayHeatmapLookupTimer = null, replayHeatmapRevealTimer = null, replayHeatmapRunId = 0;
      let replaySpeedSwapTimer = null, replayBannerMarkup = "", forceLiveOverlayAt = 0, forceLiveOverlayActive = false;
      const forceLiveCommandWindowMs = 300000, personalOverlayMode = false, forceLiveStatsScreen = false;
      ${functions(overlay,["firstDefined","valueByKey","toNumber","toBoolean","cleanName","normalizeTeam",
        "extractPlayers","updateTeams","updatePlayers","replayFlag","matchEndedFlag","matchGuidFromPayload",
        "nextMatchStartEvent","nextMatchLooksReady","normalizeMessage","compactEventName","sortedFinalPlayers",
        "resetForNextMatch","transitionCutDelayMs","revealFinalScreen","preloadFinalTransition",
        "cancelFinalTransition","applyForceLiveOverlayCommand","queueFinalTransition",
        "beginNextMatchResetTransition","playFinalTransition","handleMessage"])}
      state.matchGuid = "old-match";
      state.teams.Blue.score = 2;
      updatePlayers({Players:[{PrimaryId:"a",Name:"Alice",TeamNum:0,bHasCar:true,Score:300}]});
      function send(Event,Data={}){ handleMessage({Event,Data:{MatchGuid:"old-match",...Data}}); }
      function scene(){ return {phase:state.scenePhase,ended:state.matchEnded,guid:state.matchGuid,
        final:state.finalVisible,replay:state.replay,score:state.teams.Blue.score,players:state.finalPlayers?.length || 0}; }
    `,context);
  }
  const run = code=>vm.runInContext(code,context);
  return {run,send:(event,data={})=>run(`send(${JSON.stringify(event)},${JSON.stringify(data)})`),scene:()=>JSON.parse(run("JSON.stringify(scene())"))};
}

for(const main of [false,true]){
  const label = main ? "controller" : "standalone";
  test(`${label}: lobby-looking packets cannot unlock a finished match`,()=>{
    const h = harness(main);
    h.send("MatchEnded");
    for(const event of ["UpdateState","SpectatorTargetChanged","CountdownBegin"]){
      h.send(event,{Game:{bHasWinner:false,TimeSeconds:300,bHasTarget:true,Countdown:3,Target:{Name:"Alice"}},
        Players:[{Name:"Alice",TeamNum:0,bHasCar:true,Boost:100}]});
      assert.equal(h.scene().ended,true);
      assert.equal(h.scene().guid,"old-match");
    }
  });

  test(`${label}: podium and lobby keep results until the next initialized match`,()=>{
    const h = harness(main);
    h.send("MatchEnded");
    h.send("PodiumStart");
    assert.equal(h.scene().phase,"podium");
    h.send("MatchDestroyed");
    assert.deepEqual(h.scene(),{phase:"lobby",ended:true,guid:"old-match",final:true,replay:false,score:2,players:1});
    h.send("GoalReplayStart");
    h.send("MatchCreated",{MatchGuid:"new-match"});
    h.send("UpdateState",{MatchGuid:"new-match",Game:{TimeSeconds:300,bHasWinner:false,bReplay:true}});
    assert.equal(h.scene().phase,"lobby");
    assert.equal(h.scene().guid,"old-match");
    h.send("MatchInitialized");
    assert.equal(h.scene().phase,"lobby","A duplicate initialized event for the finished game is stale");
    h.send("MatchInitialized",{MatchGuid:"new-match"});
    assert.equal(h.scene().phase,"live");
    assert.equal(h.scene().ended,false);
    assert.equal(h.scene().guid,"new-match");
    h.send("MatchEnded");
    assert.equal(h.scene().ended,false,"Late old-match end must not replace the new scene");
  });

  test(`${label}: missing end/podium events still cover lobby immediately`,()=>{
    for(const events of [["PodiumStart","MatchDestroyed"],["MatchDestroyed"]]){
      const h = harness(main);
      events.forEach(event=>h.send(event));
      assert.equal(h.scene().final,true);
      assert.equal(h.scene().phase,"lobby");
      assert.equal(h.scene().players,1);
    }
  });

  test(`${label}: only a new live round can substitute for a missed initialization`,()=>{
    const h = harness(main);
    h.send("MatchDestroyed");
    h.send("RoundStarted");
    assert.equal(h.scene().phase,"lobby");
    h.send("CountdownBegin",{MatchGuid:"new-match"});
    assert.equal(h.scene().phase,"lobby");
    h.send("MatchInitialized",{MatchGuid:"new-match",bReplay:true});
    assert.equal(h.scene().phase,"lobby");
    h.send("RoundStarted",{MatchGuid:"new-match"});
    assert.equal(h.scene().phase,"live");
  });

  test(`${label}: reconnect recovery needs clock progress in a confirmed different live game`,()=>{
    const h = harness(main);
    h.send("MatchDestroyed");
    const snapshot = clock=>({MatchGuid:"new-match",Players:[{Name:"Alice",TeamNum:0,bHasCar:true}],
      Game:{TimeSeconds:clock,bHasWinner:false,bReplay:false}});
    h.send("UpdateState",snapshot(300));
    h.send("UpdateState",snapshot(300));
    assert.equal(h.scene().phase,"lobby","Static lobby clocks are not a start signal");
    h.send("UpdateState",{...snapshot(299),Game:{...snapshot(299).Game,bReplay:true}});
    h.send("UpdateState",snapshot(299));
    assert.equal(h.scene().phase,"lobby","Replay snapshots cannot supply clock progress");
    h.send("UpdateState",snapshot(298));
    assert.equal(h.scene().phase,"live");
    assert.equal(h.scene().guid,"new-match");
  });
}

test("loading a stinger cannot be requeued by repeated postgame updates",()=>{
  const h = harness();
  h.run('config.stingerTransitionUrl = "transition.webm"');
  h.send("MatchEnded");
  h.send("PodiumStart");
  assert.equal(h.run("finalTransitionPending"),true);
  const loads = h.run("loads");
  for(let i=0;i<30;i++) h.send("UpdateState",{Game:{bHasWinner:true}});
  assert.equal(h.run("loads"),loads);
  h.send("MatchDestroyed");
  assert.equal(h.scene().final,true);
  assert.equal(h.run("finalTransitionPending"),false);
});

test("manual normal-overlay command still overrides the automatic lobby scene",()=>{
  const h = harness();
  h.send("MatchEnded");
  h.run("config.forceLiveOverlayAt = Date.now(); applyForceLiveOverlayCommand(config)");
  h.send("MatchDestroyed");
  assert.equal(h.scene().final,false);
});

test("postgame heatmap lookup retains its strict two-minute candidate window",()=>{
  const source = functions(overlay,["scheduleRecentReplayHeatmap"]);
  assert.match(source,/maxAgeMs:\s*"120000"/);
});
