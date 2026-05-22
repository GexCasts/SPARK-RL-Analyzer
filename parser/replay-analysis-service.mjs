import {sparkAnalysisContractVersion} from "../shared/spark-data-contract.mjs";

function number(value, fallback=0){
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function array(value){
  return Array.isArray(value) ? value : [];
}

function teamKey(value){
  const text = String(value || "").toLowerCase();
  if(text.includes("blue")) return "Blue";
  if(text.includes("orange")) return "Orange";
  return null;
}

function playerTeam(player){
  return teamKey(player?.team || player?.stats?.team) || "Unknown";
}

function playerStat(player, key){
  return number(player?.stats?.[key] ?? player?.[key], 0);
}

function eventElapsed(event){
  return number(event?.elapsedSeconds ?? event?.scoreboardElapsedSeconds ?? event?.time, 0);
}

function compactEvent(type, player, event, extra={}){
  return {
    type,
    player: player.name,
    team: playerTeam(player),
    elapsedSeconds: eventElapsed(event),
    scoreboardSecondsRemaining: Number.isFinite(Number(event?.scoreboardSecondsRemaining)) ? Number(event.scoreboardSecondsRemaining) : null,
    isOvertime: !!event?.isOvertime,
    ...extra
  };
}

function playerAnalysis(player, durationSeconds){
  const boostPickups = array(player.boostPickups);
  const shotSamples = array(player.shotSamples);
  const touchEvents = array(player.touchEvents);
  const demoEvents = array(player.demoEvents);
  const bumpEvents = array(player.bumpEvents);
  const distanceSamples = array(player.distanceToBallSamples);
  const positionSamples = array(player.positionSamples);
  const largeBoostPickups = boostPickups.filter(pickup=>pickup?.type === "large").length;
  const smallBoostPickups = boostPickups.filter(pickup=>pickup?.type === "small").length;
  const goals = playerStat(player, "goals");
  const shots = playerStat(player, "shots");
  const shootingPercentage = shots > 0 ? Math.round((goals / shots) * 1000) / 10 : 0;
  const averageDistanceUU = distanceSamples.length
    ? Math.round(distanceSamples.reduce((sum, sample)=>sum + number(sample.distanceUU, 0), 0) / distanceSamples.length)
    : null;
  const elapsedValues = [
    ...boostPickups,
    ...shotSamples,
    ...touchEvents,
    ...demoEvents,
    ...bumpEvents,
    ...distanceSamples,
    ...positionSamples
  ].map(eventElapsed).filter(value=>Number.isFinite(value) && value >= 0);

  return {
    durationSeconds,
    sampleCounts:{
      boosts:boostPickups.length,
      shots:shotSamples.length,
      touches:touchEvents.length,
      demos:demoEvents.length,
      bumps:bumpEvents.length,
      distance:distanceSamples.length,
      positions:positionSamples.length
    },
    boost:{
      totalPickups:boostPickups.length,
      largePickups:largeBoostPickups,
      smallPickups:smallBoostPickups,
      supersonicUsed:number(player.supersonicBoostUsed ?? player.boostUsedWhileSupersonic, 0)
    },
    shooting:{
      goals,
      shots,
      shootingPercentage,
      exactSamples:shotSamples.length,
      goalsFromSamples:shotSamples.filter(shot=>shot?.result === "goal").length,
      savesFromSamples:shotSamples.filter(shot=>shot?.result === "save").length,
      missesFromSamples:shotSamples.filter(shot=>shot?.result === "miss").length
    },
    physical:{
      demos:demoEvents.length || playerStat(player, "demos"),
      bumps:bumpEvents.length || playerStat(player, "bumps")
    },
    positioning:{
      samples:positionSamples.length,
      averageDistanceToBallUU:averageDistanceUU
    },
    firstElapsedSeconds:elapsedValues.length ? Math.min(...elapsedValues) : null,
    lastElapsedSeconds:elapsedValues.length ? Math.max(...elapsedValues) : null
  };
}

function buildTeams(players){
  const teams = {
    Blue:{name:"Blue",players:[],stats:{score:0,goals:0,shots:0,assists:0,saves:0,demos:0,bumps:0,touches:0,boostPickups:0,largeBoostPickups:0,smallBoostPickups:0}},
    Orange:{name:"Orange",players:[],stats:{score:0,goals:0,shots:0,assists:0,saves:0,demos:0,bumps:0,touches:0,boostPickups:0,largeBoostPickups:0,smallBoostPickups:0}},
    Unknown:{name:"Unknown",players:[],stats:{score:0,goals:0,shots:0,assists:0,saves:0,demos:0,bumps:0,touches:0,boostPickups:0,largeBoostPickups:0,smallBoostPickups:0}}
  };

  for(const player of players){
    const key = playerTeam(player);
    const team = teams[key] || teams.Unknown;
    team.players.push(player.name);
    team.stats.score += playerStat(player, "score");
    team.stats.goals += playerStat(player, "goals");
    team.stats.shots += playerStat(player, "shots");
    team.stats.assists += playerStat(player, "assists");
    team.stats.saves += playerStat(player, "saves");
    team.stats.demos += array(player.demoEvents).length || playerStat(player, "demos");
    team.stats.bumps += array(player.bumpEvents).length || playerStat(player, "bumps");
    team.stats.touches += array(player.touchEvents).length || playerStat(player, "touches");
    team.stats.boostPickups += array(player.boostPickups).length;
    team.stats.largeBoostPickups += array(player.boostPickups).filter(pickup=>pickup?.type === "large").length;
    team.stats.smallBoostPickups += array(player.boostPickups).filter(pickup=>pickup?.type === "small").length;
  }

  return teams;
}

function buildEventTimeline(players){
  const events = [];
  for(const player of players){
    array(player.shotSamples).forEach(shot=>{
      events.push(compactEvent(`shot:${shot?.result || "unknown"}`, player, shot, {
        result:shot?.result || null,
        xPercent:Number.isFinite(Number(shot?.xPercent)) ? Number(shot.xPercent) : null,
        yPercent:Number.isFinite(Number(shot?.yPercent)) ? Number(shot.yPercent) : null
      }));
    });
    array(player.touchEvents).forEach(touch=>events.push(compactEvent("touch", player, touch)));
    array(player.demoEvents).forEach(demo=>events.push(compactEvent("demo", player, demo, {victimName:demo?.victimName || null})));
    array(player.bumpEvents).forEach(bump=>events.push(compactEvent("bump", player, bump, {victimName:bump?.victimName || null})));
    array(player.boostPickups).forEach(pickup=>events.push(compactEvent("boost", player, pickup, {
      padIndex:Number.isFinite(Number(pickup?.padIndex)) ? Number(pickup.padIndex) : null,
      boostType:pickup?.type || null
    })));
  }

  return events
    .filter(event=>Number.isFinite(event.elapsedSeconds))
    .sort((a,b)=>a.elapsedSeconds - b.elapsedSeconds)
    .map((event, index)=>({...event, index}));
}

function buildDataQuality(summary, players){
  const totalPositionSamples = number(summary.totalPositionSamples, players.reduce((sum, player)=>sum + array(player.positionSamples).length, 0));
  const totalDistanceSamples = number(summary.totalDistanceSamples, players.reduce((sum, player)=>sum + array(player.distanceToBallSamples).length, 0));
  const totalShotSamples = number(summary.totalShotSamples, players.reduce((sum, player)=>sum + array(player.shotSamples).length, 0));
  const totalBoostPickups = number(summary.totalBoostPickups, players.reduce((sum, player)=>sum + array(player.boostPickups).length, 0));
  return {
    hasPositions:totalPositionSamples > 0,
    hasDistances:totalDistanceSamples > 0,
    hasShots:totalShotSamples > 0,
    hasBoostPickups:totalBoostPickups > 0,
    totals:{
      positionSamples:totalPositionSamples,
      distanceSamples:totalDistanceSamples,
      shotSamples:totalShotSamples,
      boostPickups:totalBoostPickups,
      touchEvents:number(summary.totalTouchEvents, players.reduce((sum, player)=>sum + array(player.touchEvents).length, 0)),
      demoEvents:number(summary.totalDemoEvents, players.reduce((sum, player)=>sum + array(player.demoEvents).length, 0)),
      bumpEvents:number(summary.totalBumpEvents, players.reduce((sum, player)=>sum + array(player.bumpEvents).length, 0))
    }
  };
}

export function createReplayAnalysisPackage(summary, options={}){
  const players = array(summary?.players).map(player=>({...player}));
  const durationSeconds = number(summary?.durationSeconds, 300);
  const teams = buildTeams(players);
  const eventTimeline = buildEventTimeline(players);
  const playerAnalyses = {};
  for(const player of players){
    player.analysis = playerAnalysis(player, durationSeconds);
    playerAnalyses[player.name] = player.analysis;
  }

  return {
    ...summary,
    parser: summary?.parser || "rrrocket",
    processingMode:"backend-analysis",
    analysisContractVersion:sparkAnalysisContractVersion,
    generatedAtUtc:new Date().toISOString(),
    players,
    teams,
    analysis:{
      version:sparkAnalysisContractVersion,
      source:options.source || "rrrocket",
      durationSeconds,
      hasOvertime:!!summary?.hasOvertime,
      dataQuality:buildDataQuality(summary || {}, players),
      players:playerAnalyses,
      teams,
      eventTimeline
    }
  };
}
