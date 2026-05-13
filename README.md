# SPARK RL Analyzer

SPARK is a local Rocket League replay coaching dashboard.

## SPARK Launcher on Windows

Use `SPARK Launcher.exe`. It uses the SPARK logo as its Windows icon.

If Windows blocks unknown executables, use `SPARK Launcher.bat` instead.

The launcher:

- starts the local SPARK server at `http://127.0.0.1:8765/`
- checks that the replay parser is present
- downloads a portable Node.js runtime into `tools/node` if Node.js is not already installed
- opens SPARK in your browser

Do not open `SPARK.html` directly if you want replay parsing. Browser security prevents a plain local HTML file from running the parser, so the boost parser, shooting parser, distance chart, and other replay-position features need the local server.

## Included Parser

The repository includes `tools/rrrocket/rrrocket-0.11.1-x86_64-pc-windows-msvc/rrrocket.exe`.

If that parser is missing, the launcher downloads the pinned parser release automatically.
