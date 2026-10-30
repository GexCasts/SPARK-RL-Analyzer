# SPARK Shared

This folder contains shared data contracts, settings, and utility modules used by the analyzer, parser, launcher, and overlay.

`spark-data-contract.mjs` defines the backend replay-analysis contract version used by `/api/analyze-replay`.

`spark-live-roster.js` is the shared browser/controller overlay roster. `PrimaryId` is authoritative; names and spectator shortcuts are only unambiguous fallbacks. Live rows require a current `UpdateState` entry with a Blue/Orange team and `bHasCar: true`. Joining alone does not prove field presence. Leaves hide immediately and remain hidden through delayed snapshots until a join; snapshot omission, spectator changes, and disconnects also hide live rows. Goal/touch events never create visible roster entries. Completed-match scoreboard membership is captured separately from current field presence.

Run `node --test shared/live-roster.test.mjs parser/boost-pickup.test.mjs parser/shot-speed.test.mjs` from the repository root for the JavaScript regressions. The equivalent native personal-overlay checks are in `parser/live-roster-native.test.cs`; compile alongside `SPARK-PersonalOverlay.cs` with entry point `SparkPersonalOverlay.RosterTests` and the same framework references as the personal-overlay build.
