import http from "node:http";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createReplayAnalysisPackage} from "./parser/replay-analysis-service.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here;
const appFileName = "SPARK.html";
const overlayFileName = path.join("overlay", "SPARK_Overlay.html");
const logoPath = path.join(here, "assets", "Spark Logo.png");
const oneNeLogoPath = path.join(here, "assets", "1NE_Vector_edited.png");
const tileLayoutPath = path.join(here, "SPARK-layout.json");
const overlayAssetDir = path.join(here, ".tmp", "overlay-assets");
const rrrocketVersion = "0.11.1";
const rrrocketCandidates = [
  process.env.SPARK_RRROCKET_PATH,
  path.join(here, "tools", "rrrocket", `rrrocket-${rrrocketVersion}-x86_64-unknown-linux-musl`, "rrrocket"),
  path.join(here, "tools", "rrrocket", `rrrocket-${rrrocketVersion}-x86_64-apple-darwin`, "rrrocket"),
  path.join(here, "tools", "rrrocket", `rrrocket-${rrrocketVersion}-aarch64-apple-darwin`, "rrrocket"),
  path.join(here, "tools", "rrrocket", `rrrocket-${rrrocketVersion}-x86_64-pc-windows-msvc`, "rrrocket.exe")
].filter(Boolean);
const rrrocketPath = rrrocketCandidates.find(candidate=>fsSync.existsSync(candidate));
const tmpDir = path.join(here, ".tmp");
const PHYSICS_SAMPLE_INTERVAL_SECONDS = 0.045;
const TARGET_POSITION_SAMPLES_PER_PLAYER = 5400;
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".png", "image/png"],
  [".json", "application/json"]
]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const overlayAssetKinds = new Map([
  ["scoreboard", "scoreboard.png"],
  ["scoreboard-mask", "scoreboard-mask.png"],
  ["tournament-logo", "tournament-logo.png"],
  ["stinger-transition", "stinger-transition"]
]);
const overlayStingerMetaFile = "stinger-transition.json";
const activeClients = new Map();
const clientStaleMs = 120000;
const shutdownGraceMs = 60000;
let hasSeenClient = false;
let shutdownTimer = null;
let server = null;
const liveApiFeedHost = "127.0.0.1";
const liveApiFeedPort = 49123;
const liveApiStatsConfigPath = process.env.SPARK_RL_STATS_API_CONFIG_PATH ||
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague\\TAGame\\Config\\defaultstatsapi.ini";
const serverProtocolVersion = 2;
const liveApiClients = new Set();
let liveApiFeedSocket = null;
let liveApiReconnectTimer = null;
let liveApiStreamBuffer = "";
let liveApiLatestMessage = null;

