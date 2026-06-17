# SPARK RL Analyzer

S.P.A.R.K. (Statistical Performance Analysis & Replay Kit) is a local Rocket League replay coaching dashboard.

## SPARK Launcher

On Windows, use `SPARK Launcher.exe` to open the Launcher and HTML App. It is now a native Windows launcher and does not start a hidden PowerShell process.

If Windows blocks unknown executables, use `SPARK Launcher.bat` instead.

On Linux, run:

```bash
chmod +x ./SPARK-Launcher.sh
./SPARK-Launcher.sh
```

The launcher:

- starts the local SPARK server at `http://127.0.0.1:8765/`
- checks that the replay parser is present
- downloads a portable Node.js runtime into `tools/node` if Node.js is not already installed
- the Windows launcher checks GitHub for app updates using `spark-manifest.json`
- opens SPARK in your browser

The local server stays alive while SPARK tabs or OBS overlay sources are open, then shuts itself down shortly after they are all closed.

Do not open `SPARK.html` directly if you want replay parsing (most data comes from the parser as a source). Browser security prevents a plain local HTML file from running the parser, so the boost parser, shooting parser, distance chart, and other replay-position features need the local server.

When enabled by the "Start Live API Feed" button, the launcher also provides SPARK's Live API bridge at `ws://127.0.0.1:8765/api/live-api`. The app tries Rocket League's local feed at `127.0.0.1:49123` first, then falls back to this bridge so live stats can still feed the browser and OBS overlay.

## Replay Parser

The repository includes the Windows parser at `tools/rrrocket/rrrocket-0.11.3-x86_64-pc-windows-msvc/rrrocket.exe`.

If the parser for your platform is missing, the launcher downloads the pinned parser release automatically. Linux uses `rrrocket-0.11.3-x86_64-unknown-linux-musl`.

On launch, SPARK checks the latest upstream rrrocket release. If upstream has a newer parser than SPARK's pinned version, the launcher warns that new Rocket League replays may not process correctly until SPARK includes that parser in its own GitHub release.

## App Updates

The launcher compares local SHA-256 versions against the GitHub `main` manifest and downloads mismatched files.
