# SPARK Parser

This folder contains backend replay-analysis modules as SPARK moves processing out of the browser UI.

`replay-analysis-service.mjs` wraps the decoded rrrocket replay output into a richer backend analysis package: team totals, per-player derived summaries, data quality flags, and a compact event timeline.

The lower-level frame decoder still lives in `../static-download-server.mjs` during migration, but browser uploads now call `/api/analyze-replay` so more chart and coaching logic can move here incrementally.
