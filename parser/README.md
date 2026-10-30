# SPARK Parser

This folder contains backend replay-analysis modules as SPARK moves processing out of the browser UI.

`replay-analysis-service.mjs` wraps the decoded rrrocket replay output into a richer backend analysis package: team totals, per-player derived summaries, data quality flags, and a compact event timeline.

The lower-level frame decoder still lives in `../static-download-server.mjs` during migration, but browser uploads now call `/api/analyze-replay` so more chart and coaching logic can move here incrementally.

Live pickup maps and boost-management pickup counters use spectator `BoostPickup` events directly. They do not infer pickups from boost changes. Events flagged as replay playback, events after match end, and events for a different active match are excluded. Pickup type comes from `BoostType`, independently of the amount actually granted. Saved replay uploads retain the rrrocket decoder because live API events are not stored in the uploaded replay data.

Run the focused integration regressions with `node --test parser/boost-pickup.test.mjs` from the repository root. The tests execute the shipped HTML/backend functions and cover pickup classification, map/counter agreement, replay filtering, match boundaries, dashboard rebuilds, legacy replay data, and bridge reconnect caching.

Shooting heatmap misses and post/crossbar hits prefer an explicitly available after-contact ball speed, displayed under the existing "Shot speed" label. Live crossbar events use the latest unambiguous `BallHit.PostHitSpeed` from the same round and player; goals and saves retain their existing measurements. Ball contacts alone do not create shot markers or infer missing shot placements. Replay uploads without after-contact data retain their existing decoded shot speeds. Run `node --test parser/shot-speed.test.mjs` for the focused speed regressions.

Broadcast scene lifecycle: `MatchEnded` latches postgame results; `PodiumStart` triggers the stats transition without waiting for the fallback delay. `MatchDestroyed` cuts directly to the current stats/heatmap scene, bypassing any outstanding stinger delay before lobby time. Results remain until a different match's `MatchInitialized` (first countdown), or `RoundStarted` if initialization was missed. Reconnect recovery requires a different match GUID, explicitly non-replay/non-winner state, confirmed field players, and clock progress across snapshots. Lobby creation, camera targets, and static clocks cannot reset postgame. Manual normal-overlay commands retain priority. The recent-replay heatmap candidate window remains 120000 ms.

Run `node --test parser/match-scenes.test.mjs` for scene lifecycle, delayed/reordered packets, stinger-loading requeue protection, manual overrides, and replay-window regressions.
