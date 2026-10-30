import assert from "node:assert/strict";
import {test} from "node:test";
import "./spark-live-roster.js";

const player = (id, overrides={})=>({Name:"Alice",PrimaryId:id,TeamNum:0,bHasCar:true,Shortcut:1,Boost:35,...overrides});

test("only confirmed field players from the current snapshot are visible", ()=>{
  const roster = new SparkLiveRoster();
  roster.sync([
    player("a"), player("b",{Name:"Spectator",TeamNum:255}),
    player("c",{Name:"NoCar",bHasCar:false}), player("d",{Name:"UnknownCar",bHasCar:undefined})
  ]);
  assert.deepEqual(roster.active().map(p=>p.primaryId), ["a"]);
  roster.sync([]);
  assert.equal(roster.active().length, 0);
});

test("join alone is not field confirmation; leave wins over stale snapshots", ()=>{
  const roster = new SparkLiveRoster();
  roster.joined({PrimaryId:"a",PlayerName:"Alice"});
  assert.equal(roster.active().length, 0);
  roster.sync([player("a")]);
  assert.equal(roster.active().length, 1);
  roster.left({PrimaryId:"a",PlayerName:"Alice"});
  roster.sync([player("a")]);
  assert.equal(roster.active().length, 0);
  roster.joined({PrimaryId:"a",PlayerName:"Alice"});
  assert.equal(roster.active().length, 0);
  roster.sync([player("a")]);
  assert.equal(roster.active().length, 1);
});

test("early leave tombstones prevent a delayed first snapshot from adding a ghost", ()=>{
  const roster = new SparkLiveRoster();
  roster.left({PrimaryId:"a",PlayerName:"Alice"});
  roster.sync([player("a")]);
  assert.equal(roster.active().length, 0);
});

test("PrimaryId distinguishes duplicate names and survives name/team changes", ()=>{
  const roster = new SparkLiveRoster();
  roster.sync([player("a"),player("b",{Shortcut:2})]);
  assert.equal(roster.active().length, 2);
  assert.equal(roster.find({Name:"Alice"}), null);
  assert.equal(roster.find({Name:"Alice",Shortcut:2}).primaryId, "b");
  roster.sync([player("a",{Name:"NewName",TeamNum:1}),player("b",{Shortcut:2})]);
  assert.equal(roster.players.size, 2);
  assert.equal(roster.find({PrimaryId:"a"}).name, "NewName");
  assert.equal(roster.find({PrimaryId:"a"}).team, "Orange");
  roster.left({PrimaryId:"a",PlayerName:"Alice"});
  assert.deepEqual(roster.active().map(p=>p.primaryId), ["b"]);
});

test("an unknown PrimaryId never removes a different player with the same name", ()=>{
  const roster = new SparkLiveRoster();
  roster.sync([player("a")]);
  roster.left({PrimaryId:"not-a",PlayerName:"Alice"});
  assert.deepEqual(roster.active().map(p=>p.primaryId), ["a"]);
});

test("missing players and players who become spectators disappear without a leave event", ()=>{
  const roster = new SparkLiveRoster();
  roster.sync([player("a"),player("b",{Name:"Bobby",Shortcut:2})]);
  roster.sync([player("a",{TeamNum:255})]);
  assert.equal(roster.active().length, 0);
  roster.sync([player("b",{Name:"Bobby",Shortcut:2})]);
  assert.deepEqual(roster.active().map(p=>p.primaryId), ["b"]);
});

test("a legacy identity is promoted without duplication once PrimaryId arrives", ()=>{
  const roster = new SparkLiveRoster();
  roster.sync([player(undefined)]);
  roster.sync([player("a")]);
  assert.equal(roster.players.size, 1);
  assert.equal(roster.active()[0].primaryId, "a");
});

test("completed-match snapshot survives empty field snapshots and leaves", ()=>{
  const roster = new SparkLiveRoster();
  roster.sync([player("a",{Goals:2})]);
  const final = roster.snapshot();
  roster.left({PrimaryId:"a"});
  roster.sync([]);
  assert.equal(final.length, 1);
  assert.equal(final[0].stats.goals, 2);
  assert.equal(roster.active().length, 0);
});

test("new-match reset clears old leave tombstones", ()=>{
  const roster = new SparkLiveRoster();
  roster.left({PrimaryId:"a",PlayerName:"Alice"});
  roster.clear();
  roster.sync([player("a")]);
  assert.equal(roster.active().length, 1);
});
