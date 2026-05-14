import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here;
const appFileName = "SPARK.html";
const logoPath = path.join(here, "assets", "Spark Logo.png");
const rrrocketPath = path.join(here, "tools", "rrrocket", "rrrocket-0.11.1-x86_64-pc-windows-msvc", "rrrocket.exe");
const tmpDir = path.join(here, ".tmp");
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".png", "image/png"],
  [".json", "application/json"]
]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const standardBoostPadCoords = [
  {fieldX:0,fieldY:-4240,type:"small"},
  {fieldX:-1792,fieldY:-4184,type:"small"},
  {fieldX:1792,fieldY:-4184,type:"small"},
  {fieldX:-3072,fieldY:-4096,type:"large"},
  {fieldX:3072,fieldY:-4096,type:"large"},
  {fieldX:-940,fieldY:-3308,type:"small"},
  {fieldX:940,fieldY:-3308,type:"small"},
  {fieldX:0,fieldY:-2816,type:"small"},
  {fieldX:-3584,fieldY:-2484,type:"small"},
  {fieldX:3584,fieldY:-2484,type:"small"},
  {fieldX:-1788,fieldY:-2300,type:"small"},
  {fieldX:1788,fieldY:-2300,type:"small"},
  {fieldX:-2048,fieldY:-1036,type:"small"},
  {fieldX:0,fieldY:-1024,type:"small"},
  {fieldX:2048,fieldY:-1036,type:"small"},
  {fieldX:-3584,fieldY:0,type:"large"},
  {fieldX:-1024,fieldY:0,type:"small"},
  {fieldX:1024,fieldY:0,type:"small"},
  {fieldX:3584,fieldY:0,type:"large"},
  {fieldX:-2048,fieldY:1036,type:"small"},
  {fieldX:0,fieldY:1024,type:"small"},
  {fieldX:2048,fieldY:1036,type:"small"},
  {fieldX:-1788,fieldY:2300,type:"small"},
  {fieldX:1788,fieldY:2300,type:"small"},
  {fieldX:-3584,fieldY:2484,type:"small"},
  {fieldX:3584,fieldY:2484,type:"small"},
  {fieldX:0,fieldY:2816,type:"small"},
  {fieldX:-940,fieldY:3308,type:"small"},
  {fieldX:940,fieldY:3308,type:"small"},
  {fieldX:-3072,fieldY:4096,type:"large"},
  {fieldX:3072,fieldY:4096,type:"large"},
  {fieldX:-1792,fieldY:4184,type:"small"},
  {fieldX:1792,fieldY:4184,type:"small"},
  {fieldX:0,fieldY:4240,type:"small"}
];

