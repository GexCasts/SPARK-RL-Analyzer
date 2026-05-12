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

  const replayBytes = await readRequestBody(req);
  if(!replayBytes.length) throw new Error("No replay bytes were uploaded.");

  await fs.mkdir(tmpDir, {recursive:true});
  const replayPath = path.join(tmpDir, `boost-${Date.now()}-${Math.random().toString(16).slice(2)}.replay`);
  try{
    await fs.writeFile(replayPath, replayBytes);
    const stdout = await runRrrocket(replayPath);
    const parsed = JSON.parse(stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout);
    const summary = summarizeBoostPickups(parsed);
    res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8"});
    res.end(JSON.stringify(summary));
  }finally{
    await fs.rm(replayPath, {force:true}).catch(()=>{});
  }
}

http.createServer(async (req,res)=>{
  try{
    const url = new URL(req.url, "http://127.0.0.1");
    if(url.pathname === "/api/parse-replay-boosts"){
      await handleBoostParse(req, res);
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
