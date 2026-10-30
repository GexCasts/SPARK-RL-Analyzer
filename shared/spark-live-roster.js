(function(root){
  "use strict";

  function value(object, ...keys){
    for(const key of keys) if(object?.[key] != null) return object[key];
    return undefined;
  }

  function identity(raw){
    const name = String(value(raw,"Name","name","PlayerName","playerName") || "").trim();
    const primaryId = String(value(raw,"PrimaryId","primaryId","PrimaryID") || "").trim();
    const rawTeam = value(raw,"TeamNum","teamNum","Team","team");
    const team = rawTeam === 0 || rawTeam === "0" || rawTeam === "Blue" ? "Blue"
      : rawTeam === 1 || rawTeam === "1" || rawTeam === "Orange" ? "Orange" : null;
    const rawShortcut = value(raw,"Shortcut","shortcut");
    const shortcut = rawShortcut != null && Number.isInteger(Number(rawShortcut)) && Number(rawShortcut) > 0 ? Number(rawShortcut) : null;
    return {name,primaryId,team,shortcut};
  }

  class SparkLiveRoster {
    constructor(){ this.players = new Map(); }

    find(raw){
      const id = identity(raw);
      if(id.primaryId) return this.players.get(`id:${id.primaryId}`) || null;
      const candidates = [...this.players.values()].filter(player=>
        (!id.name || player.name.toLowerCase() === id.name.toLowerCase())
        && (!id.team || player.team === id.team)
        && (id.shortcut === null || player.shortcut === id.shortcut));
      return (id.name || id.shortcut !== null) && candidates.length === 1 ? candidates[0] : null;
    }

    upsert(raw){
      const id = identity(raw);
      if(!id.name && !id.primaryId) return null;
      let player = this.find(raw);
      if(!player && id.primaryId){
        const legacy = [...this.players.values()].filter(candidate=>!candidate.primaryId
          && candidate.name.toLowerCase() === id.name.toLowerCase()
          && (!id.team || candidate.team === id.team));
        if(legacy.length === 1){
          player = legacy[0];
          this.players.delete(player.key);
        }
      }
      const key = id.primaryId ? `id:${id.primaryId}` : player?.key || `name:${id.name.toLowerCase()}:${id.team || ""}:${id.shortcut || ""}`;
      if(!player) player = {key,name:id.name,primaryId:id.primaryId,team:null,shortcut:null,
        present:false,onField:false,left:false,boost:0,currentBoost:0,boostKnown:false,
        stats:{score:0,goals:0,shots:0,assists:0,saves:0,demos:0,touches:0}};
      player.key = key;
      if(id.name) player.name = id.name;
      if(id.primaryId) player.primaryId = id.primaryId;
      if(id.shortcut !== null) player.shortcut = id.shortcut;
      this.players.set(key,player);
      return player;
    }

    sync(rawPlayers){
      for(const player of this.players.values()){
        player.present = false;
        player.onField = false;
      }
      for(const raw of rawPlayers){
        const player = this.upsert(raw);
        if(!player) continue;
        const id = identity(raw);
        player.team = id.team;
        player.present = !player.left;
        const hasCar = value(raw,"bHasCar","hasCar","HasCar");
        player.onField = player.present && !!id.team && (hasCar === true || hasCar === 1 || hasCar === "1" || hasCar === "true");
        for(const key of Object.keys(player.stats)){
          const rawStat = value(raw,key,key[0].toUpperCase() + key.slice(1));
          if(rawStat != null && Number.isFinite(Number(rawStat))) player.stats[key] = Number(rawStat);
        }
        const rawBoost = value(raw,"Boost","boost","BoostAmount","boostAmount");
        const boost = rawBoost == null || typeof rawBoost === "boolean" ? NaN : Number(rawBoost);
        player.boostKnown = Number.isFinite(boost);
        player.boost = player.boostKnown ? Math.max(0,Math.min(100,boost > 100 && boost <= 255 ? boost / 2.55 : boost)) : 0;
        player.currentBoost = player.boost;
        player.demos = player.stats.demos;
        player.touches = player.stats.touches;
        player.boostSamples = player.boostKnown ? 1 : 0;
        player.boostSum = player.boost;
      }
    }

    joined(raw){
      const player = this.upsert(raw);
      if(!player) return;
      if(player.left) player.onField = false;
      player.left = false;
      player.present = true;
    }

    left(raw){
      // Keep a tombstone even when the leave arrives before the first snapshot.
      const player = this.find(raw) || this.upsert(raw);
      if(!player) return;
      player.left = true;
      player.present = false;
      player.onField = false;
    }

    active(){ return [...this.players.values()].filter(player=>player.present && player.onField && !player.left); }
    snapshot(){ return this.active().map(player=>({...player,stats:{...player.stats}})); }
    clear(){ this.players.clear(); }
  }

  root.SparkLiveRoster = SparkLiveRoster;
})(globalThis);