function readRequestBody(req, limitBytes=128 * 1024 * 1024){
  return new Promise((resolve, reject)=>{
    const chunks = [];
    let size = 0;
    req.on("data", chunk=>{
      size += chunk.length;
      if(size > limitBytes){
        reject(new Error("Replay upload is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", ()=>resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runRrrocket(replayPath){
  return new Promise((resolve, reject)=>{
    execFile(rrrocketPath, ["--network-parse", replayPath], {maxBuffer: 512 * 1024 * 1024}, (err, stdout, stderr)=>{
      if(err){
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function getObject(obj, key){
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function decodeActorLocation(value){
  const rigidBody = getObject(value, "RigidBody");
  const loc = getObject(value, "location") || getObject(value, "Location") || getObject(rigidBody, "location") || getObject(rigidBody, "Location");
  if(!loc || typeof loc !== "object") return null;
  const x = Number(getObject(loc, "x") ?? getObject(loc, "X"));
  const y = Number(getObject(loc, "y") ?? getObject(loc, "Y"));
  const z = Number(getObject(loc, "z") ?? getObject(loc, "Z") ?? 0);
  if(!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {x, y, z};
}

function extractActorReference(value){
  if(value == null) return null;
  if(Number.isInteger(value)) return value;
  if(typeof value !== "object") return null;
  const actor = getObject(value, "actor");
  if(Number.isInteger(actor)) return actor;
  const activeActor = getObject(value, "ActiveActor");
  if(activeActor && Number.isInteger(getObject(activeActor, "actor"))) return activeActor.actor;
  return null;
}

function cleanName(name){
  return String(name || "").replace(/\0/g, "").trim();
}

function nearestBoostPadIndex(coord){
  if(!coord) return null;
  const best = nearestBoostPadMatch(coord);
  return best && best.distance <= 900 ? best.index : null;
}

function nearestBoostPadMatch(coord){
  if(!coord) return null;
  let bestIndex = null;
  let bestDistance = Infinity;
  standardBoostPadCoords.forEach((pad, index)=>{
    const distance = Math.hypot(pad.fieldX - coord.x, pad.fieldY - coord.y);
    if(distance < bestDistance){
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return {index: bestIndex, distance: bestDistance, pad: standardBoostPadCoords[bestIndex] || null};
}

function objectNameMatches(objectName, suffix){
  return typeof objectName === "string" && objectName.endsWith(suffix);
}

function isMaskedReplayName(name){
  return /^\*+$/.test(cleanName(name));
}

function buildReplayNameAliases(parsedReplay, observedPlayers){
  const statNames = (parsedReplay?.properties?.PlayerStats || [])
    .map(player => cleanName(player?.Name))
    .filter(Boolean);
  if(!statNames.length) return new Map();

  const eventNames = new Set(observedPlayers.map(player => cleanName(player?.playerName ?? player)).filter(Boolean));
  const missingStatNames = statNames.filter(name => !eventNames.has(name));
  const maskedEventNames = [...eventNames].filter(isMaskedReplayName);
  const aliases = new Map();

  if(maskedEventNames.length === missingStatNames.length){
    maskedEventNames.forEach((maskedName, index)=>{
      aliases.set(maskedName, missingStatNames[index]);
    });
  }

  return aliases;
}

function boostPickupEventKey(playerName, padIndex, time){
  return `${playerName}:${padIndex}:${Math.round(Number(time || 0) * 20) / 20}`;
}

function isSmallBoostRise(boostIncrease){
  if(!boostIncrease) return false;
  return boostIncrease.boostDelta >= 8 && boostIncrease.boostDelta <= 45;
}

function clampNumber(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function normalizeTeamNumber(value){
  if(value === 0 || value === "0") return 0;
  if(value === 1 || value === "1") return 1;
  return null;
}

function buildPlayerTeamNumbers(parsedReplay){
  const teams = new Map();
  for(const player of parsedReplay?.properties?.PlayerStats || []){
    const name = cleanName(player?.Name);
    const teamNumber = normalizeTeamNumber(player?.Team);
    if(name && teamNumber !== null) teams.set(name, teamNumber);
  }
  return teams;
}

function isCarActorObject(objectName){
  return typeof objectName === "string" && (
    objectName === "TAGame.Car_TA" ||
    objectName.endsWith(".Car_Default") ||
    objectName.includes(".Car.Car_Default")
  );
}

function isBallActorObject(objectName){
  return typeof objectName === "string" && (
    objectName === "TAGame.Ball_TA" ||
    objectName.endsWith(".Ball_Default") ||
    objectName.includes(".Ball.Ball_Default")
  );
}

function teamNumberFromActorObject(objectName){
  if(typeof objectName !== "string") return null;
  if(objectName.endsWith(".Team0") || objectName.includes("Team0")) return 0;
  if(objectName.endsWith(".Team1") || objectName.includes("Team1")) return 1;
  return null;
}

function replayIntValue(attribute, value){
  const raw = getObject(value, "Int") ?? getObject(attribute, "Int");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function replayElapsedSeconds(time, firstTime, lastTime, totalSeconds){
  const total = Number(totalSeconds);
  if(!Number.isFinite(time)) return 0;
  if(Number.isFinite(firstTime) && Number.isFinite(lastTime) && lastTime > firstTime && Number.isFinite(total) && total > 0){
    return clampNumber(((time - firstTime) / (lastTime - firstTime)) * total, 0, total);
  }
  return Math.max(0, time - (firstTime || 0));
}

function goalFaceFromReplayLocation(location, teamNumber=null){
  if(!location || !Number.isFinite(location.x)) return {xPercent:50, yPercent:50};
  let xPercent = ((location.x + 900) / 1800) * 100;
  // Goal face is shown from the field looking into the net.
  // Blue shoots toward +Y, so positive field X appears on the viewer's left.
  if(normalizeTeamNumber(teamNumber) === 0) xPercent = 100 - xPercent;
  const z = Number(location.z || 0);
  return {
    xPercent,
    yPercent: 100 - ((z / 650) * 100)
  };
}

function scoreboardClockLabel(secondsRemaining, isOvertime=false, overtimeSeconds=null){
  if(isOvertime && Number.isFinite(overtimeSeconds)){
    const seconds = Math.max(0, Math.round(overtimeSeconds));
    return `OT +${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if(Number.isFinite(secondsRemaining)){
    const seconds = Math.max(0, Math.round(secondsRemaining));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return null;
}

function distanceToOpponentNet(location, teamNumber){
  if(!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) return null;
  const normalizedTeam = normalizeTeamNumber(teamNumber);
  if(normalizedTeam === null) return null;
  const targetY = normalizedTeam === 0 ? 5120 : -5120;
  return Math.round(Math.hypot(location.x, location.y - targetY, (location.z || 0) - 320));
}

function distanceBetweenLocations(a, b){
  if(!a || !b) return Infinity;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

function summarizeBoostPickups(parsedReplay){
  const frames = parsedReplay?.network_frames?.frames || parsedReplay?.frames || [];
  const objects = parsedReplay?.objects || [];
  const names = parsedReplay?.names || [];
  const priName = new Map();
  const carPri = new Map();
  const carLoc = new Map();
  const boostComponentCar = new Map();
  const boostComponentAmount = new Map();
  const carBoostAmount = new Map();
  const actorObject = new Map();
  const pickupState = new Map();
  const pickupAvailable = new Map();
  const pickupCandidates = [];
  const boostIncreases = [];
  const padSamples = new Map();
  let isOvertime = false;

  for(const frame of frames){
    const time = Number(frame.time ?? frame.seconds ?? frame.delta ?? 0);
    for(const actor of frame.new_actors || []){
      if(Number.isInteger(actor.actor_id)){
        const objectName = objects[actor.object_id] || names[actor.name_id] || actor.object_name || actor.object || actor.name || "";
        actorObject.set(actor.actor_id, objectName);
        const initialLocation = decodeActorLocation(actor.initial_trajectory);
        if(initialLocation) carLoc.set(actor.actor_id, initialLocation);
      }
    }
    for(const actorId of frame.deleted_actors || []){
      actorObject.delete(actorId);
      pickupState.delete(actorId);
      carPri.delete(actorId);
      carLoc.delete(actorId);
      const boostCarActor = boostComponentCar.get(actorId);
      if(Number.isInteger(boostCarActor)) carBoostAmount.delete(boostCarActor);
      boostComponentCar.delete(actorId);
      boostComponentAmount.delete(actorId);
    }
    for(const update of frame.updated_actors || []){
      const actorId = update.actor_id;
      const attribute = update.attribute || {};
      const objectId = Number(update.object_id ?? attribute.object_id);
      const objectName = objects[objectId] || "";
      const value = attribute.value ?? attribute;

      if(objectNameMatches(objectName, "Engine.PlayerReplicationInfo:PlayerName")){
        const name = cleanName(typeof value === "string" ? value : value?.String || attribute.String || value?.name);
        if(name) priName.set(actorId, name);
      }

      if(objectNameMatches(objectName, "Engine.Pawn:PlayerReplicationInfo")){
        const priActor = extractActorReference(value) ?? extractActorReference(attribute);
        if(Number.isInteger(priActor)) carPri.set(actorId, priActor);
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:bOverTime")){
        const overtimeValue = getObject(attribute, "Boolean") ?? getObject(value, "Boolean");
        if(typeof overtimeValue === "boolean") isOvertime = overtimeValue;
      }

      if(objectNameMatches(objectName, "TAGame.CarComponent_TA:Vehicle")){
        const carActor = extractActorReference(value) ?? extractActorReference(attribute);
        if(Number.isInteger(carActor)){
          boostComponentCar.set(actorId, carActor);
          const boostAmount = boostComponentAmount.get(actorId);
          if(Number.isFinite(boostAmount)) carBoostAmount.set(carActor, boostAmount);
        }
      }

      const loc = decodeActorLocation(value);
      if(loc) carLoc.set(actorId, loc);

      if(objectNameMatches(objectName, "TAGame.CarComponent_Boost_TA:ReplicatedBoost")){
        const replicatedBoost = getObject(attribute, "ReplicatedBoost") || getObject(value, "ReplicatedBoost");
        const boostAmount = Number(getObject(replicatedBoost, "boost_amount"));
        if(Number.isFinite(boostAmount)){
          const previousBoost = boostComponentAmount.get(actorId);
          const carActor = boostComponentCar.get(actorId);
          if(Number.isInteger(carActor) && Number.isFinite(previousBoost) && boostAmount > previousBoost + 2){
            const pri = carPri.get(carActor);
            boostIncreases.push({
              time: Number.isFinite(time) ? time : 0,
              carActor,
              componentActor: actorId,
              pri,
              playerName: cleanName(priName.get(pri)),
              previousBoost,
              boostAmount,
              boostDelta: boostAmount - previousBoost,
              location: carLoc.get(carActor)
            });
          }
          if(Number.isInteger(carActor)) carBoostAmount.set(carActor, boostAmount);
          boostComponentAmount.set(actorId, boostAmount);
        }
      }

      const pickup = getObject(attribute, "PickupNew");
      if(!pickup || typeof pickup !== "object") continue;
      const instigator = getObject(pickup, "instigator");
      const pickedUp = getObject(pickup, "picked_up");
      const pickupActorName = actorObject.get(actorId) || "";
      const suffix = /VehiclePickup_Boost_TA_(\d+)/.exec(pickupActorName)?.[1] || null;
      if(!suffix) continue;

      const stateKey = `${instigator}:${pickedUp}`;
      if(pickupState.get(actorId) === stateKey) continue;
      pickupState.set(actorId, stateKey);

      if(instigator == null || instigator === 255 || pickedUp === 255){
        pickupAvailable.set(suffix, true);
        continue;
      }

      if(!Number.isInteger(instigator) || instigator < 0) continue;

      const pri = carPri.get(instigator);
      const playerName = cleanName(priName.get(pri));
      const location = carLoc.get(instigator);
      if(!playerName || !location) continue;

      if(!padSamples.has(suffix)) padSamples.set(suffix, []);
      padSamples.get(suffix).push(location);

      pickupCandidates.push({
        time: Number.isFinite(time) ? time : 0,
        playerName,
        pri,
        instigator,
        padActor: actorId,
        padName: pickupActorName,
        pickupActorSuffix: suffix,
        location,
        hadAvailable: pickupAvailable.get(suffix) === true,
        isInitialPickupState: pickedUp === 1,
        isOvertime,
        boostAtPickup: carBoostAmount.get(instigator)
      });
      pickupAvailable.set(suffix, false);
    }
  }

  const suffixToPad = new Map();
  const padActors = [];
  for(const [suffix, samples] of padSamples){
    const average = samples.reduce((sum, sample)=>({
      x: sum.x + sample.x,
      y: sum.y + sample.y,
      z: sum.z + sample.z
    }), {x:0, y:0, z:0});
    average.x /= samples.length;
    average.y /= samples.length;
    average.z /= samples.length;
    const padIndex = nearestBoostPadIndex(average);
    suffixToPad.set(suffix, padIndex);
    padActors.push({suffix, padIndex, sampleCount:samples.length, averagePickupLocation:average});
  }

  const players = new Map();
  const usedBoostIncreases = new Set();
  const events = [];
  for(const candidate of pickupCandidates){
    const padIndex = suffixToPad.get(candidate.pickupActorSuffix);
    if(padIndex === null || padIndex === undefined) continue;
    const pad = standardBoostPadCoords[padIndex];
    if(!pad) continue;
    const candidateDistance = Math.hypot(candidate.location.x - pad.fieldX, candidate.location.y - pad.fieldY);
    if(candidateDistance > 950) continue;

    let bestBoostIndex = null;
    let bestScore = Infinity;
    for(let i = 0; i < boostIncreases.length; i++){
      if(usedBoostIncreases.has(i)) continue;
      const boostIncrease = boostIncreases[i];
      if(boostIncrease.carActor !== candidate.instigator) continue;
      const timeDelta = Math.abs(boostIncrease.time - candidate.time);
      if(timeDelta > 0.35) continue;
      const boostLocation = boostIncrease.location || candidate.location;
      const boostDistance = Math.hypot(boostLocation.x - pad.fieldX, boostLocation.y - pad.fieldY);
      if(boostDistance > 1100) continue;
      const score = timeDelta + boostDistance / 10000;
      if(score < bestScore){
        bestScore = score;
        bestBoostIndex = i;
      }
    }

    if(bestBoostIndex === null) continue;
    const bestBoost = boostIncreases[bestBoostIndex];
    const boostLocation = bestBoost.location || candidate.location;
    const boostDistance = Math.hypot(boostLocation.x - pad.fieldX, boostLocation.y - pad.fieldY);
    const hasReplayStateSupport = candidate.hadAvailable || candidate.isInitialPickupState || candidate.isOvertime;
    const closePickupWithoutState = candidateDistance <= 80 && boostDistance <= 120;
    const fullLargePadWithoutState = pad.type === "large" && bestBoost.boostAmount >= 250 && candidateDistance <= 125 && boostDistance <= 140;
    if(!hasReplayStateSupport && !closePickupWithoutState && !fullLargePadWithoutState) continue;

    usedBoostIncreases.add(bestBoostIndex);
    events.push({
      ...candidate,
      padIndex,
      boostBefore: bestBoost.previousBoost,
      boostAfter: bestBoost.boostAmount,
      boostDelta: bestBoost.boostDelta,
      detection: "pickup-state"
    });
  }

  const eventKeys = new Set(events.map(event=>boostPickupEventKey(event.playerName, event.padIndex, event.time)));
  for(let i = 0; i < boostIncreases.length; i++){
    if(usedBoostIncreases.has(i)) continue;
    const boostIncrease = boostIncreases[i];
    if(!boostIncrease.playerName || !boostIncrease.location || !isSmallBoostRise(boostIncrease)) continue;
    const match = nearestBoostPadMatch(boostIncrease.location);
    if(!match?.pad || match.pad.type !== "small" || match.distance > 260) continue;
    const key = boostPickupEventKey(boostIncrease.playerName, match.index, boostIncrease.time);
    if(eventKeys.has(key)) continue;

    eventKeys.add(key);
    events.push({
      time: boostIncrease.time,
      playerName: boostIncrease.playerName,
      pri: boostIncrease.pri,
      instigator: boostIncrease.carActor,
      padActor: null,
      padName: null,
      pickupActorSuffix: null,
      location: boostIncrease.location,
      hadAvailable: false,
      isInitialPickupState: false,
      isOvertime: false,
      padIndex: match.index,
      boostBefore: boostIncrease.previousBoost,
      boostAfter: boostIncrease.boostAmount,
      boostDelta: boostIncrease.boostDelta,
      detection: "small-boost-rise"
    });
  }

  events.sort((a,b)=>(a.time || 0) - (b.time || 0));

  const nameAliases = buildReplayNameAliases(parsedReplay, [...priName.values()]);
  const censoredAliases = new Map([...nameAliases].map(([censoredName, realName]) => [realName, censoredName]));
  for(const event of events){
    const padIndex = event.padIndex;
    if(padIndex === null || padIndex === undefined) continue;
    const pad = standardBoostPadCoords[padIndex];
    const playerName = nameAliases.get(event.playerName) || event.playerName;
    if(!players.has(playerName)){
      players.set(playerName, {
        name:playerName,
        censoredName:censoredAliases.get(playerName) || null,
        boostPickups:[]
      });
    }
    players.get(playerName).boostPickups.push({
      time:event.time,
      padIndex,
      padActor:event.padActor,
      padName:event.padName,
      pickupActorSuffix:event.pickupActorSuffix,
      type:pad.type,
      fieldX:pad.fieldX,
      fieldY:pad.fieldY,
      instigator:event.instigator,
      pri:event.pri,
      boostBefore:event.boostBefore,
      boostAfter:event.boostAfter,
      boostDelta:event.boostDelta,
      detection:event.detection || "pickup-state",
      sampleLocation:event.location
    });
  }

  return {
    parser: "rrrocket",
    players: [...players.values()].sort((a,b)=>a.name.localeCompare(b.name)),
    nameAliases: [...nameAliases].map(([censoredName, realName])=>({name:realName, censoredName})),
    totalBoostPickups: events.length,
    mappedBoostPickups: [...players.values()].reduce((sum, player)=>sum + player.boostPickups.length, 0),
    padActors: padActors.sort((a,b)=>Number(a.suffix) - Number(b.suffix))
  };
}

function summarizeShotSamples(parsedReplay){
  const frames = parsedReplay?.network_frames?.frames || parsedReplay?.frames || [];
  const objects = parsedReplay?.objects || [];
  const names = parsedReplay?.names || [];
  const totalSeconds = Number(parsedReplay?.properties?.TotalSecondsPlayed) || 300;
  const firstFrameTime = Number(frames[0]?.time ?? 0);
  const lastFrameTime = Number(frames.at(-1)?.time ?? firstFrameTime + totalSeconds);
  const teamByStatName = buildPlayerTeamNumbers(parsedReplay);
  const expectedShotsByStatName = new Map((parsedReplay?.properties?.PlayerStats || [])
    .map(player=>[cleanName(player?.Name), Number(player?.Shots)])
    .filter(([name, shots])=>name && Number.isFinite(shots)));

  const priName = new Map();
  const priTeam = new Map();
  const teamActorNumber = new Map();
  const carPri = new Map();
  const carLoc = new Map();
  const ballLoc = new Map();
  const actorObject = new Map();
  const carActors = new Set();
  const ballActors = new Set();
  const lastStatValue = new Map();
  const shotEvents = [];
  const goalEvents = [];
  const saveEvents = [];
  const distanceSamplesByPri = new Map();
  const positionSamplesByPri = new Map();
  const lastDistanceSampleElapsedByPri = new Map();
  const recentTouchCandidatesByPri = new Map();
  let ballSampleCount = 0;
  let latestBallLocation = null;
  let scoreboardSecondsRemaining = null;
  let scoreboardClockStartSeconds = null;
  let scoreboardClockFinalSeconds = null;
  let isOvertime = false;

  function teamForPri(pri, playerName){
    const directTeam = priTeam.get(pri);
    if(directTeam !== null && directTeam !== undefined) return directTeam;
    const headerTeam = teamByStatName.get(cleanName(playerName));
    return headerTeam !== undefined ? headerTeam : null;
  }

  function activeCarsForPri(pri){
    const cars = [];
    for(const [carActor, ownerPri] of carPri){
      if(ownerPri !== pri) continue;
      const location = carLoc.get(carActor);
      if(location) cars.push({carActor, location});
    }
    if(cars.length > 1 && latestBallLocation){
      cars.sort((a,b)=>distanceBetweenLocations(a.location, latestBallLocation) - distanceBetweenLocations(b.location, latestBallLocation));
    }
    return cars;
  }

  function activePlayerSnapshots(){
    const players = [];
    const seen = new Set();
    for(const [carActor, pri] of carPri){
      const location = carLoc.get(carActor);
      if(!location) continue;
      const playerName = cleanName(priName.get(pri));
      if(!playerName) continue;
      const key = `${pri}:${playerName}`;
      if(seen.has(key)) continue;
      seen.add(key);
      players.push({
        pri,
        playerName,
        teamNumber: teamForPri(pri, playerName),
        carActor,
        location
      });
    }
    return players;
  }

  function nearestOpponent(referenceLocation, teamNumber, shooterPri){
    if(!referenceLocation || normalizeTeamNumber(teamNumber) === null) return {distance:null, playerName:null};
    let best = {distance:Infinity, playerName:null};
    for(const player of activePlayerSnapshots()){
      if(player.pri === shooterPri) continue;
      if(normalizeTeamNumber(player.teamNumber) === normalizeTeamNumber(teamNumber)) continue;
      const distance = Math.round(distanceBetweenLocations(referenceLocation, player.location));
      if(distance < best.distance){
        best = {distance, playerName:player.playerName};
      }
    }
    return Number.isFinite(best.distance) ? best : {distance:null, playerName:null};
  }

  function currentBallLocation(){
    if(latestBallLocation) return latestBallLocation;
    for(const location of ballLoc.values()){
      if(location) return location;
    }
    return null;
  }

  function makeStatEvent(kind, time, pri, value){
    const playerName = cleanName(priName.get(pri));
    const teamNumber = teamForPri(pri, playerName);
    const cars = activeCarsForPri(pri);
    const shooterLocation = cars[0]?.location || null;
    const ballLocation = currentBallLocation();
    const referenceLocation = ballLocation || shooterLocation;
    const opponent = nearestOpponent(referenceLocation, teamNumber, pri);
    const touchCandidates = (recentTouchCandidatesByPri.get(pri) || [])
      .filter(touch => time - touch.time >= -0.05 && time - touch.time <= 8);
    let recentTouch = null;
    if(touchCandidates.length){
      let sequenceStart = touchCandidates.length - 1;
      for(let i = touchCandidates.length - 1; i > 0; i--){
        const gap = touchCandidates[i].time - touchCandidates[i - 1].time;
        if(gap > 0.55) break;
        sequenceStart = i - 1;
      }
      recentTouch = touchCandidates[sequenceStart];
    }
    const lastTouchLocation = recentTouch?.ballLocation || ballLocation || shooterLocation;

    return {
      kind,
      value,
      time: Number.isFinite(time) ? time : 0,
      elapsedSeconds: replayElapsedSeconds(time, firstFrameTime, lastFrameTime, totalSeconds),
      scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: Number.isFinite(scoreboardSecondsRemaining) ? Math.max(0, 300 - scoreboardSecondsRemaining) : null,
      goalTime: scoreboardClockLabel(scoreboardSecondsRemaining, isOvertime),
      pri,
      playerName,
      teamNumber,
      carActor: cars[0]?.carActor ?? null,
      shooterLocation,
      ballLocation,
      lastTouchLocation,
      lastTouchTime: recentTouch?.time ?? null,
      lastTouchScoreboardSecondsRemaining: recentTouch?.scoreboardSecondsRemaining ?? null,
      nearestOpponentDistanceUU: opponent.distance,
      nearestOpponent: opponent.playerName,
      lastTouchDistanceToNetUU: distanceToOpponentNet(lastTouchLocation, teamNumber)
    };
  }

  function pushPhysicsSamples(time){
    const ballLocation = currentBallLocation();
    if(!ballLocation) return;
    ballSampleCount++;
    const elapsedSeconds = replayElapsedSeconds(time, firstFrameTime, lastFrameTime, totalSeconds);
    const seenPris = new Set();
    for(const pri of carPri.values()){
      if(!Number.isInteger(pri) || seenPris.has(pri)) continue;
      seenPris.add(pri);
      const playerName = cleanName(priName.get(pri));
      if(!playerName) continue;
      const car = activeCarsForPri(pri)[0];
      if(!car?.location) continue;
      const carBallDistance = distanceBetweenLocations(car.location, ballLocation);
      if(carBallDistance <= 750){
        if(!recentTouchCandidatesByPri.has(pri)) recentTouchCandidatesByPri.set(pri, []);
        const candidates = recentTouchCandidatesByPri.get(pri);
        const lastCandidate = candidates[candidates.length - 1];
        if(!lastCandidate || time - lastCandidate.time > 0.12 || carBallDistance < lastCandidate.carBallDistance){
          candidates.push({
            time,
            elapsedSeconds,
            scoreboardSecondsRemaining,
            carActor: car.carActor,
            carBallDistance: Math.round(carBallDistance),
            carLocation: car.location,
            ballLocation
          });
          while(candidates.length > 40) candidates.shift();
        }else{
          lastCandidate.time = time;
          lastCandidate.elapsedSeconds = elapsedSeconds;
          lastCandidate.scoreboardSecondsRemaining = scoreboardSecondsRemaining;
          lastCandidate.carBallDistance = Math.round(carBallDistance);
          lastCandidate.carLocation = car.location;
          lastCandidate.ballLocation = ballLocation;
        }
      }
      const lastElapsed = lastDistanceSampleElapsedByPri.get(pri);
      if(Number.isFinite(lastElapsed) && elapsedSeconds - lastElapsed < 0.22) continue;

      lastDistanceSampleElapsedByPri.set(pri, elapsedSeconds);
      if(!distanceSamplesByPri.has(pri)) distanceSamplesByPri.set(pri, []);
      if(!positionSamplesByPri.has(pri)) positionSamplesByPri.set(pri, []);
      distanceSamplesByPri.get(pri).push({
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        scoreboardSecondsRemaining,
        scoreboardElapsedSeconds: Number.isFinite(scoreboardSecondsRemaining) ? Math.max(0, 300 - scoreboardSecondsRemaining) : null,
        distanceUU: Math.round(distanceBetweenLocations(car.location, ballLocation)),
        carActor: car.carActor,
        ballLocation,
        carLocation: car.location,
        playerName
      });
      positionSamplesByPri.get(pri).push({
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        scoreboardSecondsRemaining,
        scoreboardElapsedSeconds: Number.isFinite(scoreboardSecondsRemaining) ? Math.max(0, 300 - scoreboardSecondsRemaining) : null,
        x: Math.round(car.location.x),
        y: Math.round(car.location.y),
        z: Math.round(car.location.z || 0),
        playerName
      });
    }
  }

  for(const frame of frames){
    const time = Number(frame.time ?? frame.seconds ?? frame.delta ?? 0);

    for(const actor of frame.new_actors || []){
      if(!Number.isInteger(actor.actor_id)) continue;
      const objectName = objects[actor.object_id] || names[actor.name_id] || actor.object_name || actor.object || actor.name || "";
      actorObject.set(actor.actor_id, objectName);

      const teamNumber = teamNumberFromActorObject(objectName);
      if(teamNumber !== null) teamActorNumber.set(actor.actor_id, teamNumber);

      if(isCarActorObject(objectName)) carActors.add(actor.actor_id);
      if(isBallActorObject(objectName)) ballActors.add(actor.actor_id);

      const initialLocation = decodeActorLocation(actor.initial_trajectory);
      if(initialLocation){
        if(carActors.has(actor.actor_id)) carLoc.set(actor.actor_id, initialLocation);
        if(ballActors.has(actor.actor_id)){
          ballLoc.set(actor.actor_id, initialLocation);
          latestBallLocation = initialLocation;
        }
      }
    }

    for(const actorId of frame.deleted_actors || []){
      actorObject.delete(actorId);
      carActors.delete(actorId);
      ballActors.delete(actorId);
      carPri.delete(actorId);
      carLoc.delete(actorId);
      ballLoc.delete(actorId);
      teamActorNumber.delete(actorId);
    }

    for(const update of frame.updated_actors || []){
      const actorId = update.actor_id;
      const attribute = update.attribute || {};
      const objectId = Number(update.object_id ?? attribute.object_id);
      const objectName = objects[objectId] || "";
      const value = attribute.value ?? attribute;

      if(objectNameMatches(objectName, "Engine.PlayerReplicationInfo:PlayerName")){
        const name = cleanName(typeof value === "string" ? value : value?.String || attribute.String || value?.name);
        if(name) priName.set(actorId, name);
      }

      if(objectNameMatches(objectName, "Engine.PlayerReplicationInfo:Team")){
        const teamActor = extractActorReference(value) ?? extractActorReference(attribute);
        const teamNumber = teamActorNumber.get(teamActor);
        if(teamNumber !== null && teamNumber !== undefined) priTeam.set(actorId, teamNumber);
      }

      if(objectNameMatches(objectName, "Engine.Pawn:PlayerReplicationInfo")){
        const priActor = extractActorReference(value) ?? extractActorReference(attribute);
        if(Number.isInteger(priActor)) carPri.set(actorId, priActor);
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:SecondsRemaining")){
        const secondsRemaining = replayIntValue(attribute, value);
        if(Number.isFinite(secondsRemaining)){
          scoreboardSecondsRemaining = secondsRemaining;
          scoreboardClockFinalSeconds = secondsRemaining;
          scoreboardClockStartSeconds = Math.max(scoreboardClockStartSeconds ?? secondsRemaining, secondsRemaining);
        }
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:bOverTime")){
        const overtimeValue = getObject(attribute, "Boolean") ?? getObject(value, "Boolean");
        if(typeof overtimeValue === "boolean") isOvertime = overtimeValue;
      }

      const loc = decodeActorLocation(value);
      if(loc){
        if(carActors.has(actorId)) carLoc.set(actorId, loc);
        if(ballActors.has(actorId)){
          ballLoc.set(actorId, loc);
          latestBallLocation = loc;
        }
      }

      const statMatch = /TAGame\.PRI_TA:Match(Shots|Goals|Saves)$/.exec(objectName);
      if(!statMatch) continue;
      const statValue = replayIntValue(attribute, value);
      if(!Number.isFinite(statValue)) continue;
      const key = `${actorId}:${statMatch[1]}`;
      const previousValue = lastStatValue.get(key) ?? 0;
      lastStatValue.set(key, statValue);
      if(statValue <= previousValue) continue;

      for(let valueIndex = previousValue + 1; valueIndex <= statValue; valueIndex++){
        const event = makeStatEvent(statMatch[1], time, actorId, valueIndex);
        if(!event.playerName) continue;
        if(statMatch[1] === "Shots") shotEvents.push(event);
        if(statMatch[1] === "Goals") goalEvents.push(event);
        if(statMatch[1] === "Saves") saveEvents.push(event);
      }
    }

    pushPhysicsSamples(time);
  }

  const nameAliases = buildReplayNameAliases(parsedReplay, [
    ...new Set([
      ...priName.values(),
      ...shotEvents.map(event=>event.playerName),
      ...goalEvents.map(event=>event.playerName),
      ...saveEvents.map(event=>event.playerName),
      ...[...distanceSamplesByPri.keys()].map(pri=>priName.get(pri))
    ])
  ]);
  const censoredAliases = new Map([...nameAliases].map(([censoredName, realName]) => [realName, censoredName]));
  const resolveName = name => nameAliases.get(cleanName(name)) || cleanName(name);
  const resolveTeam = event => {
    const aliasName = resolveName(event.playerName);
    const headerTeam = teamByStatName.get(aliasName);
    return headerTeam !== undefined ? headerTeam : event.teamNumber;
  };

  const usedGoals = new Set();
  const usedSaves = new Set();
  const players = new Map();

  function ensurePlayer(playerName, censoredName=null){
    const cleanPlayerName = cleanName(playerName);
    if(!cleanPlayerName) return null;
    if(!players.has(cleanPlayerName)){
      players.set(cleanPlayerName, {
        name: cleanPlayerName,
        censoredName: censoredName || censoredAliases.get(cleanPlayerName) || null,
        shotSamples: [],
        distanceToBallSamples: [],
        positionSamples: []
      });
    }
    const player = players.get(cleanPlayerName);
    if(censoredName && !player.censoredName) player.censoredName = censoredName;
    return player;
  }

  function addSample(playerName, censoredName, sample){
    const player = ensurePlayer(playerName, censoredName);
    if(!player) return;
    player.shotSamples.push(sample);
  }

  function findMatchingGoal(shot){
    let bestIndex = null;
    let bestScore = Infinity;
    for(let i = 0; i < goalEvents.length; i++){
      if(usedGoals.has(i)) continue;
      const goal = goalEvents[i];
      if(resolveName(goal.playerName).toLowerCase() !== resolveName(shot.playerName).toLowerCase()) continue;
      const delta = goal.time - shot.time;
      if(delta < -0.35 || delta > 6.25) continue;
      const score = Math.abs(delta);
      if(score < bestScore){
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function findMatchingSave(shot, shotTeam){
    let bestIndex = null;
    let bestScore = Infinity;
    for(let i = 0; i < saveEvents.length; i++){
      if(usedSaves.has(i)) continue;
      const save = saveEvents[i];
      const saveTeam = normalizeTeamNumber(resolveTeam(save));
      if(saveTeam !== null && shotTeam !== null && saveTeam === shotTeam) continue;
      const delta = save.time - shot.time;
      if(delta < -0.35 || delta > 2.75) continue;
      const distanceScore = distanceBetweenLocations(shot.ballLocation, save.ballLocation) / 2500;
      const score = Math.abs(delta) + distanceScore;
      if(score < bestScore){
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  for(const shot of shotEvents){
    const playerName = resolveName(shot.playerName);
    const censoredName = censoredAliases.get(playerName) || (isMaskedReplayName(shot.playerName) ? shot.playerName : null);
    const teamNumber = normalizeTeamNumber(resolveTeam(shot));
    let result = "miss";
    let placementLocation = shot.ballLocation || shot.shooterLocation;
    let placementSource = "shot";

    const goalIndex = findMatchingGoal(shot);
    if(goalIndex !== null){
      const goal = goalEvents[goalIndex];
      usedGoals.add(goalIndex);
      result = "goal";
      placementLocation = goal.ballLocation || placementLocation;
      placementSource = "goal";
      shot.nearestOpponentDistanceUU = goal.nearestOpponentDistanceUU;
      shot.nearestOpponent = goal.nearestOpponent;
    }else{
      const saveIndex = findMatchingSave(shot, teamNumber);
      if(saveIndex !== null){
        const save = saveEvents[saveIndex];
        usedSaves.add(saveIndex);
        result = "save";
        placementLocation = save.ballLocation || placementLocation;
        placementSource = "save";
        shot.nearestOpponentDistanceUU = save.nearestOpponentDistanceUU;
        shot.nearestOpponent = save.nearestOpponent;
        shot.defender = resolveName(save.playerName);
      }
    }

    const face = goalFaceFromReplayLocation(placementLocation, teamNumber);
    addSample(playerName, censoredName, {
      result,
      elapsedSeconds: Number(shot.elapsedSeconds.toFixed(3)),
      scoreboardSecondsRemaining: shot.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: shot.scoreboardElapsedSeconds,
      goalTime: shot.goalTime || scoreboardClockLabel(shot.scoreboardSecondsRemaining),
      xPercent: Number(face.xPercent.toFixed(2)),
      yPercent: Number(face.yPercent.toFixed(2)),
      nearestOpponentDistanceUU: shot.nearestOpponentDistanceUU,
      nearestOpponent: shot.nearestOpponent ? resolveName(shot.nearestOpponent) : null,
      defender: shot.defender || (shot.nearestOpponent ? resolveName(shot.nearestOpponent) : null),
      lastTouchDistanceToNetUU: shot.lastTouchDistanceToNetUU,
      player: playerName,
      team: teamNumber === 0 ? "Blue" : teamNumber === 1 ? "Orange" : null,
      source: "rrrocket-stat",
      placementSource,
      statValue: shot.value,
      shotTime: shot.time,
      shotLocation: shot.ballLocation,
      lastTouchLocation: shot.lastTouchLocation,
      lastTouchTime: shot.lastTouchTime,
      lastTouchScoreboardSecondsRemaining: shot.lastTouchScoreboardSecondsRemaining,
      placementLocation,
      shooterLocation: shot.shooterLocation
    });
  }

  for(let i = 0; i < goalEvents.length; i++){
    if(usedGoals.has(i)) continue;
    const goal = goalEvents[i];
    const playerName = resolveName(goal.playerName);
    const expectedShots = expectedShotsByStatName.get(playerName);
    const currentSamples = players.get(playerName)?.shotSamples.length || 0;
    if(Number.isFinite(expectedShots) && currentSamples >= expectedShots) continue;
    const teamNumber = normalizeTeamNumber(resolveTeam(goal));
    const face = goalFaceFromReplayLocation(goal.ballLocation || goal.shooterLocation, teamNumber);
    addSample(playerName, censoredAliases.get(playerName) || null, {
      result: "goal",
      elapsedSeconds: Number(goal.elapsedSeconds.toFixed(3)),
      scoreboardSecondsRemaining: goal.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: goal.scoreboardElapsedSeconds,
      goalTime: goal.goalTime || scoreboardClockLabel(goal.scoreboardSecondsRemaining),
      xPercent: Number(face.xPercent.toFixed(2)),
      yPercent: Number(face.yPercent.toFixed(2)),
      nearestOpponentDistanceUU: goal.nearestOpponentDistanceUU,
      nearestOpponent: goal.nearestOpponent ? resolveName(goal.nearestOpponent) : null,
      lastTouchDistanceToNetUU: goal.lastTouchDistanceToNetUU,
      player: playerName,
      team: teamNumber === 0 ? "Blue" : teamNumber === 1 ? "Orange" : null,
      source: "rrrocket-goal-fallback",
      placementSource: "goal",
      statValue: goal.value,
      shotTime: goal.time,
      shotLocation: goal.ballLocation,
      lastTouchLocation: goal.lastTouchLocation,
      lastTouchTime: goal.lastTouchTime,
      lastTouchScoreboardSecondsRemaining: goal.lastTouchScoreboardSecondsRemaining,
      placementLocation: goal.ballLocation,
      shooterLocation: goal.shooterLocation
    });
  }

  for(const [pri, samples] of distanceSamplesByPri){
    const rawName = cleanName(samples[0]?.playerName || priName.get(pri));
    const playerName = resolveName(rawName);
    const censoredName = censoredAliases.get(playerName) || (isMaskedReplayName(rawName) ? rawName : null);
    const player = ensurePlayer(playerName, censoredName);
    if(!player) continue;
    player.distanceToBallSamples = samples.map(sample=>({
      elapsedSeconds: sample.elapsedSeconds,
      scoreboardSecondsRemaining: sample.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: sample.scoreboardElapsedSeconds,
      distanceUU: sample.distanceUU,
      carActor: sample.carActor,
      carLocation: sample.carLocation,
      ballLocation: sample.ballLocation
    }));
    player.positionSamples = (positionSamplesByPri.get(pri) || []).map(sample=>({
      elapsedSeconds: sample.elapsedSeconds,
      scoreboardSecondsRemaining: sample.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: sample.scoreboardElapsedSeconds,
      x: sample.x,
      y: sample.y,
      z: sample.z
    }));
  }

  const sortedPlayers = [...players.values()]
    .map(player=>({
      ...player,
      shotSamples: player.shotSamples.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      distanceToBallSamples: player.distanceToBallSamples.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      positionSamples: player.positionSamples.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0))
    }))
    .sort((a,b)=>a.name.localeCompare(b.name));

  return {
    parser: "rrrocket",
    players: sortedPlayers,
    nameAliases: [...nameAliases].map(([censoredName, realName])=>({name:realName, censoredName})),
    totalShotSamples: sortedPlayers.reduce((sum, player)=>sum + player.shotSamples.length, 0),
    totalDistanceSamples: sortedPlayers.reduce((sum, player)=>sum + player.distanceToBallSamples.length, 0),
    totalPositionSamples: sortedPlayers.reduce((sum, player)=>sum + player.positionSamples.length, 0),
    totalBallSamples: ballSampleCount,
    scoreboardClockStartSeconds,
    scoreboardClockFinalSeconds,
    frameCount: frames.length,
    shotStatEvents: shotEvents.length,
    goalStatEvents: goalEvents.length,
    saveStatEvents: saveEvents.length,
    matchedGoalEvents: usedGoals.size,
    matchedSaveEvents: usedSaves.size
  };
}

function playerStatsByName(parsedReplay){
  const stats = new Map();
  for(const player of parsedReplay?.properties?.PlayerStats || []){
    const name = cleanName(player?.Name);
    if(!name) continue;
    const teamNumber = normalizeTeamNumber(player?.Team);
    stats.set(name.toLowerCase(), {
      team: teamNumber === 0 ? "Blue" : teamNumber === 1 ? "Orange" : null,
      stats: {
        team: teamNumber === 0 ? "Blue" : teamNumber === 1 ? "Orange" : null,
        score: Number(player?.Score ?? 0),
        goals: Number(player?.Goals ?? 0),
        assists: Number(player?.Assists ?? 0),
        saves: Number(player?.Saves ?? 0),
        shots: Number(player?.Shots ?? 0)
      }
    });
  }
  return stats;
}

function mergeReplayParserSummaries(parsedReplay, boostSummary, shotSummary){
  const players = new Map();
  const stats = playerStatsByName(parsedReplay);

  function ensurePlayer(name, source={}){
    const cleanPlayerName = cleanName(name);
    if(!cleanPlayerName) return null;
    const key = cleanPlayerName.toLowerCase();
    if(!players.has(key)){
      const stat = stats.get(key) || {};
      players.set(key, {
        name: cleanPlayerName,
        censoredName: cleanName(source.censoredName || stat.censoredName || "") || null,
        team: source.team || stat.team || null,
        stats: stat.stats || undefined,
        boostPickups: [],
        shotSamples: [],
        distanceToBallSamples: [],
        positionSamples: []
      });
    }
    const player = players.get(key);
    if(source.censoredName && !player.censoredName) player.censoredName = cleanName(source.censoredName);
    if(source.team && !player.team) player.team = source.team;
    if(!player.stats && stats.get(key)?.stats) player.stats = stats.get(key).stats;
    return player;
  }

  for(const alias of [...(boostSummary?.nameAliases || []), ...(shotSummary?.nameAliases || [])]){
    const player = ensurePlayer(alias.name, {censoredName: alias.censoredName});
    if(player && alias.censoredName && !player.censoredName) player.censoredName = cleanName(alias.censoredName);
  }

  for(const parsedPlayer of boostSummary?.players || []){
    const player = ensurePlayer(parsedPlayer.name, parsedPlayer);
    if(!player) continue;
    player.boostPickups = Array.isArray(parsedPlayer.boostPickups) ? parsedPlayer.boostPickups : [];
  }

  for(const parsedPlayer of shotSummary?.players || []){
    const player = ensurePlayer(parsedPlayer.name, parsedPlayer);
    if(!player) continue;
    player.shotSamples = Array.isArray(parsedPlayer.shotSamples) ? parsedPlayer.shotSamples : [];
    player.distanceToBallSamples = Array.isArray(parsedPlayer.distanceToBallSamples) ? parsedPlayer.distanceToBallSamples : [];
    player.positionSamples = Array.isArray(parsedPlayer.positionSamples) ? parsedPlayer.positionSamples : [];
  }

  return {
    parser: "rrrocket",
    players: [...players.values()].sort((a,b)=>a.name.localeCompare(b.name)),
    nameAliases: [...(boostSummary?.nameAliases || []), ...(shotSummary?.nameAliases || [])]
      .filter((alias, index, all)=>alias?.name && all.findIndex(other=>other.name === alias.name && other.censoredName === alias.censoredName) === index),
    boostSummary,
    shotSummary,
    totalBoostPickups: boostSummary?.totalBoostPickups || 0,
    mappedBoostPickups: boostSummary?.mappedBoostPickups || 0,
    totalShotSamples: shotSummary?.totalShotSamples || 0,
    totalDistanceSamples: shotSummary?.totalDistanceSamples || 0,
    totalPositionSamples: shotSummary?.totalPositionSamples || 0,
    totalBallSamples: shotSummary?.totalBallSamples || 0,
    scoreboardClockStartSeconds: shotSummary?.scoreboardClockStartSeconds ?? null,
    scoreboardClockFinalSeconds: shotSummary?.scoreboardClockFinalSeconds ?? null,
    frameCount: shotSummary?.frameCount || 0,
    shotStatEvents: shotSummary?.shotStatEvents || 0,
    goalStatEvents: shotSummary?.goalStatEvents || 0,
    saveStatEvents: shotSummary?.saveStatEvents || 0,
    matchedGoalEvents: shotSummary?.matchedGoalEvents || 0,
    matchedSaveEvents: shotSummary?.matchedSaveEvents || 0,
    padActors: boostSummary?.padActors || [],
    transient: true
  };
}

async function parseReplayOnce(req, prefix){
  const replayBytes = await readRequestBody(req);
  if(!replayBytes.length) throw new Error("No replay bytes were uploaded.");

  await fs.mkdir(tmpDir, {recursive:true});
  const replayPath = path.join(tmpDir, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.replay`);
  try{
    await fs.writeFile(replayPath, replayBytes);
    const stdout = await runRrrocket(replayPath);
    return JSON.parse(stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout);
  }finally{
    await fs.rm(replayPath, {force:true}).catch(()=>{});
  }
}

async function handleBoostParse(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use POST with replay bytes.");
    return;
  }

  const parsed = await parseReplayOnce(req, "boost");
  const summary = summarizeBoostPickups(parsed);
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(summary));
}

async function handleShotParse(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use POST with replay bytes.");
    return;
  }

  const parsed = await parseReplayOnce(req, "shots");
  const summary = summarizeShotSamples(parsed);
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(summary));
}

async function handleReplayParse(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use POST with replay bytes.");
    return;
  }

  const parsed = await parseReplayOnce(req, "replay");
  const boostSummary = summarizeBoostPickups(parsed);
  const shotSummary = summarizeShotSamples(parsed);
  const summary = mergeReplayParserSummaries(parsed, boostSummary, shotSummary);
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(summary));
}

http.createServer(async (req,res)=>{
  try{
    const url = new URL(req.url, "http://127.0.0.1");
    if(url.pathname === "/api/parse-replay-boosts"){
      await handleBoostParse(req, res);
      return;
    }
    if(url.pathname === "/api/parse-replay-shots"){
      await handleShotParse(req, res);
      return;
    }
    if(url.pathname === "/api/parse-replay"){
      await handleReplayParse(req, res);
      return;
    }
    if(url.pathname === "/__spark_logo.png" || url.pathname === "/__1ne_logo.png"){
      const data = await fs.readFile(logoPath);
      res.writeHead(200, {"Content-Type":"image/png"});
      res.end(data);
      return;
    }
    if(url.pathname === "/1NE_Overlay" || url.pathname === "/SPARK_Overlay"){
      const data = await fs.readFile(path.join(root, appFileName));
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      res.end(data);
      return;
    }
    const requestedPath = decodeURIComponent(url.pathname.slice(1) || appFileName);
    const fileName = requestedPath === "1NE_Esports_Replay_Analyzer_followup_speed_passes.html" ? appFileName : requestedPath;
    const file = path.resolve(root, fileName);
    if(!file.startsWith(path.resolve(root))){
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = await fs.readFile(file);
    res.writeHead(200, {"Content-Type": types.get(path.extname(file).toLowerCase()) || "application/octet-stream"});
    res.end(data);
  }catch(err){
    const isApi = req.url?.startsWith("/api/");
    res.writeHead(isApi ? 500 : 404, isApi ? {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"} : undefined);
    res.end(isApi ? (err.message || "Replay boost parser failed.") : "Not found");
  }
}).listen(8765, "127.0.0.1", ()=>console.log("http://127.0.0.1:8765"));
