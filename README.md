# AirDC++ Source

Adds **Direct Connect** (DC++) as a download source for BackIssue, via the
[AirDC++](https://airdcpp-web.github.io/) Web API. DC hubs reach material
that indexers and DDL sites don't. Searches are **adaptive** — they return
as soon as a confident match arrives and give up early on silence — and run
one at a time with a cooldown, so hub rate limits throttle bulk downloads
instead of failing them. Completed downloads are imported as a **copy**; the
original stays in AirDC++ so you keep sharing.

## Install

One click from **Sidebar → Plugins** in BackIssue, or drop this folder into
the app's `plugins/` directory and restart.

## Setup

You need a running AirDC++ instance (its web UI enabled) connected to your
hubs. Then in **Settings → Sources → AirDC++**:

1. **Web API URL** — e.g. `http://192.168.1.10:5600`, plus the web UI
   username/password. Use **Test connection** to verify.
2. **Download folders** — where AirDC++ writes finished downloads (its view)
   and where BackIssue reads that same folder (this app's view); they differ
   only when AirDC++ runs on another machine.
3. Optional: limit searches to specific **hub URLs**, tune search timing,
   and configure **announce bots** — hub bots whose upload announcements are
   scanned so files matching missing issues of followed series download
   automatically by exact hash (schedule it on the Jobs page).

Full guide: <https://backissue.app/airdcpp>
