# SPARK RL Analyzer

SPARK is a local Rocket League replay coaching dashboard.

## SPARK Launcher on Windows

Use `SPARK Launcher.exe`. It uses the SPARK logo as its Windows icon and opens a small SPARK Launcher window.

If Windows blocks unknown executables, use `SPARK Launcher.bat` instead.

The launcher:

- starts the local SPARK server at `http://127.0.0.1:8765/`
- checks that the replay parser is present
- downloads a portable Node.js runtime into `tools/node` if Node.js is not already installed
- checks GitHub for app updates using `spark-manifest.json`
- opens SPARK in your browser

The local server stays alive while SPARK tabs or OBS overlay sources are open, then shuts itself down shortly after they are all closed.

Do not open `SPARK.html` directly if you want replay parsing. Browser security prevents a plain local HTML file from running the parser, so the boost parser, shooting parser, distance chart, and other replay-position features need the local server.

The launcher also provides SPARK's Live API bridge at `ws://127.0.0.1:8765/api/live-api`. The app tries Rocket League's local feed at `127.0.0.1:49123` first, then falls back to this bridge so live stats can still feed the browser and OBS overlay.

## Included Parser

The repository includes `tools/rrrocket/rrrocket-0.11.1-x86_64-pc-windows-msvc/rrrocket.exe`.

If that parser is missing, the launcher downloads the pinned parser release automatically.

## Manifest Updates

Before publishing changes, refresh the file manifest:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\New-SparkManifest.ps1
```

Commit the changed app files and the refreshed `spark-manifest.json` together. The launcher compares local SHA-256 versions against the GitHub `main` manifest and downloads mismatched files.