function clearShutdownTimer(){
  if(shutdownTimer){
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

function pruneInactiveClients(now=Date.now()){
  for(const [id, lastSeen] of activeClients.entries()){
    if(now - lastSeen > clientStaleMs) activeClients.delete(id);
  }
}

function shutdownWhenIdle(){
  pruneInactiveClients();
  if(!hasSeenClient || activeClients.size){
    clearShutdownTimer();
    return;
  }
  if(shutdownTimer) return;
  shutdownTimer = setTimeout(()=>{
    pruneInactiveClients();
    if(activeClients.size) return clearShutdownTimer();
    console.log("SPARK app closed; shutting down local server.");
    server?.close(()=>process.exit(0));
    setTimeout(()=>process.exit(0), 5000).unref();
  }, shutdownGraceMs);
  shutdownTimer.unref();
}

setInterval(shutdownWhenIdle, 30000).unref();

function sendLiveApiWebSocketText(socket, text){
  if(socket.destroyed) return;
  const payload = Buffer.from(text, "utf8");
  let header;
  if(payload.length < 126){
    header = Buffer.from([0x81, payload.length]);
  }else if(payload.length < 65536){
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }else{
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function broadcastLiveApiMessage(text){
  liveApiLatestMessage = text;
  for(const client of liveApiClients) sendLiveApiWebSocketText(client, text);
}

function extractLiveApiJsonObjects(chunk){
  liveApiStreamBuffer += chunk;
  const messages = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastEnd = 0;

  for(let i = 0; i < liveApiStreamBuffer.length; i++){
    const char = liveApiStreamBuffer[i];
    if(inString){
      if(escaped) escaped = false;
      else if(char === "\\") escaped = true;
      else if(char === "\"") inString = false;
      continue;
    }
    if(char === "\"") inString = true;
    else if(char === "{"){
      if(depth === 0) start = i;
      depth++;
    }else if(char === "}"){
      depth--;
      if(depth === 0 && start >= 0){
        messages.push(liveApiStreamBuffer.slice(start, i + 1));
        lastEnd = i + 1;
        start = -1;
      }
    }
  }

  liveApiStreamBuffer = depth > 0 && start >= 0 ? liveApiStreamBuffer.slice(start) : liveApiStreamBuffer.slice(lastEnd);
  return messages;
}

function scheduleLiveApiReconnect(){
  if(liveApiReconnectTimer || !liveApiClients.size) return;
  liveApiReconnectTimer = setTimeout(()=>{
    liveApiReconnectTimer = null;
    connectLiveApiFeed();
  }, 1500);
  liveApiReconnectTimer.unref();
}

function connectLiveApiFeed(){
  if(liveApiFeedSocket && !liveApiFeedSocket.destroyed) return;
  if(!liveApiClients.size) return;
  liveApiFeedSocket = net.createConnection({host:liveApiFeedHost, port:liveApiFeedPort}, ()=>{
    console.log(`SPARK Live API bridge connected to ${liveApiFeedHost}:${liveApiFeedPort}`);
  });
  liveApiFeedSocket.setEncoding("utf8");
  liveApiFeedSocket.on("data", data=>{
    for(const message of extractLiveApiJsonObjects(data)) broadcastLiveApiMessage(message);
  });
  liveApiFeedSocket.on("error", err=>{
    console.warn(`SPARK Live API bridge feed error: ${err.message}`);
  });
  liveApiFeedSocket.on("close", ()=>{
    liveApiFeedSocket = null;
    liveApiStreamBuffer = "";
    scheduleLiveApiReconnect();
  });
}

function stopLiveApiFeedIfIdle(){
  if(liveApiClients.size) return;
  if(liveApiReconnectTimer){
    clearTimeout(liveApiReconnectTimer);
    liveApiReconnectTimer = null;
  }
  if(liveApiFeedSocket){
    liveApiFeedSocket.destroy();
    liveApiFeedSocket = null;
  }
}

function acceptLiveApiWebSocket(req, socket){
  const key = String(req.headers["sec-websocket-key"] || "").trim();
  if(!key){
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));
  liveApiClients.add(socket);
  if(liveApiLatestMessage) sendLiveApiWebSocketText(socket, liveApiLatestMessage);
  connectLiveApiFeed();
  socket.on("close", ()=>{
    liveApiClients.delete(socket);
    stopLiveApiFeedIfIdle();
  });
  socket.on("error", ()=>{
    liveApiClients.delete(socket);
    stopLiveApiFeedIfIdle();
  });
}

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
    if(!rrrocketPath){
      reject(new Error(`rrrocket parser not found. Checked: ${rrrocketCandidates.join(", ")}`));
      return;
    }
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
  const rigidBody = getObject(value, "RigidBody") || getObject(value, "rigid_body") || getObject(value, "rigidBody");
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

function isLargeBoostRise(boostIncrease){
  if(!boostIncrease) return false;
  return boostIncrease.boostDelta > 45 || (boostIncrease.boostDelta >= 8 && boostIncrease.boostAmount >= 240);
}

function clampNumber(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function lerpNumber(a, b, t){
  const left = Number(a);
  const right = Number(b);
  if(Number.isFinite(left) && Number.isFinite(right)) return left + (right - left) * t;
  if(Number.isFinite(left)) return left;
  if(Number.isFinite(right)) return right;
  return null;
}

function lerpVector(a, b, t){
  if(!a && !b) return null;
  const out = {};
  for(const key of ["x", "y", "z"]){
    const value = lerpNumber(a?.[key], b?.[key], t);
    if(Number.isFinite(value)) out[key] = Number(value.toFixed(2));
  }
  return Object.keys(out).length ? out : null;
}

function splitGameplaySampleSegments(samples, maxGapSeconds=1.1){
  const sorted = (Array.isArray(samples) ? samples : [])
    .filter(sample=>Number.isFinite(Number(sample?.elapsedSeconds)))
    .sort((a,b)=>Number(a.elapsedSeconds) - Number(b.elapsedSeconds));
  const segments = [];
  for(const sample of sorted){
    const lastSegment = segments[segments.length - 1];
    const previous = lastSegment?.[lastSegment.length - 1];
    if(!lastSegment || (previous && Number(sample.elapsedSeconds) - Number(previous.elapsedSeconds) > maxGapSeconds)){
      segments.push([sample]);
    }else{
      lastSegment.push(sample);
    }
  }
  return segments;
}

function allocateSegmentSampleCounts(segments, targetCount){
  const target = Math.max(0, Math.round(Number(targetCount) || 0));
  if(!segments.length || target <= 0) return [];
  if(target <= segments.length) return segments.map((_, index)=>index < target ? 1 : 0);

  const weights = segments.map(segment=>{
    const first = segment[0];
    const last = segment[segment.length - 1];
    const duration = Math.max(0, Number(last?.elapsedSeconds) - Number(first?.elapsedSeconds));
    return Math.max(duration, segment.length > 1 ? segment.length * .01 : .01);
  });
  const weightTotal = weights.reduce((sum,value)=>sum + value, 0) || segments.length;
  const rawCounts = weights.map(weight=>(weight / weightTotal) * target);
  const counts = rawCounts.map((raw, index)=>segments[index].length ? Math.max(1, Math.floor(raw)) : 0);
  let assigned = counts.reduce((sum,value)=>sum + value, 0);

  while(assigned < target){
    let bestIndex = 0;
    let bestRemainder = -Infinity;
    rawCounts.forEach((raw, index)=>{
      const remainder = raw - Math.floor(raw);
      if(remainder > bestRemainder){
        bestRemainder = remainder;
        bestIndex = index;
      }
    });
    counts[bestIndex]++;
    rawCounts[bestIndex] = Math.floor(rawCounts[bestIndex]);
    assigned++;
  }

  while(assigned > target){
    let bestIndex = counts.findIndex(count=>count > 1);
    if(bestIndex === -1) break;
    for(let i=0; i<counts.length; i++){
      if(counts[i] > counts[bestIndex] && counts[i] > 1) bestIndex = i;
    }
    counts[bestIndex]--;
    assigned--;
  }

  return counts;
}

function resampleGameplaySeries(samples, targetCount, interpolateSample){
  const source = Array.isArray(samples) ? samples : [];
  if(source.length < 2) return source;
  const target = Math.max(2, Math.round(Number(targetCount) || source.length));
  if(Math.abs(source.length - target) <= Math.max(8, target * .012)) return source;

  const segments = splitGameplaySampleSegments(source);
  const counts = allocateSegmentSampleCounts(segments, target);
  const out = [];

  segments.forEach((segment, segmentIndex)=>{
    const count = counts[segmentIndex] || 0;
    if(!count) return;
    if(segment.length === 1 || count === 1){
      out.push({...segment[Math.floor(segment.length / 2)]});
      return;
    }
    for(let i=0; i<count; i++){
      const pos = (i / Math.max(1, count - 1)) * (segment.length - 1);
      const low = Math.floor(pos);
      const high = Math.min(segment.length - 1, low + 1);
      const t = pos - low;
      out.push(interpolateSample(segment[low], segment[high], t));
    }
  });

  return out.length ? out : source;
}

function resamplePositionSamples(samples, targetCount=TARGET_POSITION_SAMPLES_PER_PLAYER){
  return resampleGameplaySeries(samples, targetCount, (a,b,t)=>({
    elapsedSeconds: Number((lerpNumber(a.elapsedSeconds, b.elapsedSeconds, t) ?? a.elapsedSeconds ?? 0).toFixed(3)),
    scoreboardSecondsRemaining: lerpNumber(a.scoreboardSecondsRemaining, b.scoreboardSecondsRemaining, t),
    scoreboardElapsedSeconds: Number((lerpNumber(a.scoreboardElapsedSeconds, b.scoreboardElapsedSeconds, t) ?? lerpNumber(a.elapsedSeconds, b.elapsedSeconds, t) ?? 0).toFixed(3)),
    x: Math.round(lerpNumber(a.x, b.x, t) ?? a.x ?? 0),
    y: Math.round(lerpNumber(a.y, b.y, t) ?? a.y ?? 0),
    z: Math.round(lerpNumber(a.z, b.z, t) ?? a.z ?? 0)
  }));
}

function resampleDistanceSamples(samples, targetCount=TARGET_POSITION_SAMPLES_PER_PLAYER){
  return resampleGameplaySeries(samples, targetCount, (a,b,t)=>{
    const carLocation = lerpVector(a.carLocation, b.carLocation, t);
    const ballLocation = lerpVector(a.ballLocation, b.ballLocation, t);
    const distance = carLocation && ballLocation
      ? Math.round(distanceBetweenLocations(carLocation, ballLocation))
      : Math.round(lerpNumber(a.distanceUU, b.distanceUU, t) ?? a.distanceUU ?? 0);
    return {
      elapsedSeconds: Number((lerpNumber(a.elapsedSeconds, b.elapsedSeconds, t) ?? a.elapsedSeconds ?? 0).toFixed(3)),
      scoreboardSecondsRemaining: lerpNumber(a.scoreboardSecondsRemaining, b.scoreboardSecondsRemaining, t),
      scoreboardElapsedSeconds: Number((lerpNumber(a.scoreboardElapsedSeconds, b.scoreboardElapsedSeconds, t) ?? lerpNumber(a.elapsedSeconds, b.elapsedSeconds, t) ?? 0).toFixed(3)),
      distanceUU: distance,
      carActor: a.carActor ?? b.carActor ?? null,
      carLocation,
      ballLocation,
      playerName: a.playerName || b.playerName || ""
    };
  });
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
  const raw = getObject(value, "Int") ?? getObject(attribute, "Int") ?? getObject(value, "Byte") ?? getObject(attribute, "Byte");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function replayElapsedSeconds(time, firstTime, lastTime, totalSeconds){
  const total = Number(totalSeconds);
  if(!Number.isFinite(time)) return 0;
  const start = Number.isFinite(firstTime) ? firstTime : 0;
  const rawElapsed = Math.max(0, time - start);
  if(Number.isFinite(firstTime) && Number.isFinite(lastTime) && lastTime > firstTime && Number.isFinite(total) && total > 0){
    const frameSpan = lastTime - firstTime;
    if(frameSpan > total + 1){
      return clampNumber(rawElapsed, 0, frameSpan);
    }
    return clampNumber((rawElapsed / frameSpan) * total, 0, total);
  }
  return rawElapsed;
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

function projectedGoalEntryLocation(location, vector, teamNumber){
  if(!location || !vector) return null;
  const normalizedTeam = normalizeTeamNumber(teamNumber);
  if(normalizedTeam === null) return null;
  const targetY = normalizedTeam === 0 ? 5120 : -5120;
  const y = Number(location.y);
  const vy = Number(vector.y);
  if(!Number.isFinite(y) || !Number.isFinite(vy) || Math.abs(vy) < 1e-6) return null;
  const t = (targetY - y) / vy;
  if(!Number.isFinite(t) || t <= 0 || t > 6) return null;
  const x = Number(location.x) + Number(vector.x || 0) * t;
  const z = Number(location.z || 0) + Number(vector.z || 0) * t;
  if(!Number.isFinite(x) || !Number.isFinite(z)) return null;

  // Allow a small near-post/crossbar margin so saves that were barely wide/high
  // can still be projected, then clamp to the actual goal mouth. A save stat
  // should represent a shot that was going into the net, not the ball's save
  // contact point out in front of the goal.
  if(x < -1250 || x > 1250 || z < -120 || z > 950) return null;
  return {
    x: clampNumber(x, -900, 900),
    y: targetY,
    z: clampNumber(z, 0, 650)
  };
}

function projectedBackboardImpactLocation(location, vector, teamNumber){
  if(!location || !vector) return null;
  const normalizedTeam = normalizeTeamNumber(teamNumber);
  if(normalizedTeam === null) return null;
  const targetY = normalizedTeam === 0 ? 5120 : -5120;
  const y = Number(location.y);
  const vy = Number(vector.y);
  if(!Number.isFinite(y) || !Number.isFinite(vy) || Math.abs(vy) < 1e-6) return null;
  const t = (targetY - y) / vy;
  if(!Number.isFinite(t) || t <= 0 || t > 7) return null;
  const x = Number(location.x) + Number(vector.x || 0) * t;
  const z = Number(location.z || 0) + Number(vector.z || 0) * t;
  if(!Number.isFinite(x) || !Number.isFinite(z)) return null;

  return {
    x: clampNumber(x, -3200, 3200),
    y: targetY,
    z: clampNumber(z, 0, 1800)
  };
}

function clampedGoalFaceLocation(location, teamNumber){
  if(!location) return null;
  const normalizedTeam = normalizeTeamNumber(teamNumber);
  if(normalizedTeam === null) return null;
  const targetY = normalizedTeam === 0 ? 5120 : -5120;
  const x = Number(location.x);
  const z = Number(location.z || 0);
  if(!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x: clampNumber(x, -900, 900),
    y: targetY,
    z: clampNumber(z, 0, 650)
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

const SOCCAR_REGULATION_SECONDS = 300;

function validScoreboardSecondsRemaining(value, isOvertime=false, elapsedFallback=null){
  const seconds = Math.round(Number(value));
  if(!Number.isFinite(seconds) || seconds < 0) return null;
  if(!isOvertime){
    return seconds <= SOCCAR_REGULATION_SECONDS ? seconds : null;
  }

  if(seconds >= SOCCAR_REGULATION_SECONDS){
    const overtimeOnlySeconds = seconds - SOCCAR_REGULATION_SECONDS;
    return overtimeOnlySeconds <= 900 ? overtimeOnlySeconds : null;
  }

  return seconds;
}

function scoreboardDurationSecondsFromClock(startSeconds, finalSeconds, hasOvertime=false){
  const start = Math.round(Number(startSeconds));
  const final = Math.round(Number(finalSeconds));
  if(!Number.isFinite(start) || !Number.isFinite(final) || start <= 0 || final < 0) return null;
  const regulationStart = SOCCAR_REGULATION_SECONDS;
  if(hasOvertime) return regulationStart + Math.max(0, final);
  if(start >= final) return Math.max(1, start - final);
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

function decodedVelocity(value){
  const rigidBody = getObject(value, "RigidBody") || getObject(value, "rigid_body") || getObject(value, "rigidBody");
  const velocity =
    getObject(value, "velocity") ||
    getObject(value, "Velocity") ||
    getObject(value, "linearVelocity") ||
    getObject(value, "linear_velocity") ||
    getObject(value, "LinearVelocity") ||
    getObject(rigidBody, "velocity") ||
    getObject(rigidBody, "Velocity") ||
    getObject(rigidBody, "linearVelocity") ||
    getObject(rigidBody, "linear_velocity") ||
    getObject(rigidBody, "LinearVelocity");
  if(!velocity || typeof velocity !== "object") return null;
  const x = Number(getObject(velocity, "x") ?? getObject(velocity, "X"));
  const y = Number(getObject(velocity, "y") ?? getObject(velocity, "Y"));
  const z = Number(getObject(velocity, "z") ?? getObject(velocity, "Z") ?? 0);
  if(!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {x, y, z};
}

function vectorSpeed(vector){
  if(!vector || !Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return null;
  return Math.hypot(vector.x || 0, vector.y || 0, vector.z || 0);
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
  const boostComponentActive = new Map();
  const boostComponentHadActive = new Set();
  const boostComponentLastTime = new Map();
  const carBoostAmount = new Map();
  const actorObject = new Map();
  const pickupState = new Map();
  const pickupAvailable = new Map();
  const pickupCandidates = [];
  const boostIncreases = [];
  const supersonicBoostSpend = new Map();
  const carMotion = new Map();
  const carSpeed = new Map();
  const carSpeedSamples = new Map();
  const carSupersonicState = new Map();
  const padSamples = new Map();
  let isOvertime = false;
  let scoreboardSecondsRemaining = null;
  let scoreboardClockStartSeconds = null;
  let activeScoredOnTeam = null;
  let countdownNumber = null;

  function currentGameElapsedSeconds(time){
    const start = SOCCAR_REGULATION_SECONDS;
    if(Number.isFinite(scoreboardSecondsRemaining)){
      if(isOvertime) return start + Math.max(0, scoreboardSecondsRemaining);
      return clampNumber(start - scoreboardSecondsRemaining, 0, start);
    }
    return Math.max(0, Number(time) || 0);
  }

  function normalizeScoredOnTeam(value){
    const team = normalizeTeamNumber(value);
    return team === null ? null : team;
  }

  function isGameplaySampleTime(){
    return activeScoredOnTeam === null && !(Number.isFinite(countdownNumber) && countdownNumber > 0);
  }

  function rememberCarSpeed(carActor, time, speed, source="motion"){
    if(!Number.isInteger(carActor) || !Number.isFinite(time) || !Number.isFinite(speed) || speed <= 0) return;
    carSpeed.set(carActor, {speed, time, source});
    if(!carSpeedSamples.has(carActor)) carSpeedSamples.set(carActor, []);
    const samples = carSpeedSamples.get(carActor);
    samples.push({time, speed, source});
    while(samples.length > 80) samples.shift();
  }

  function nearestCarSpeed(carActor, time){
    const direct = carSpeed.get(carActor);
    let best = direct && Number.isFinite(direct.speed) ? direct : null;
    let bestDelta = best ? Math.abs(time - best.time) : Infinity;
    const samples = carSpeedSamples.get(carActor) || [];
    for(let i = samples.length - 1; i >= 0; i--){
      const sample = samples[i];
      const delta = Math.abs(time - sample.time);
      if(delta > 0.75 && sample.time < time) break;
      if(delta < bestDelta){
        best = sample;
        bestDelta = delta;
      }
    }
    return bestDelta <= 0.75 ? best : null;
  }

  function maxNearbyCarSpeed(carActor, time, windowSeconds=0.2){
    const samples = carSpeedSamples.get(carActor) || [];
    let best = null;
    for(let i = samples.length - 1; i >= 0; i--){
      const sample = samples[i];
      const delta = Math.abs(time - sample.time);
      if(delta > windowSeconds && sample.time < time) break;
      if(delta <= windowSeconds && sample.speed <= 2450){
        best = Math.max(best ?? 0, sample.speed);
      }
    }
    return best;
  }

  function replayBoolValue(attribute, value){
    const direct = getObject(attribute, "Boolean") ?? getObject(value, "Boolean");
    if(typeof direct === "boolean") return direct;
    if(typeof value === "boolean") return value;
    return null;
  }

  function replayComponentActiveValue(attribute, value){
    const boolValue = replayBoolValue(attribute, value);
    if(typeof boolValue === "boolean") return boolValue;
    const byte = Number(getObject(attribute, "Byte") ?? getObject(value, "Byte"));
    // rrrocket exposes ReplicatedActive as a change counter; even values line up
    // with the boost component actively draining in decoded replays.
    if(Number.isFinite(byte)) return Math.round(byte) % 2 === 0;
    return null;
  }

  function isPlausibleBoostDrain(rawBoostUsed, previousTime, currentTime){
    if(!Number.isFinite(rawBoostUsed) || rawBoostUsed <= 0) return false;
    if(!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return rawBoostUsed <= 12;
    const dt = currentTime - previousTime;
    if(dt <= 0 || dt > 1.25) return false;
    const maxRawDrain = Math.max(8, dt * 96 + 8);
    return rawBoostUsed <= maxRawDrain;
  }

  function addSupersonicBoostSpend(playerName, rawBoostUsed, bucket, speedSample){
    if(!playerName || !Number.isFinite(rawBoostUsed) || rawBoostUsed <= 0) return;
    const previous = supersonicBoostSpend.get(playerName) || {strictRaw:0, looseRaw:0, nearbyRaw:0, strictNonPlausibleRaw:0, events:0, speedSamples:0};
    if(bucket === "loose") previous.looseRaw += rawBoostUsed;
    else if(bucket === "nearby") previous.nearbyRaw += rawBoostUsed;
    else if(bucket === "strictNonPlausible") previous.strictNonPlausibleRaw += rawBoostUsed;
    else previous.strictRaw += rawBoostUsed;
    previous.events += 1;
    if(speedSample) previous.speedSamples += 1;
    supersonicBoostSpend.set(playerName, previous);
  }

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
      carMotion.delete(actorId);
      carSpeed.delete(actorId);
      carSpeedSamples.delete(actorId);
      carSupersonicState.delete(actorId);
      const boostCarActor = boostComponentCar.get(actorId);
      if(Number.isInteger(boostCarActor)){
        carBoostAmount.delete(boostCarActor);
        carMotion.delete(boostCarActor);
        carSpeed.delete(boostCarActor);
        carSpeedSamples.delete(boostCarActor);
        carSupersonicState.delete(boostCarActor);
      }
      boostComponentCar.delete(actorId);
      boostComponentAmount.delete(actorId);
      boostComponentActive.delete(actorId);
      boostComponentHadActive.delete(actorId);
      boostComponentLastTime.delete(actorId);
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
        if(typeof overtimeValue === "boolean"){
          const enteringOvertime = overtimeValue && !isOvertime;
          isOvertime = overtimeValue;
          if(enteringOvertime) scoreboardSecondsRemaining = 0;
        }
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:SecondsRemaining")){
        const secondsRemaining = validScoreboardSecondsRemaining(replayIntValue(attribute, value), isOvertime, Number(time) || 0);
        if(Number.isFinite(secondsRemaining)){
          scoreboardSecondsRemaining = secondsRemaining;
          scoreboardClockStartSeconds = SOCCAR_REGULATION_SECONDS;
        }
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:ReplicatedScoredOnTeam")){
        activeScoredOnTeam = normalizeScoredOnTeam(replayIntValue(attribute, value));
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_TA:ReplicatedRoundCountDownNumber")){
        const rawCountdown = replayIntValue(attribute, value);
        countdownNumber = Number.isFinite(rawCountdown) ? rawCountdown : null;
      }

      if(objectNameMatches(objectName, "TAGame.CarComponent_TA:Vehicle")){
        const carActor = extractActorReference(value) ?? extractActorReference(attribute);
        if(Number.isInteger(carActor)){
          boostComponentCar.set(actorId, carActor);
          const boostAmount = boostComponentAmount.get(actorId);
          if(Number.isFinite(boostAmount)) carBoostAmount.set(carActor, boostAmount);
        }
      }

      if(objectNameMatches(objectName, "TAGame.CarComponent_TA:ReplicatedActive")){
        const activeValue = replayComponentActiveValue(attribute, value);
        if(typeof activeValue === "boolean"){
          boostComponentActive.set(actorId, activeValue);
          boostComponentHadActive.add(actorId);
        }
      }

      const loc = decodeActorLocation(value);
      if(loc){
        const previousMotion = carMotion.get(actorId);
        if(previousMotion && Number.isFinite(time)){
          const dt = time - previousMotion.time;
          if(dt > 0.01 && dt < 1.25){
            rememberCarSpeed(actorId, time, distanceBetweenLocations(loc, previousMotion.location) / dt, "motion");
          }
        }
        carMotion.set(actorId, {time, location:loc});
        carLoc.set(actorId, loc);
      }

      const velocity = decodedVelocity(value);
      const speedFromVelocity = vectorSpeed(velocity);
      if(Number.isFinite(speedFromVelocity)){
        rememberCarSpeed(actorId, time, speedFromVelocity, "velocity");
      }

      if(/:b?SuperSonic$/i.test(objectName) || /:b?Supersonic$/i.test(objectName)){
        const supersonicValue = replayBoolValue(attribute, value);
        if(typeof supersonicValue === "boolean") carSupersonicState.set(actorId, supersonicValue);
      }

      if(objectNameMatches(objectName, "TAGame.CarComponent_Boost_TA:ReplicatedBoost")){
        const replicatedBoost = getObject(attribute, "ReplicatedBoost") || getObject(value, "ReplicatedBoost");
        const boostAmount = Number(getObject(replicatedBoost, "boost_amount"));
        if(Number.isFinite(boostAmount)){
          const previousBoost = boostComponentAmount.get(actorId);
          const carActor = boostComponentCar.get(actorId);
          if(isGameplaySampleTime() && Number.isInteger(carActor) && Number.isFinite(previousBoost) && boostAmount > previousBoost + 2){
            const pri = carPri.get(carActor);
            boostIncreases.push({
              time: Number.isFinite(time) ? time : 0,
              elapsedSeconds: Number(currentGameElapsedSeconds(time).toFixed(3)),
              scoreboardSecondsRemaining,
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
          if(isGameplaySampleTime() && Number.isInteger(carActor) && Number.isFinite(previousBoost) && previousBoost > boostAmount + 1){
            const rawBoostUsed = previousBoost - boostAmount;
            const previousBoostTime = boostComponentLastTime.get(actorId);
            const speedSample = nearestCarSpeed(carActor, time);
            const nearbyMaxSpeed = maxNearbyCarSpeed(carActor, time, 0.2);
            const atSupersonicSpeed = speedSample && speedSample.speed >= 2180 && speedSample.speed <= 2450;
            const atMaxSpeed = speedSample && speedSample.speed >= 2280 && speedSample.speed <= 2450;
            const nearMaxSpeed = Number.isFinite(nearbyMaxSpeed) && nearbyMaxSpeed >= 2280 && nearbyMaxSpeed <= 2450;
            const activeKnown = boostComponentHadActive.has(actorId);
            const boostActive = boostComponentActive.get(actorId) === true;
            const activeEnough = activeKnown ? boostActive : rawBoostUsed <= 10;
            if(activeEnough && isPlausibleBoostDrain(rawBoostUsed, previousBoostTime, time)){
              const pri = carPri.get(carActor);
              const playerName = cleanName(priName.get(pri));
              if(atSupersonicSpeed) addSupersonicBoostSpend(playerName, rawBoostUsed, "loose", speedSample);
              if(atMaxSpeed) addSupersonicBoostSpend(playerName, rawBoostUsed, "strict", speedSample);
              if(nearMaxSpeed) addSupersonicBoostSpend(playerName, rawBoostUsed, "nearby", speedSample);
            }else if(activeEnough && atMaxSpeed){
              const pri = carPri.get(carActor);
              const playerName = cleanName(priName.get(pri));
              addSupersonicBoostSpend(playerName, rawBoostUsed, "strictNonPlausible", speedSample);
            }
          }
          if(Number.isInteger(carActor)) carBoostAmount.set(carActor, boostAmount);
          boostComponentAmount.set(actorId, boostAmount);
          boostComponentLastTime.set(actorId, Number.isFinite(time) ? time : null);
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
      if(!isGameplaySampleTime()) continue;

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
        elapsedSeconds: Number(currentGameElapsedSeconds(time).toFixed(3)),
        scoreboardSecondsRemaining,
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
    if(!boostIncrease.playerName || !boostIncrease.location) continue;
    const match = nearestBoostPadMatch(boostIncrease.location);
    if(!match?.pad) continue;
    const isSmallMatch = match.pad.type === "small" && isSmallBoostRise(boostIncrease) && match.distance <= 260;
    const isLargeMatch = match.pad.type === "large" && isLargeBoostRise(boostIncrease) && match.distance <= 520;
    if(!isSmallMatch && !isLargeMatch) continue;
    const key = boostPickupEventKey(boostIncrease.playerName, match.index, boostIncrease.time);
    if(eventKeys.has(key)) continue;

    eventKeys.add(key);
    events.push({
      time: boostIncrease.time,
      elapsedSeconds: boostIncrease.elapsedSeconds,
      scoreboardSecondsRemaining: boostIncrease.scoreboardSecondsRemaining,
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
      detection: `${match.pad.type}-boost-rise`
    });
  }

  events.sort((a,b)=>(a.time || 0) - (b.time || 0));

  const nameAliases = buildReplayNameAliases(parsedReplay, [...priName.values()]);
  const censoredAliases = new Map([...nameAliases].map(([censoredName, realName]) => [realName, censoredName]));
  for(const [rawName, spend] of supersonicBoostSpend){
    const playerName = nameAliases.get(rawName) || rawName;
    if(!players.has(playerName)){
      players.set(playerName, {
        name:playerName,
        censoredName:censoredAliases.get(playerName) || null,
        boostPickups:[]
      });
    }
    const player = players.get(playerName);
    const strictRaw = spend.strictRaw || 0;
    const looseRaw = Math.max(strictRaw, spend.looseRaw || 0);
    const nearbyRaw = Math.max(strictRaw, spend.nearbyRaw || 0);
    const strictRatio = looseRaw > 0 ? strictRaw / looseRaw : 1;
    let selectedRaw = strictRaw;
    if(looseRaw > 0 && strictRatio < 0.65){
      selectedRaw = strictRaw + Math.max(0, nearbyRaw - strictRaw) * 0.37;
    }else if(looseRaw > 0 && strictRatio > 0.72){
      selectedRaw = looseRaw + (spend.strictNonPlausibleRaw || 0) * 0.055;
    }
    player.supersonicBoostUsed = Math.round((selectedRaw / 2.55) * 10) / 10;
    player.supersonicBoostEvents = spend.events;
  }
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
      elapsedSeconds:event.elapsedSeconds,
      scoreboardSecondsRemaining:event.scoreboardSecondsRemaining,
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
  const carVel = new Map();
  const ballLoc = new Map();
  const ballVel = new Map();
  const actorObject = new Map();
  const carActors = new Set();
  const ballActors = new Set();
  const lastStatValue = new Map();
  const shotEvents = [];
  const goalEvents = [];
  const saveEvents = [];
  const touchEvents = [];
  const goalStateEvents = [];
  const demoEvents = [];
  const bumpEvents = [];
  const touchEventKeys = new Set();
  const lastDemoByCollision = new Map();
  const lastBumpByCollision = new Map();
  const distanceSamplesByPri = new Map();
  const positionSamplesByPri = new Map();
  const touchEventsByPri = new Map();
  const demoEventsByPri = new Map();
  const bumpEventsByPri = new Map();
  const lastPhysicsSampleTimeByPri = new Map();
  const recentTouchCandidatesByPri = new Map();
  let activeKickoffWindow = null;
  let lastKickoffTouchElapsed = -Infinity;
  let ballSampleCount = 0;
  let latestBallLocation = null;
  let scoreboardSecondsRemaining = null;
  let scoreboardClockStartSeconds = null;
  let scoreboardClockFinalSeconds = null;
  let isOvertime = false;
  let hasOvertime = false;
  let activeScoredOnTeam = null;
  let countdownNumber = null;
  let excludedDeadBallFrames = 0;
  let observedDurationSeconds = 1;
  let observedElapsedCount = 0;

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
        location,
        velocity: carVel.get(carActor) || null
      });
    }
    return players;
  }

  function dot2(a, b){
    return (a?.x || 0) * (b?.x || 0) + (a?.y || 0) * (b?.y || 0);
  }

  function magnitude2(vector){
    if(!vector) return 0;
    return Math.hypot(vector.x || 0, vector.y || 0);
  }

  function addPerPriEvent(map, pri, event){
    if(!Number.isInteger(pri)) return;
    if(!map.has(pri)) map.set(pri, []);
    map.get(pri).push(event);
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

  function nearestTouchPlayer(referenceLocation, hitTeamNumber){
    if(!referenceLocation || normalizeTeamNumber(hitTeamNumber) === null) return null;
    let best = null;
    for(const player of activePlayerSnapshots()){
      if(normalizeTeamNumber(player.teamNumber) !== normalizeTeamNumber(hitTeamNumber)) continue;
      const distance = distanceBetweenLocations(referenceLocation, player.location);
      if(!best || distance < best.distance){
        best = {...player, distance};
      }
    }
    return best && best.distance <= 2200 ? best : null;
  }

  function normalizeScoredOnTeam(value){
    const team = normalizeTeamNumber(value);
    return team === null ? null : team;
  }

  function scoringTeamFromScoredOnTeam(scoredOnTeam){
    const team = normalizeScoredOnTeam(scoredOnTeam);
    if(team === null) return null;
    return team === 0 ? 1 : 0;
  }

  function isGameplaySampleTime(){
    return activeScoredOnTeam === null && !(Number.isFinite(countdownNumber) && countdownNumber > 0);
  }

  function currentBallLocation(){
    if(latestBallLocation) return latestBallLocation;
    for(const location of ballLoc.values()){
      if(location) return location;
    }
    return null;
  }

  function currentBallVelocity(){
    for(const velocity of ballVel.values()){
      if(velocity) return velocity;
    }
    return null;
  }

  function currentGameElapsedSeconds(time){
    const fallback = replayElapsedSeconds(time, firstFrameTime, lastFrameTime, totalSeconds);
    const start = SOCCAR_REGULATION_SECONDS;
    if(Number.isFinite(scoreboardSecondsRemaining)){
      if(isOvertime) return start + Math.max(0, scoreboardSecondsRemaining);
      return clampNumber(start - scoreboardSecondsRemaining, 0, start);
    }
    return fallback;
  }

  function noteObservedElapsed(elapsedSeconds){
    if(Number.isFinite(elapsedSeconds)){
      observedElapsedCount++;
      observedDurationSeconds = Math.max(observedDurationSeconds, Math.ceil(elapsedSeconds));
    }
  }

  function makeStatEvent(kind, time, pri, value){
    const playerName = cleanName(priName.get(pri));
    const teamNumber = teamForPri(pri, playerName);
    const cars = activeCarsForPri(pri);
    const shooterLocation = cars[0]?.location || null;
    const ballLocation = currentBallLocation();
    const ballVelocity = currentBallVelocity();
    const elapsedSeconds = currentGameElapsedSeconds(time);
    noteObservedElapsed(elapsedSeconds);
    const overtimeBaseSeconds = SOCCAR_REGULATION_SECONDS;
    const overtimeSeconds = isOvertime ? Math.max(0, elapsedSeconds - overtimeBaseSeconds) : null;
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
      elapsedSeconds,
      scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: elapsedSeconds,
      goalTime: scoreboardClockLabel(scoreboardSecondsRemaining, isOvertime, overtimeSeconds),
      isOvertime,
      overtimeSeconds,
      pri,
      playerName,
      teamNumber,
      carActor: cars[0]?.carActor ?? null,
      shooterLocation,
      ballLocation,
      ballVelocity,
      lastTouchLocation,
      lastTouchTime: recentTouch?.time ?? null,
      lastTouchScoreboardSecondsRemaining: recentTouch?.scoreboardSecondsRemaining ?? null,
      nearestOpponentDistanceUU: opponent.distance,
      nearestOpponent: opponent.playerName,
      lastTouchDistanceToNetUU: distanceToOpponentNet(lastTouchLocation, teamNumber)
    };
  }

  function addTouchEvent(time, hitTeamNumber){
    if(!isGameplaySampleTime()) return;
    const normalizedTeam = normalizeTeamNumber(hitTeamNumber);
    if(normalizedTeam === null) return;
    const ballLocation = currentBallLocation();
    const touchedBy = nearestTouchPlayer(ballLocation, normalizedTeam);
    if(!touchedBy?.playerName) return;
    const elapsedSeconds = currentGameElapsedSeconds(time);
    noteObservedElapsed(elapsedSeconds);
    const key = `${touchedBy.pri}:${normalizedTeam}:${Math.round(time * 20)}`;
    if(touchEventKeys.has(key)) return;
    touchEventKeys.add(key);
    const overtimeBaseSeconds = SOCCAR_REGULATION_SECONDS;
    const overtimeSeconds = isOvertime ? Math.max(0, elapsedSeconds - overtimeBaseSeconds) : null;
    const event = {
      time: Number.isFinite(time) ? time : 0,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      isOvertime,
      overtimeSeconds,
      pri: touchedBy.pri,
      playerName: touchedBy.playerName,
      teamNumber: normalizedTeam,
      carActor: touchedBy.carActor,
      carLocation: touchedBy.location,
      ballLocation,
      carBallDistance: Math.round(touchedBy.distance),
      source: "ball-hit-team"
    };
    touchEvents.push(event);
    addPerPriEvent(touchEventsByPri, touchedBy.pri, event);
  }

  function addInferredKickoffTouch(time, kickoffWindow, candidate, ballLocation, reason){
    if(!candidate?.playerName || !Number.isInteger(candidate.pri) || !ballLocation) return false;
    const elapsedSeconds = Number(candidate.elapsedSeconds ?? currentGameElapsedSeconds(time));
    if(!Number.isFinite(elapsedSeconds)) return false;
    if(elapsedSeconds - lastKickoffTouchElapsed < 7.5) return false;
    const duplicate = touchEvents.some(event=>{
      const eventElapsed = Number(event.elapsedSeconds ?? event.scoreboardElapsedSeconds);
      if(!Number.isFinite(eventElapsed) || Math.abs(eventElapsed - elapsedSeconds) > 1.75) return false;
      const location = event.ballLocation || null;
      return location ? Math.hypot(location.x || 0, location.y || 0) <= 1600 : true;
    });
    if(duplicate) return false;

    noteObservedElapsed(elapsedSeconds);
    const normalizedTeam = normalizeTeamNumber(candidate.teamNumber);
    const overtimeBaseSeconds = SOCCAR_REGULATION_SECONDS;
    const overtimeSeconds = isOvertime ? Math.max(0, elapsedSeconds - overtimeBaseSeconds) : null;
    const event = {
      time: Number.isFinite(candidate.time) ? candidate.time : Number.isFinite(time) ? time : 0,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      scoreboardSecondsRemaining: candidate.scoreboardSecondsRemaining ?? scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      isOvertime,
      overtimeSeconds,
      pri: candidate.pri,
      playerName: candidate.playerName,
      teamNumber: normalizedTeam,
      carActor: candidate.carActor,
      carLocation: candidate.carLocation,
      ballLocation: candidate.ballLocation || ballLocation,
      kickoffStartElapsedSeconds: Number((kickoffWindow?.startElapsed ?? elapsedSeconds).toFixed(3)),
      kickoffBallLocation: kickoffWindow?.centerLocation || null,
      carBallDistance: Math.round(candidate.carBallDistance),
      source: `kickoff-physics-inferred:${reason}`
    };
    touchEvents.push(event);
    addPerPriEvent(touchEventsByPri, candidate.pri, event);
    lastKickoffTouchElapsed = elapsedSeconds;
    return true;
  }

  function detectKickoffTouchFromPhysics(time, elapsedSeconds, ballLocation, playerSnapshots){
    if(!isGameplaySampleTime() || !ballLocation || !Array.isArray(playerSnapshots) || !playerSnapshots.length) return;
    const distanceFromCenter = Math.hypot(ballLocation.x || 0, ballLocation.y || 0);
    const ballVelocity = currentBallVelocity();
    const ballSpeed = magnitude2(ballVelocity);
    const nearCenter = distanceFromCenter <= 360;

    if(nearCenter && (!activeKickoffWindow || elapsedSeconds - activeKickoffWindow.startElapsed > 8)){
      activeKickoffWindow = {
        startElapsed: elapsedSeconds,
        startTime: Number.isFinite(time) ? time : 0,
        centerLocation: ballLocation,
        bestCandidate: null
      };
    }

    if(!activeKickoffWindow) return;
    const windowAge = elapsedSeconds - activeKickoffWindow.startElapsed;
    if(windowAge < -0.25) return;
    if(windowAge > 8){
      activeKickoffWindow = nearCenter ? {
        startElapsed: elapsedSeconds,
        startTime: Number.isFinite(time) ? time : 0,
        centerLocation: ballLocation,
        bestCandidate: null
      } : null;
      return;
    }

    let closest = null;
    for(const player of playerSnapshots){
      if(!player.location || !player.playerName) continue;
      const carBallDistance = distanceBetweenLocations(player.location, ballLocation);
      if(!closest || carBallDistance < closest.carBallDistance){
        closest = {
          time: Number.isFinite(time) ? time : 0,
          elapsedSeconds,
          scoreboardSecondsRemaining,
          pri: player.pri,
          playerName: player.playerName,
          teamNumber: player.teamNumber,
          carActor: player.carActor,
          carLocation: player.location,
          ballLocation,
          carBallDistance
        };
      }
    }
    if(!closest || closest.carBallDistance > 980) return;

    const currentBest = activeKickoffWindow.bestCandidate;
    if(!currentBest || closest.carBallDistance < currentBest.carBallDistance || elapsedSeconds - currentBest.elapsedSeconds > 0.35){
      activeKickoffWindow.bestCandidate = closest;
    }

    const center = activeKickoffWindow.centerLocation || {x:0,y:0,z:0};
    const movedFromCenter = Math.hypot((ballLocation.x || 0) - (center.x || 0), (ballLocation.y || 0) - (center.y || 0));
    const best = activeKickoffWindow.bestCandidate;
    const clearBallMovement = movedFromCenter >= 260 || ballSpeed >= 850;
    const closeContact = best?.carBallDistance <= 620 && windowAge >= 0.15;
    const timedContact = best?.carBallDistance <= 760 && windowAge >= 1.15;
    if(best && (clearBallMovement || closeContact || timedContact)){
      const added = addInferredKickoffTouch(time, activeKickoffWindow, best, ballLocation, clearBallMovement ? "ball-movement" : closeContact ? "close-contact" : "timed-contact");
      if(added) activeKickoffWindow = null;
    }
  }

  function addDemoEvent(time, payload){
    const demolish = payload?.DemolishExtended || payload;
    if(!demolish || demolish.self_demolish === true) return;
    const attackerPri = extractActorReference(demolish.attacker_pri);
    const attackerCar = extractActorReference(demolish.attacker);
    const victimCar = extractActorReference(demolish.victim);
    if(!Number.isInteger(attackerPri) || attackerPri < 0 || !Number.isInteger(victimCar) || victimCar < 0) return;
    const attackerName = cleanName(priName.get(attackerPri));
    if(!attackerName) return;
    const victimPri = carPri.get(victimCar);
    const victimName = cleanName(priName.get(victimPri));
    const pairKey = `${attackerPri}:${victimCar}`;
    const lastTime = lastDemoByCollision.get(pairKey);
    if(Number.isFinite(lastTime) && time - lastTime < 3.5) return;
    lastDemoByCollision.set(pairKey, time);

    const elapsedSeconds = currentGameElapsedSeconds(time);
    noteObservedElapsed(elapsedSeconds);
    const event = {
      time: Number.isFinite(time) ? time : 0,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      attackerPri,
      attackerName,
      attackerCar,
      victimPri,
      victimName,
      victimCar,
      attackerLocation: carLoc.get(attackerCar) || null,
      victimLocation: carLoc.get(victimCar) || null,
      source: "demolish-extended"
    };
    demoEvents.push(event);
    addPerPriEvent(demoEventsByPri, attackerPri, event);
  }

  function recentDemoBetween(attackerCar, victimCar, time){
    return demoEvents.some(event=>{
      if(time - event.time < -0.25 || time - event.time > 1.25) return false;
      return (event.attackerCar === attackerCar && event.victimCar === victimCar) ||
        (event.attackerCar === victimCar && event.victimCar === attackerCar);
    });
  }

  function detectBumps(time){
    if(!isGameplaySampleTime()) return;
    const players = activePlayerSnapshots()
      .filter(player=>Number.isInteger(player.pri) && player.playerName && player.location && player.velocity);
    for(let i = 0; i < players.length; i++){
      for(let j = i + 1; j < players.length; j++){
        const a = players[i];
        const b = players[j];
        if(normalizeTeamNumber(a.teamNumber) === null || normalizeTeamNumber(b.teamNumber) === null) continue;
        if(normalizeTeamNumber(a.teamNumber) === normalizeTeamNumber(b.teamNumber)) continue;
        const dx = (b.location.x || 0) - (a.location.x || 0);
        const dy = (b.location.y || 0) - (a.location.y || 0);
        const dz = Math.abs((b.location.z || 0) - (a.location.z || 0));
        const planarDistance = Math.hypot(dx, dy);
        if(planarDistance < 1 || planarDistance > 250 || dz > 180) continue;
        if(recentDemoBetween(a.carActor, b.carActor, time)) continue;

        const dirAB = {x: dx / planarDistance, y: dy / planarDistance};
        const aClosing = dot2(a.velocity, dirAB);
        const bClosing = dot2(b.velocity, {x:-dirAB.x, y:-dirAB.y});
        const aSpeed = magnitude2(a.velocity);
        const bSpeed = magnitude2(b.velocity);
        const aClear = aSpeed >= 1200 && aClosing >= 850 && aClosing - Math.max(0, bClosing) >= 450;
        const bClear = bSpeed >= 1200 && bClosing >= 850 && bClosing - Math.max(0, aClosing) >= 450;
        if(aClear === bClear) continue;

        const attacker = aClear ? a : b;
        const victim = aClear ? b : a;
        const closing = aClear ? aClosing : bClosing;
        const victimClosing = aClear ? bClosing : aClosing;
        const pairKey = `${attacker.pri}:${victim.carActor}`;
        const lastTime = lastBumpByCollision.get(pairKey);
        if(Number.isFinite(lastTime) && time - lastTime < 1.1) continue;
        lastBumpByCollision.set(pairKey, time);

        const elapsedSeconds = currentGameElapsedSeconds(time);
        noteObservedElapsed(elapsedSeconds);
        const event = {
          time: Number.isFinite(time) ? time : 0,
          elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
          scoreboardSecondsRemaining,
          scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
          attackerPri: attacker.pri,
          attackerName: attacker.playerName,
          attackerCar: attacker.carActor,
          victimPri: victim.pri,
          victimName: victim.playerName,
          victimCar: victim.carActor,
          distanceUU: Math.round(planarDistance),
          attackerSpeedUU: Math.round(magnitude2(attacker.velocity)),
          victimSpeedUU: Math.round(magnitude2(victim.velocity)),
          closingSpeedUU: Math.round(closing),
          directionAdvantageUU: Math.round(closing - Math.max(0, victimClosing)),
          attackerLocation: attacker.location,
          victimLocation: victim.location,
          source: "conservative-car-contact"
        };
        bumpEvents.push(event);
        addPerPriEvent(bumpEventsByPri, attacker.pri, event);
      }
    }
  }

  function pushPhysicsSamples(time){
    if(!isGameplaySampleTime()){
      excludedDeadBallFrames++;
      return;
    }
    const ballLocation = currentBallLocation();
    if(!ballLocation) return;
    ballSampleCount++;
    const elapsedSeconds = currentGameElapsedSeconds(time);
    noteObservedElapsed(elapsedSeconds);
    const playerSnapshots = activePlayerSnapshots();
    detectKickoffTouchFromPhysics(time, elapsedSeconds, ballLocation, playerSnapshots);
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
      const lastSampleTime = lastPhysicsSampleTimeByPri.get(pri);
      if(Number.isFinite(lastSampleTime) && time - lastSampleTime < PHYSICS_SAMPLE_INTERVAL_SECONDS) continue;

      lastPhysicsSampleTimeByPri.set(pri, time);
      if(!distanceSamplesByPri.has(pri)) distanceSamplesByPri.set(pri, []);
      if(!positionSamplesByPri.has(pri)) positionSamplesByPri.set(pri, []);
      distanceSamplesByPri.get(pri).push({
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        scoreboardSecondsRemaining,
        scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        distanceUU: Math.round(distanceBetweenLocations(car.location, ballLocation)),
        carActor: car.carActor,
        ballLocation,
        carLocation: car.location,
        playerName
      });
      positionSamplesByPri.get(pri).push({
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        scoreboardSecondsRemaining,
        scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        x: Math.round(car.location.x),
        y: Math.round(car.location.y),
        z: Math.round(car.location.z || 0),
        playerName
      });
    }
  }

  for(const frame of frames){
    const time = Number(frame.time ?? frame.seconds ?? frame.delta ?? 0);
    const frameTouchHits = [];
    let scoredOnTeamChange = undefined;

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
      carVel.delete(actorId);
      ballLoc.delete(actorId);
      ballVel.delete(actorId);
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
        const secondsRemaining = validScoreboardSecondsRemaining(
          replayIntValue(attribute, value),
          isOvertime,
          replayElapsedSeconds(time, firstFrameTime, lastFrameTime, totalSeconds)
        );
        if(Number.isFinite(secondsRemaining)){
          scoreboardSecondsRemaining = secondsRemaining;
          scoreboardClockFinalSeconds = secondsRemaining;
          scoreboardClockStartSeconds = SOCCAR_REGULATION_SECONDS;
        }
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:ReplicatedScoredOnTeam")){
        const rawScoredOnTeam = replayIntValue(attribute, value);
        const scoredOnTeam = normalizeScoredOnTeam(rawScoredOnTeam);
        scoredOnTeamChange = scoredOnTeam;
        const elapsedSeconds = currentGameElapsedSeconds(time);
        const overtimeBaseSeconds = SOCCAR_REGULATION_SECONDS;
        goalStateEvents.push({
          time: Number.isFinite(time) ? time : 0,
          elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
          scoreboardSecondsRemaining,
          scoreboardElapsedSeconds: Number(elapsedSeconds.toFixed(3)),
          rawScoredOnTeam,
          scoredOnTeam,
          scoringTeam: scoringTeamFromScoredOnTeam(scoredOnTeam),
          isOvertime,
          overtimeSeconds: isOvertime ? Math.max(0, elapsedSeconds - overtimeBaseSeconds) : null
        });
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_Soccar_TA:bOverTime")){
        const overtimeValue = getObject(attribute, "Boolean") ?? getObject(value, "Boolean");
        if(typeof overtimeValue === "boolean"){
          const enteringOvertime = overtimeValue && !isOvertime;
          isOvertime = overtimeValue;
          if(enteringOvertime) scoreboardSecondsRemaining = 0;
          if(overtimeValue) hasOvertime = true;
        }
      }

      if(objectNameMatches(objectName, "TAGame.GameEvent_TA:ReplicatedRoundCountDownNumber")){
        const rawCountdown = replayIntValue(attribute, value);
        countdownNumber = Number.isFinite(rawCountdown) ? rawCountdown : null;
      }

      const loc = decodeActorLocation(value);
      if(loc){
        if(carActors.has(actorId)) carLoc.set(actorId, loc);
        if(ballActors.has(actorId)){
          ballLoc.set(actorId, loc);
          latestBallLocation = loc;
        }
      }

      const velocity = decodedVelocity(value);
      if(velocity && carActors.has(actorId)) carVel.set(actorId, velocity);
      if(velocity && ballActors.has(actorId)) ballVel.set(actorId, velocity);

      if(objectNameMatches(objectName, "TAGame.Car_TA:ReplicatedDemolishExtended")){
        addDemoEvent(time, attribute);
      }

      if(objectNameMatches(objectName, "TAGame.Ball_TA:HitTeamNum")){
        const hitTeamNumber = replayIntValue(attribute, value);
        if(normalizeTeamNumber(hitTeamNumber) !== null) frameTouchHits.push(hitTeamNumber);
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

    frameTouchHits.forEach(hitTeamNumber=>addTouchEvent(time, hitTeamNumber));
    if(scoredOnTeamChange !== undefined) activeScoredOnTeam = scoredOnTeamChange;
    detectBumps(time);
    pushPhysicsSamples(time);
  }

  const nameAliases = buildReplayNameAliases(parsedReplay, [
    ...new Set([
      ...priName.values(),
      ...shotEvents.map(event=>event.playerName),
      ...goalEvents.map(event=>event.playerName),
      ...saveEvents.map(event=>event.playerName),
      ...touchEvents.map(event=>event.playerName),
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

  function findGoalStateForGoal(goal){
    const teamNumber = normalizeTeamNumber(resolveTeam(goal));
    let best = null;
    let bestDelta = Infinity;
    for(const state of goalStateEvents){
      if(state.scoringTeam === null) continue;
      if(teamNumber !== null && state.scoringTeam !== teamNumber) continue;
      const delta = Math.abs(state.time - goal.time);
      if(delta > 8) continue;
      if(delta < bestDelta){
        best = state;
        bestDelta = delta;
      }
    }
    return best;
  }

  for(const goal of goalEvents){
    const goalState = findGoalStateForGoal(goal);
    if(!goalState) continue;
    goal.scoredOnTeam = goalState.scoredOnTeam;
    goal.scoringTeam = goalState.scoringTeam;
    goal.goalStateTime = goalState.time;
    goal.goalStateElapsedSeconds = goalState.elapsedSeconds;
    goal.validatedByScoredOnTeam = true;
  }

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
        touchEvents: [],
        demoEvents: [],
        bumpEvents: [],
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
      const shotTeam = normalizeTeamNumber(resolveTeam(shot));
      const goalScoringTeam = normalizeTeamNumber(goal.scoringTeam);
      if(shotTeam !== null && goalScoringTeam !== null && shotTeam !== goalScoringTeam) continue;
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

  function projectedSavedShotPlacement(shot, save, teamNumber){
    const saveLocation = save?.ballLocation || shot?.ballLocation || null;
    if(!saveLocation) return null;

    const candidates = [];
    if(save?.ballVelocity) candidates.push({origin:saveLocation, vector:save.ballVelocity, source:"save-velocity-projection"});
    if(shot?.ballVelocity && shot?.ballLocation) candidates.push({origin:shot.ballLocation, vector:shot.ballVelocity, source:"shot-velocity-projection"});
    if(shot?.ballLocation && save?.ballLocation){
      candidates.push({
        origin:saveLocation,
        vector:{
          x:(save.ballLocation.x || 0) - (shot.ballLocation.x || 0),
          y:(save.ballLocation.y || 0) - (shot.ballLocation.y || 0),
          z:(save.ballLocation.z || 0) - (shot.ballLocation.z || 0)
        },
        source:"shot-save-path-projection"
      });
    }

    for(const candidate of candidates){
      const projected = projectedGoalEntryLocation(candidate.origin, candidate.vector, teamNumber);
      if(projected) return {location:projected, source:candidate.source};
    }

    return null;
  }

  function projectedMissPlacement(shot, teamNumber){
    const candidates = [];
    if(shot?.ballLocation && shot?.ballVelocity){
      candidates.push({origin:shot.ballLocation, vector:shot.ballVelocity, source:"miss-backboard-projection"});
    }
    if(shot?.lastTouchLocation && shot?.ballLocation){
      candidates.push({
        origin:shot.ballLocation,
        vector:{
          x:(shot.ballLocation.x || 0) - (shot.lastTouchLocation.x || 0),
          y:(shot.ballLocation.y || 0) - (shot.lastTouchLocation.y || 0),
          z:(shot.ballLocation.z || 0) - (shot.lastTouchLocation.z || 0)
        },
        source:"miss-touch-path-projection"
      });
    }

    for(const candidate of candidates){
      const projected = projectedBackboardImpactLocation(candidate.origin, candidate.vector, teamNumber);
      if(projected) return {location:projected, source:candidate.source};
    }

    return null;
  }

  for(const shot of shotEvents){
    const playerName = resolveName(shot.playerName);
    const censoredName = censoredAliases.get(playerName) || (isMaskedReplayName(shot.playerName) ? shot.playerName : null);
    const teamNumber = normalizeTeamNumber(resolveTeam(shot));
    let result = "miss";
    let placementLocation = shot.ballLocation || shot.shooterLocation;
    let placementSource = "shot";
    let saveLocation = null;
    let ballSpeedVelocity = shot.ballVelocity || null;
    let ballSpeedSource = "shot";

    const goalIndex = findMatchingGoal(shot);
    if(goalIndex !== null){
      const goal = goalEvents[goalIndex];
      usedGoals.add(goalIndex);
      result = "goal";
      placementLocation = goal.ballLocation || placementLocation;
      placementSource = "goal";
      ballSpeedVelocity = goal.ballVelocity || ballSpeedVelocity;
      ballSpeedSource = goal.ballVelocity ? "goal" : ballSpeedSource;
      shot.nearestOpponentDistanceUU = goal.nearestOpponentDistanceUU;
      shot.nearestOpponent = goal.nearestOpponent;
      shot.goalTime = goal.goalTime || shot.goalTime;
      shot.isOvertime = !!goal.isOvertime;
      shot.overtimeSeconds = goal.overtimeSeconds;
      shot.scoredOnTeam = goal.scoredOnTeam;
      shot.validatedByScoredOnTeam = !!goal.validatedByScoredOnTeam;
    }else{
      const saveIndex = findMatchingSave(shot, teamNumber);
      if(saveIndex !== null){
        const save = saveEvents[saveIndex];
        usedSaves.add(saveIndex);
        result = "save";
        const projectedSave = projectedSavedShotPlacement(shot, save, teamNumber);
        saveLocation = save.ballLocation || null;
        placementLocation = projectedSave?.location || clampedGoalFaceLocation(save.ballLocation || placementLocation, teamNumber) || placementLocation;
        placementSource = projectedSave?.source || "save";
        ballSpeedVelocity = save.ballVelocity || ballSpeedVelocity;
        ballSpeedSource = save.ballVelocity ? "save" : ballSpeedSource;
        shot.nearestOpponentDistanceUU = save.nearestOpponentDistanceUU;
        shot.nearestOpponent = save.nearestOpponent;
        shot.defender = resolveName(save.playerName);
        shot.goalTime = save.goalTime || shot.goalTime;
        shot.isOvertime = !!save.isOvertime;
        shot.overtimeSeconds = save.overtimeSeconds;
      }else{
        const projectedMiss = projectedMissPlacement(shot, teamNumber);
        if(projectedMiss){
          placementLocation = projectedMiss.location;
          placementSource = projectedMiss.source;
        }
      }
    }

    const face = goalFaceFromReplayLocation(placementLocation, teamNumber);
    addSample(playerName, censoredName, {
      result,
      elapsedSeconds: Number(shot.elapsedSeconds.toFixed(3)),
      scoreboardSecondsRemaining: shot.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: shot.scoreboardElapsedSeconds,
      isOvertime: !!shot.isOvertime,
      overtimeSeconds: shot.overtimeSeconds,
      goalTime: shot.goalTime || scoreboardClockLabel(shot.scoreboardSecondsRemaining),
      xPercent: Number(face.xPercent.toFixed(2)),
      yPercent: Number(face.yPercent.toFixed(2)),
      nearestOpponentDistanceUU: shot.nearestOpponentDistanceUU,
      nearestOpponent: shot.nearestOpponent ? resolveName(shot.nearestOpponent) : null,
      defender: shot.defender || (shot.nearestOpponent ? resolveName(shot.nearestOpponent) : null),
      scoredOnTeam: shot.scoredOnTeam,
      validatedByScoredOnTeam: !!shot.validatedByScoredOnTeam,
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
      ballSpeedUUPerSecond: Number.isFinite(vectorSpeed(ballSpeedVelocity)) ? Math.round(vectorSpeed(ballSpeedVelocity)) : null,
      ballSpeedSource,
      placementLocation,
      placementProjectionSource: placementSource.includes("projection") ? placementSource : null,
      saveLocation,
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
      isOvertime: !!goal.isOvertime,
      overtimeSeconds: goal.overtimeSeconds,
      goalTime: goal.goalTime || scoreboardClockLabel(goal.scoreboardSecondsRemaining),
      xPercent: Number(face.xPercent.toFixed(2)),
      yPercent: Number(face.yPercent.toFixed(2)),
      nearestOpponentDistanceUU: goal.nearestOpponentDistanceUU,
      nearestOpponent: goal.nearestOpponent ? resolveName(goal.nearestOpponent) : null,
      scoredOnTeam: goal.scoredOnTeam,
      validatedByScoredOnTeam: !!goal.validatedByScoredOnTeam,
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
      ballSpeedUUPerSecond: Number.isFinite(vectorSpeed(goal.ballVelocity)) ? Math.round(vectorSpeed(goal.ballVelocity)) : null,
      ballSpeedSource: "goal",
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
    const rawDistanceSamples = samples.map(sample=>({
      elapsedSeconds: sample.elapsedSeconds,
      scoreboardSecondsRemaining: sample.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: sample.scoreboardElapsedSeconds,
      distanceUU: sample.distanceUU,
      carActor: sample.carActor,
      carLocation: sample.carLocation,
      ballLocation: sample.ballLocation,
      playerName: sample.playerName
    }));
    const rawPositionSamples = (positionSamplesByPri.get(pri) || []).map(sample=>({
      elapsedSeconds: sample.elapsedSeconds,
      scoreboardSecondsRemaining: sample.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: sample.scoreboardElapsedSeconds,
      x: sample.x,
      y: sample.y,
      z: sample.z,
      playerName: sample.playerName
    }));
    player.distanceToBallSamples = resampleDistanceSamples(rawDistanceSamples);
    player.positionSamples = resamplePositionSamples(rawPositionSamples);
    player.touchEvents = (touchEventsByPri.get(pri) || []).map(event=>({
      time: event.time,
      elapsedSeconds: event.elapsedSeconds,
      scoreboardSecondsRemaining: event.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: event.scoreboardElapsedSeconds,
      isOvertime: event.isOvertime,
      overtimeSeconds: event.overtimeSeconds,
      carBallDistance: event.carBallDistance,
      carLocation: event.carLocation,
      ballLocation: event.ballLocation,
      source: event.source
    }));
    player.stats = {
      ...(player.stats || {}),
      touches: player.touchEvents.length,
      demos: (demoEventsByPri.get(pri) || []).length,
      bumps: (bumpEventsByPri.get(pri) || []).length
    };
    player.demoEvents = (demoEventsByPri.get(pri) || []).map(event=>({
      time: event.time,
      elapsedSeconds: event.elapsedSeconds,
      scoreboardSecondsRemaining: event.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: event.scoreboardElapsedSeconds,
      victimName: event.victimName,
      attackerLocation: event.attackerLocation,
      victimLocation: event.victimLocation,
      source: event.source
    }));
    player.bumpEvents = (bumpEventsByPri.get(pri) || []).map(event=>({
      time: event.time,
      elapsedSeconds: event.elapsedSeconds,
      scoreboardSecondsRemaining: event.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: event.scoreboardElapsedSeconds,
      victimName: event.victimName,
      distanceUU: event.distanceUU,
      attackerSpeedUU: event.attackerSpeedUU,
      victimSpeedUU: event.victimSpeedUU,
      closingSpeedUU: event.closingSpeedUU,
      directionAdvantageUU: event.directionAdvantageUU,
      attackerLocation: event.attackerLocation,
      victimLocation: event.victimLocation,
      source: event.source
    }));
  }

  for(const [pri, events] of touchEventsByPri){
    const rawName = cleanName(events[0]?.playerName || priName.get(pri));
    const playerName = resolveName(rawName);
    const censoredName = censoredAliases.get(playerName) || (isMaskedReplayName(rawName) ? rawName : null);
    const player = ensurePlayer(playerName, censoredName);
    if(!player || player.touchEvents.length) continue;
    player.touchEvents = events.map(event=>({
      time: event.time,
      elapsedSeconds: event.elapsedSeconds,
      scoreboardSecondsRemaining: event.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: event.scoreboardElapsedSeconds,
      isOvertime: event.isOvertime,
      overtimeSeconds: event.overtimeSeconds,
      carBallDistance: event.carBallDistance,
      carLocation: event.carLocation,
      ballLocation: event.ballLocation,
      source: event.source
    }));
    player.stats = {
      ...(player.stats || {}),
      touches: player.touchEvents.length
    };
  }

  for(const [pri, events] of demoEventsByPri){
    const rawName = cleanName(events[0]?.attackerName || priName.get(pri));
    const playerName = resolveName(rawName);
    const censoredName = censoredAliases.get(playerName) || (isMaskedReplayName(rawName) ? rawName : null);
    const player = ensurePlayer(playerName, censoredName);
    if(!player || player.demoEvents.length) continue;
    player.demoEvents = events.map(event=>({
      time: event.time,
      elapsedSeconds: event.elapsedSeconds,
      scoreboardSecondsRemaining: event.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: event.scoreboardElapsedSeconds,
      victimName: event.victimName,
      attackerLocation: event.attackerLocation,
      victimLocation: event.victimLocation,
      source: event.source
    }));
    player.stats = {
      ...(player.stats || {}),
      demos: player.demoEvents.length
    };
  }

  for(const [pri, events] of bumpEventsByPri){
    const rawName = cleanName(events[0]?.attackerName || priName.get(pri));
    const playerName = resolveName(rawName);
    const censoredName = censoredAliases.get(playerName) || (isMaskedReplayName(rawName) ? rawName : null);
    const player = ensurePlayer(playerName, censoredName);
    if(!player || player.bumpEvents.length) continue;
    player.bumpEvents = events.map(event=>({
      time: event.time,
      elapsedSeconds: event.elapsedSeconds,
      scoreboardSecondsRemaining: event.scoreboardSecondsRemaining,
      scoreboardElapsedSeconds: event.scoreboardElapsedSeconds,
      victimName: event.victimName,
      distanceUU: event.distanceUU,
      attackerSpeedUU: event.attackerSpeedUU,
      victimSpeedUU: event.victimSpeedUU,
      closingSpeedUU: event.closingSpeedUU,
      directionAdvantageUU: event.directionAdvantageUU,
      attackerLocation: event.attackerLocation,
      victimLocation: event.victimLocation,
      source: event.source
    }));
    player.stats = {
      ...(player.stats || {}),
      bumps: player.bumpEvents.length
    };
  }

  const sortedPlayers = [...players.values()]
    .map(player=>({
      ...player,
      shotSamples: player.shotSamples.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      touchEvents: player.touchEvents.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      demoEvents: player.demoEvents.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      bumpEvents: player.bumpEvents.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      distanceToBallSamples: player.distanceToBallSamples.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0)),
      positionSamples: player.positionSamples.sort((a,b)=>(a.elapsedSeconds || 0) - (b.elapsedSeconds || 0))
    }))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const scoreboardDurationSeconds = scoreboardDurationSecondsFromClock(
    scoreboardClockStartSeconds,
    scoreboardClockFinalSeconds,
    hasOvertime
  );

  return {
    parser: "rrrocket",
    durationSeconds: Number.isFinite(scoreboardDurationSeconds)
      ? scoreboardDurationSeconds
      : observedElapsedCount ? observedDurationSeconds : Math.ceil(Math.max(totalSeconds, 1)),
    hasOvertime,
    players: sortedPlayers,
    nameAliases: [...nameAliases].map(([censoredName, realName])=>({name:realName, censoredName})),
    totalShotSamples: sortedPlayers.reduce((sum, player)=>sum + player.shotSamples.length, 0),
    totalTouchEvents: sortedPlayers.reduce((sum, player)=>sum + player.touchEvents.length, 0),
    totalDemoEvents: sortedPlayers.reduce((sum, player)=>sum + player.demoEvents.length, 0),
    totalBumpEvents: sortedPlayers.reduce((sum, player)=>sum + player.bumpEvents.length, 0),
    totalDistanceSamples: sortedPlayers.reduce((sum, player)=>sum + player.distanceToBallSamples.length, 0),
    totalPositionSamples: sortedPlayers.reduce((sum, player)=>sum + player.positionSamples.length, 0),
    totalBallSamples: ballSampleCount,
    totalGoalStateEvents: goalStateEvents.length,
    excludedDeadBallFrames,
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
        demoEvents: [],
        bumpEvents: [],
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
    player.supersonicBoostUsed = Number(parsedPlayer.supersonicBoostUsed || 0);
    player.supersonicBoostEvents = Number(parsedPlayer.supersonicBoostEvents || 0);
  }

  for(const parsedPlayer of shotSummary?.players || []){
    const player = ensurePlayer(parsedPlayer.name, parsedPlayer);
    if(!player) continue;
    player.shotSamples = Array.isArray(parsedPlayer.shotSamples) ? parsedPlayer.shotSamples : [];
    player.demoEvents = Array.isArray(parsedPlayer.demoEvents) ? parsedPlayer.demoEvents : [];
    player.bumpEvents = Array.isArray(parsedPlayer.bumpEvents) ? parsedPlayer.bumpEvents : [];
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
    durationSeconds: shotSummary?.durationSeconds ?? Number(parsedReplay?.properties?.TotalSecondsPlayed) ?? null,
    hasOvertime: !!shotSummary?.hasOvertime,
    totalBoostPickups: boostSummary?.totalBoostPickups || 0,
    mappedBoostPickups: boostSummary?.mappedBoostPickups || 0,
    totalShotSamples: shotSummary?.totalShotSamples || 0,
    totalDemoEvents: [...players.values()].reduce((sum, player)=>sum + (Array.isArray(player.demoEvents) ? player.demoEvents.length : 0), 0),
    totalBumpEvents: [...players.values()].reduce((sum, player)=>sum + (Array.isArray(player.bumpEvents) ? player.bumpEvents.length : 0), 0),
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
  const summary = createReplayAnalysisPackage(
    mergeReplayParserSummaries(parsed, boostSummary, shotSummary),
    {source:"rrrocket"}
  );
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(summary));
}

async function handleReplayAnalyze(req, res){
  await handleReplayParse(req, res);
}

async function handleClientHeartbeat(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use POST.");
    return;
  }

  const body = await readRequestBody(req, 16 * 1024);
  let message = {};
  try{
    message = JSON.parse(body.toString("utf8") || "{}");
  }catch{
    message = {};
  }

  const id = String(message.id || "").trim();
  if(id){
    hasSeenClient = true;
    if(message.closing){
      activeClients.delete(id);
    }else{
      activeClients.set(id, Date.now());
    }
  }
  shutdownWhenIdle();
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify({ok:true, activeClients:activeClients.size}));
}

function handleServerInfo(req, res){
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify({
    ok:true,
    app:"SPARK",
    protocolVersion:serverProtocolVersion,
    root,
    pid:process.pid,
    activeClients:activeClients.size,
    livePacketRateEndpoint:true,
    windowControlEndpoint:true
  }));
}

function parseLivePacketRate(text){
  const match = String(text || "").match(/^\s*PacketSendRate\s*=\s*(-?\d+(?:\.\d+)?)\s*$/mi);
  if(!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function normalizeLivePacketRate(value){
  const rate = Math.round(Number(value));
  if(!Number.isFinite(rate) || rate < 0 || rate > 120){
    throw new Error("PacketSendRate must be a number from 0 to 120.");
  }
  return rate;
}

function updateLivePacketRateText(text, rate){
  const normalizedRate = normalizeLivePacketRate(rate);
  const original = String(text || "");
  if(/^\s*PacketSendRate\s*=/mi.test(original)){
    return original.replace(/^(\s*PacketSendRate\s*=\s*)-?\d+(?:\.\d+)?(\s*)$/mi, `$1${normalizedRate}$2`);
  }

  if(/^\s*\[TAGame\.MatchStatsExporter_TA\]\s*$/mi.test(original)){
    return original.replace(
      /^(\s*\[TAGame\.MatchStatsExporter_TA\]\s*(?:\r?\n)?)/mi,
      `$1PacketSendRate=${normalizedRate}\n`
    );
  }

  const ending = original.endsWith("\n") || !original.length ? "" : "\n";
  return `${original}${ending}[TAGame.MatchStatsExporter_TA]\nPacketSendRate=${normalizedRate}\n`;
}

async function handleLivePacketRate(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if(req.method === "GET"){
    const text = await fs.readFile(liveApiStatsConfigPath, "utf8");
    const rate = parseLivePacketRate(text);
    res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
    res.end(JSON.stringify({ok:true, path:liveApiStatsConfigPath, packetSendRate:rate}));
    return;
  }

  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use GET or POST.");
    return;
  }

  const body = await readRequestBody(req, 16 * 1024);
  let message = {};
  try{
    message = JSON.parse(body.toString("utf8") || "{}");
  }catch{
    message = {};
  }
  const rate = normalizeLivePacketRate(message.packetSendRate ?? message.rate);
  const current = await fs.readFile(liveApiStatsConfigPath, "utf8");
  const next = updateLivePacketRateText(current, rate);
  if(next !== current){
    await fs.writeFile(liveApiStatsConfigPath, next, "utf8");
  }

  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify({ok:true, path:liveApiStatsConfigPath, packetSendRate:rate, changed:next !== current}));
}

async function handleTileLayout(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if(req.method === "GET"){
    try{
      const text = await fs.readFile(tileLayoutPath, "utf8");
      const parsed = JSON.parse(text || "{}");
      res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
      res.end(JSON.stringify({ok:true, fileName:path.basename(tileLayoutPath), ...parsed}));
    }catch(err){
      if(err?.code !== "ENOENT") throw err;
      res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
      res.end(JSON.stringify({ok:false, exists:false, fileName:path.basename(tileLayoutPath)}));
    }
    return;
  }

  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use GET or POST.");
    return;
  }

  const body = await readRequestBody(req, 1024 * 1024);
  let message = {};
  try{
    message = JSON.parse(body.toString("utf8") || "{}");
  }catch{
    throw new Error("Invalid layout JSON.");
  }
  if(!message || typeof message !== "object") throw new Error("Invalid layout data.");
  await fs.writeFile(tileLayoutPath, JSON.stringify(message, null, 2), "utf8");
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify({ok:true, fileName:path.basename(tileLayoutPath)}));
}

async function handleOverlayAssetUpload(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use POST.");
    return;
  }

  const body = await readRequestBody(req, 160 * 1024 * 1024);
  let message = {};
  try{
    message = JSON.parse(body.toString("utf8") || "{}");
  }catch{
    throw new Error("Invalid overlay asset JSON.");
  }
  const kind = String(message.kind || "").trim();
  const fileName = overlayAssetKinds.get(kind);
  const dataUrl = String(message.dataUrl || "");
  const match = dataUrl.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)$/);
  if(!fileName || !match) throw new Error("Invalid overlay asset.");

  const mime = String(match[1] || "application/octet-stream").toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if(kind !== "stinger-transition" && !/^image\/(?:png|webp|jpeg)$/.test(mime)) throw new Error("Invalid overlay image.");
  const maxBytes = kind === "stinger-transition" ? 150 * 1024 * 1024 : 8 * 1024 * 1024;
  if(!bytes.length || bytes.length > maxBytes) throw new Error("Overlay asset is too large.");
  await fs.mkdir(overlayAssetDir, {recursive:true});
  if(kind === "stinger-transition"){
    const cleanName = path.basename(String(message.fileName || "stinger-transition"));
    const ext = overlayAssetExtension(cleanName, mime);
    const assetFile = `${fileName}${ext}`;
    await fs.writeFile(path.join(overlayAssetDir, assetFile), bytes);
    await fs.writeFile(path.join(overlayAssetDir, overlayStingerMetaFile), JSON.stringify({fileName:cleanName, mime, assetFile}, null, 2));
  }else{
    await fs.writeFile(path.join(overlayAssetDir, fileName), bytes);
  }
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify({ok:true, url:`/__overlay_asset/${kind}?v=${Date.now()}`}));
}

function overlayAssetExtension(fileName, mime){
  const ext = path.extname(String(fileName || "")).toLowerCase().replace(/[^.\w]/g, "");
  if(ext && ext.length <= 12) return ext;
  const byMime = new Map([
    ["video/webm", ".webm"],
    ["video/mp4", ".mp4"],
    ["video/quicktime", ".mov"],
    ["video/x-matroska", ".mkv"],
    ["video/x-msvideo", ".avi"],
    ["video/mp2t", ".ts"],
    ["video/x-flv", ".flv"],
    ["video/x-m4v", ".m4v"],
    ["image/gif", ".gif"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["application/octet-stream", ".bin"]
  ]);
  return byMime.get(String(mime || "").toLowerCase()) || ".bin";
}

function runPowerShell(script){
  return new Promise((resolve, reject)=>{
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {windowsHide:true}, (error, stdout, stderr)=>{
      if(error){
        reject(new Error(String(stderr || stdout || error.message || "Window control failed").trim()));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

async function handleWindowControl(req, res){
  if(req.method === "OPTIONS"){
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if(req.method !== "POST"){
    res.writeHead(405, {...corsHeaders, "Content-Type":"text/plain; charset=utf-8"});
    res.end("Use POST.");
    return;
  }

  const body = await readRequestBody(req, 16 * 1024);
  let message = {};
  try{
    message = JSON.parse(body.toString("utf8") || "{}");
  }catch{
    message = {};
  }
  const action = String(message.action || "").toLowerCase();
  if(!["minimize","maximize","close","drag"].includes(action)){
    throw new Error("Unsupported window action.");
  }
  if(process.platform !== "win32"){
    res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
    res.end(JSON.stringify({ok:false, reason:"window controls are only available in the Windows app shell"}));
    return;
  }

  const psAction = JSON.stringify(action);
  const script = `
$action = ${psAction}
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SparkWindowControl {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  const int SW_MINIMIZE = 6;
  const int SW_MAXIMIZE = 3;
  const int SW_RESTORE = 9;
  const uint WM_CLOSE = 0x0010;
  const uint WM_NCLBUTTONDOWN = 0x00A1;
  const int HTCAPTION = 2;
  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if(found != IntPtr.Zero || !IsWindowVisible(hWnd)) return true;
      StringBuilder title = new StringBuilder(256);
      StringBuilder cls = new StringBuilder(128);
      GetWindowText(hWnd, title, title.Capacity);
      GetClassName(hWnd, cls, cls.Capacity);
      string t = title.ToString();
      string c = cls.ToString();
      if(t.IndexOf("SPARK", StringComparison.OrdinalIgnoreCase) >= 0 && (c.IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) >= 0 || c.IndexOf("ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) >= 0 || c.IndexOf("WindowsForms10.Window", StringComparison.OrdinalIgnoreCase) >= 0)) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Act(string action) {
    IntPtr hWnd = Find();
    if(hWnd == IntPtr.Zero) return false;
    if(action == "close") return PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    if(action == "minimize") return ShowWindow(hWnd, SW_MINIMIZE);
    if(action == "maximize") return ShowWindow(hWnd, IsZoomed(hWnd) ? SW_RESTORE : SW_MAXIMIZE);
    if(action == "drag") {
      SetForegroundWindow(hWnd);
      ReleaseCapture();
      SendMessage(hWnd, WM_NCLBUTTONDOWN, new IntPtr(HTCAPTION), IntPtr.Zero);
      return true;
    }
    return false;
  }
}
"@
if(-not [SparkWindowControl]::Act($action)){ throw "SPARK app window not found." }
`;
  await runPowerShell(script);
  res.writeHead(200, {...corsHeaders, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify({ok:true, action}));
}

server = http.createServer(async (req,res)=>{
  try{
    const url = new URL(req.url, "http://127.0.0.1");
    if(url.pathname === "/api/spark-heartbeat"){
      await handleClientHeartbeat(req, res);
      return;
    }
    if(url.pathname === "/api/server-info"){
      handleServerInfo(req, res);
      return;
    }
    if(url.pathname === "/api/live-packet-rate"){
      await handleLivePacketRate(req, res);
      return;
    }
    if(url.pathname === "/api/tile-layout"){
      await handleTileLayout(req, res);
      return;
    }
    if(url.pathname === "/api/overlay-asset"){
      await handleOverlayAssetUpload(req, res);
      return;
    }
    if(url.pathname === "/api/window-control"){
      await handleWindowControl(req, res);
      return;
    }
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
    if(url.pathname === "/api/analyze-replay"){
      await handleReplayAnalyze(req, res);
      return;
    }
    if(url.pathname === "/__spark_logo.png" || url.pathname === "/__1ne_logo.png"){
      const data = await fs.readFile(url.pathname === "/__1ne_logo.png" ? oneNeLogoPath : logoPath);
      res.writeHead(200, {"Content-Type":"image/png"});
      res.end(data);
      return;
    }
    if(url.pathname.startsWith("/__overlay_asset/")){
      const kind = path.basename(url.pathname);
      const fileName = overlayAssetKinds.get(kind);
      if(!fileName){
        res.writeHead(404).end("Not found");
        return;
      }
      let assetFile = fileName;
      let contentType = "image/png";
      if(kind === "stinger-transition"){
        const metaRaw = await fs.readFile(path.join(overlayAssetDir, overlayStingerMetaFile), "utf8");
        const meta = JSON.parse(metaRaw || "{}");
        assetFile = path.basename(String(meta.assetFile || ""));
        contentType = String(meta.mime || "application/octet-stream");
        if(!assetFile) throw new Error("Missing stinger transition asset.");
      }
      const data = await fs.readFile(path.join(overlayAssetDir, assetFile));
      res.writeHead(200, {"Content-Type":contentType, "Cache-Control":"no-store"});
      res.end(data);
      return;
    }
    if(url.pathname === "/1NE_Overlay" || url.pathname === "/SPARK_Overlay"){
      const data = await fs.readFile(path.join(root, overlayFileName));
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
});

server.on("upgrade", (req, socket)=>{
  try{
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if(url.pathname === "/api/live-api"){
      acceptLiveApiWebSocket(req, socket);
      return;
    }
  }catch{
  }
  socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
});

server.listen(8765, "127.0.0.1", ()=>console.log("http://127.0.0.1:8765"));
