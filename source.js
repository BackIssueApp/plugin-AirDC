// The AirDC++ download source. An "immediate" source: find() runs an adaptive
// DC search (poll results, early-exit on a confident match), fetch() queues the
// chosen result in AirDC++ and watches the bundle to completion, then hands the
// finished file to core for import (copied — the AirDC++ copy stays, so it keeps
// sharing, DC etiquette). fetchPack() does the same for a directory result.
//
// NOTE: result/bundle field names below follow the AirDC++ Web API; they are
// verified against a live instance during development.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import config from '../../src/config.js';
import { scoreRelease, suspiciouslySmall, manualQueries, manualTarget, normalizeSeries } from '../../src/sources/usenet.js';
import { seriesCollectionDetail } from '../../src/db.js';
import { makeAirClient } from './http.js';
import { takeHint } from './watch.js';

const COMIC_EXT = new Set(['cbr', 'cbz']);
const waitMs = () => Number(config.airdcppSearchWaitMs) || 12000;
const pollMs = () => Number(config.airdcppSearchPollMs) || 2000;
const cooldownMs = () => Number(config.airdcppSearchCooldownMs) || 3000;
// Give up on a search that's returned NOTHING by this long. A peer that has the
// file replies within a couple of seconds, so continued silence means it isn't
// shared — waiting the full Max-wait on it just slows the not-found tail. The
// full wait still applies once ANY result has arrived (let the set settle).
const emptyMs = () => { const v = Number(config.airdcppSearchEmptyMs); return Number.isFinite(v) && v > 0 ? v : 5000; };
// A single DC hub_search is flaky: some come back EMPTY even when the file is
// shared (it just didn't reach the right peers in the wait window). So a search
// that returns ZERO results is retried this many extra times before we believe
// the file isn't there. (A search that returns results but no MATCH is not
// retried — the file genuinely isn't on DC under that query.)
// KEEP THIS LOW: hubs flag the SAME search repeated ~3 times as spam and then
// return nothing anyway, so 1 (→ 2 identical searches max) stays under that; 0
// disables retries for stricter hubs.
const searchRetries = () => { const v = Number(config.airdcppSearchRetries); return Number.isFinite(v) ? Math.max(0, v) : 1; };

// DC is a SERIAL-search protocol: hubs rate-limit searches, and AirDC++ queues
// them behind a per-hub cooldown. Firing many concurrent searches (a bulk
// download of 200 issues across 4 workers) backs that queue up — and a find()
// that gives up and removes its instance CANCELS the still-queued search, so it
// returns nothing ("no match"). So run AirDC++ searches strictly one at a time,
// spaced by a cooldown. Serial search naturally throttles the whole source.
let searchGate = Promise.resolve();
let nextSearchAt = 0;
export function resetSearchThrottle() { searchGate = Promise.resolve(); nextSearchAt = 0; } // test seam
function serializeSearch(fn) {
  const run = searchGate.then(async () => {
    const wait = nextSearchAt - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); }
    finally { nextSearchAt = Date.now() + cooldownMs(); } // space the NEXT search
  });
  searchGate = run.then(() => {}, () => {}); // keep the chain alive through errors
  return run;
}

// A result is a directory (a whole-series folder → pack) or a file. Map either
// to our normalized shape; the search instance id + result id let us download.
// The peer (user) and parent folder are kept too — they're what lets a file hit
// become a FOLDER pack (browse that peer's folder via filelist, cherry-pick).
export function mapResult(r, instanceId) {
  const isDir = r?.type?.id === 'directory';
  const ext = String(r?.type?.str || '').toLowerCase();
  const u = r?.users?.user || r?.user || null;
  return {
    source: 'airdcpp',
    name: r?.name || '',
    size: Number(r?.size) || 0,
    resultId: r?.id,
    searchInstanceId: instanceId,
    isPack: isDir,
    ext: isDir ? null : ext,
    slots: r?.slots || null,          // { free, total } — source availability
    hits: r?.hits || 0,               // how many users have it
    dir: r?.path ? String(r.path).replace(/[^\\/]+$/, '') : null, // parent folder on the peer
    user: u ? { cid: u.cid, hub_url: u.hub_url, nicks: u.nicks || '' } : null,
  };
}

// DC hub search matches against file/dir NAMES, which can't contain characters
// like ':' '?' '/' '\' '*' '"' '<' '>' '|'. A query carrying one (e.g. a series
// titled "Avengers: Armageddon") matches nothing, even though the release file
// ("Avengers Armageddon 001 …") is right there. Strip those to spaces and
// collapse — releases never have them, so this only ever helps the match.
export function dcPattern(s) {
  return String(s || '').replace(/[:*?"<>|/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Run one adaptive search: create an instance, send the query to the hubs, then
// poll results until `accept` is satisfied (early-exit) or the wait cap is hit.
// Returns { instanceId, results } — the caller decides whether to keep the
// instance (for a download) or remove it. `accept(mapped)` → truthy to stop.
export function runSearch(client, { pattern, fileType = 'file', extensions = [...COMIC_EXT], hubs = null }, accept = null) {
  // Serialized: only one AirDC++ search runs at a time (see serializeSearch).
  return serializeSearch(async () => {
    const instanceId = await client.createSearchInstance();
    if (instanceId == null) throw new Error('could not create a search instance');
    await client.hubSearch(instanceId, { pattern: dcPattern(pattern), fileType, extensions, hubs });
    const start = Date.now();
    const deadline = start + waitMs();
    const emptyDeadline = start + emptyMs();
    let mapped = [];
    let stableFor = 0, lastCount = 0;
    // DC results arrive from peers over seconds; poll and stop early once we have
    // what we need (a match) or the result set has some entries and stops growing.
    // A search that's STILL empty past the empty-deadline is almost certainly
    // not shared — give up rather than burn the full Max-wait on it.
    while (Date.now() < deadline) {
      await sleep(pollMs());
      const raw = await client.getResults(instanceId, 0, 100);
      mapped = raw.map((r) => mapResult(r, instanceId));
      if (accept && mapped.some(accept)) break;
      if (mapped.length > 0 && mapped.length === lastCount) { if (++stableFor >= 2) break; }
      else stableFor = 0;
      lastCount = mapped.length;
      if (mapped.length === 0 && Date.now() >= emptyDeadline) break; // nothing shared → stop waiting
    }
    return { instanceId, results: mapped };
  });
}

const hubList = () => String(config.airdcppHubs || '').split(',').map((s) => s.trim()).filter(Boolean);

// --- Series-level search sharing -------------------------------------------
// A DC search for a SERIES NAME returns the whole run in one shot, so a bulk
// grab of 10 issues of one series should cost ONE hub search, not ten — with
// serialized searches (3s cooldown each) per-issue searching is what made bulk
// grabs crawl. find() first consults a short-lived cache of series searches;
// the cache stores the IN-FLIGHT promise, so concurrent workers grabbing the
// same series join one search instead of queuing their own.
// TTL is short because results carry a live search-instance id — AirDC++
// expires instances after ~5 min idle (and relocate() covers a stale one).
const SERIES_TTL_MS = 4 * 60 * 1000;
const seriesSearches = new Map(); // seriesKey → { at, promise }
export function seriesKey(name) { return dcPattern(name).toLowerCase(); }
export function clearSeriesSearches() { seriesSearches.clear(); } // test seam
function seriesSearch(client, name, accept) {
  const key = seriesKey(name);
  const hit = seriesSearches.get(key);
  if (hit && Date.now() - hit.at < SERIES_TTL_MS) return { entry: hit, created: false };
  const entry = { at: Date.now() };
  entry.promise = runSearch(client, { pattern: dcPattern(name), hubs: hubList() }, accept)
    .catch((e) => { seriesSearches.delete(key); throw e; });
  seriesSearches.set(key, entry);
  return { entry, created: true };
}

// Read EVERYTHING the instance has accumulated (paged; getResults caps a page
// at 100). DC peers keep replying for a while after the search ends, so this is
// re-read on every find() — a local AirDC++ call, no hub traffic — and later
// issues of a bulk grab see a fuller result set than the first did.
async function pageResults(client, instanceId, maxPages = 6) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await client.getResults(instanceId, page * 100, 100);
    all.push(...batch.map((r) => mapResult(r, instanceId)));
    if (batch.length < 100) break;
  }
  return all;
}

// Copies (by TTH) that downloaded fine but turned out to be CORRUPT — DC's TTH
// verifies the transfer matches what the PEER has, not that the peer's file is
// a valid archive. Blacklisted for this run so retries pick a different copy.
const badCopies = new Set();

// Sniff the finished file's magic bytes: ZIP (PK), RAR (Rar!), or PDF. DC
// transfers can complete 'successfully' with garbage when the PEER's file is
// corrupt (TTH matches their corrupt bytes).
export async function looksLikeComicArchive(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return true;            // ZIP
    const sig = buffer.toString('latin1');
    return sig === 'Rar!' || sig === '%PDF';
  } catch { return false; }
  finally { await fh?.close(); }
}
// Shallow recursive search for a file named exactly `name` under `root`.
// AirDC++ may drop a download in a per-bundle subfolder, so we look a couple
// of levels deep, not just the root.
async function findFileByName(root, name, depth = 2) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(root, e.name);
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = await findFileByName(path.join(root, e.name), name, depth - 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// Where is AirDC++'s on-disk copy of `name`? Our idea of the download folder
// (airdcppDownloadDir) can differ from AirDC++'s actual one, so check both
// roots with a shallow scan. Returns { path, valid } for a found file, or
// { path: null } when it genuinely isn't under either root.
export async function resolveOnDiskCopy(name, remoteDir) {
  const roots = [...new Set([config.airdcppDownloadDir, remoteDir].filter(Boolean))];
  for (const root of roots) {
    const hit = await findFileByName(root, name);
    if (hit) return { path: hit, valid: await looksLikeComicArchive(hit) };
  }
  return { path: null, valid: false };
}

export function markBadCopy(tth) { badCopies.add(tth); }
export function clearBadCopies() { badCopies.clear(); } // test seam
export function isBadCopy(tth) { return badCopies.has(tth); }

export const airdcpp = {
  id: 'airdcpp',
  label: 'airdcpp',
  kind: 'immediate',
  isEnabled: (cfg) => !!cfg?.airdcppEnabled && !!cfg.airdcppHost && !!cfg.airdcppUser,

  async find(ctx) {
    const client = ctx.client || makeAirClient(ctx.config); // ctx.client is a test seam
    const target = manualTarget(ctx);
    const queries = manualQueries(ctx);
    // Accept a comic file whose name matches the wanted series + number —
    // skipping copies already proven corrupt.
    const matches = (m) => !m.isPack && COMIC_EXT.has(m.ext) && !suspiciouslySmall(m.size)
      && !badCopies.has(m.resultId) && scoreRelease(m.name, target) != null;
    const best = (results) => results.filter(matches)
      .map((m) => ({ m, score: scoreRelease(m.name, target) }))
      .sort((a, b) => b.score - a.score || (b.m.hits - a.m.hits) || (b.m.size - a.m.size))[0];

    // Announce-watch fast path: the watcher saw a bot announce EXACTLY this
    // issue with a magnet link — search by its TTH (DC's precise file id)
    // instead of by name. Consumed once; any miss falls through to the normal
    // name search below.
    const cvm = /^cvissue:(\d+)$/.exec(String(ctx.issue?.url || ''));
    const hint = cvm ? takeHint(Number(cvm[1])) : null;
    if (hint) {
      try {
        const search = await runSearch(client, { pattern: hint.tth, fileType: 'tth', extensions: [], hubs: hubList() }, matches);
        const hit = best(search.results);
        if (hit) return { ...hit.m, query: hint.tth };
        await client.removeSearchInstance(search.instanceId).catch(() => {});
      } catch { /* fall through to name search */ }
    }

    // One shared series search serves every issue of a bulk grab (see
    // seriesSearch). Its instance is SHARED — never removed here or after a
    // download; AirDC++ expires it, and relocate() re-finds by query on expiry.
    // Results are RE-PAGED from the live instance each time: peers keep
    // replying after the poll ends, so later issues see a fuller set.
    const name = (ctx.seriesNames && ctx.seriesNames[0]) || ctx.seriesTitle;
    if (name) {
      try {
        const { entry, created } = seriesSearch(client, name, matches);
        const search = await entry.promise;
        // Peers keep replying for a while after the poll returns, so a JOINER's
        // miss on a young instance is often just "hasn't arrived yet" — re-page
        // (local reads only) until the set settles. The CREATOR doesn't wait:
        // its adaptive poll already waited for this very issue.
        for (;;) {
          const hit = best(await pageResults(client, search.instanceId));
          if (hit) return { ...hit.m, searchInstanceId: search.instanceId, query: dcPattern(name), shared: true };
          if (created || Date.now() - entry.at > Math.min(30000, waitMs())) break; // settled — a miss is real
          await sleep(Math.min(2500, pollMs()));
        }
      } catch { /* series search failed → per-issue fallback below */ }
    }

    // Fallback: the shared results didn't cover this issue (rare release naming,
    // >100-result series, partial early-exit set) — search it specifically.
    for (const pattern of queries) {
      // Retry-on-empty: a zero-result search is likely a transient DC miss, so
      // re-search; but stop as soon as ANY results come back (matched or not).
      for (let attempt = 0; attempt <= searchRetries(); attempt++) {
        const search = await runSearch(client, { pattern, hubs: hubList() }, matches);
        const hit = best(search.results);
        // Keep the instance alive for the download (candidate carries its id).
        // Remember the query too: the instance can expire before the download
        // runs, and re-running this query re-locates the same result (by TTH).
        if (hit) return { ...hit.m, query: pattern };
        await client.removeSearchInstance(search.instanceId).catch(() => {}); // no match → free it
        if (search.results.length > 0) break; // got results, none matched → next alias
      }
    }
    return null;
  },

  async fetch(candidate, ctx, onProgress = () => {}) {
    const client = ctx.client || makeAirClient(ctx.config); // ctx.client is a test seam
    if (badCopies.has(candidate.resultId)) throw new Error('this copy already proved corrupt — skipping');
    const srcPath = await downloadAndWait(client, candidate, candidate.name, onProgress);
    // DC's TTH check only proves we received what the peer HAS — peers share
    // corrupt files. Verify the container before handing it to the importer;
    // a bad copy gets deleted (so "file exists on disk" can't re-import it)
    // and its TTH blacklisted (so retries pick a different copy).
    if (!(await looksLikeComicArchive(srcPath))) {
      badCopies.add(candidate.resultId);
      await fsp.unlink(srcPath).catch(() => {});
      throw new Error(`peer's copy is corrupt (not a comic archive) — blacklisted, retry will pick another copy (${candidate.name})`);
    }
    // Leave the file where AirDC++ put it (keep sharing) — core copies it in.
    return { srcPath, keep: true };
  },

  async fetchPack(candidate, ctx, onProgress = () => {}) {
    const client = ctx.client || makeAirClient(ctx.config); // ctx.client is a test seam
    // Folder pack (synthesized from a file hit): browse the peer's folder via
    // filelist and cherry-pick — DC's native way to "download a pack".
    if (candidate.filelist) return fetchFilelistPack(client, candidate, ctx, onProgress);
    // A real directory search result (rare — most hubs don't answer those).
    const dir = await downloadAndWait(client, candidate, candidate.name, onProgress, { directory: true });
    return { dir, keep: true };
  },

  async manualSearch(ctx) {
    if (!airdcpp.isEnabled(ctx.config)) return { results: [] };
    const client = ctx.client || makeAirClient(ctx.config); // ctx.client is a test seam
    const target = manualTarget(ctx);
    const queries = manualQueries(ctx);
    const byId = new Map();
    const searched = [];
    for (const pattern of queries) {
      searched.push(pattern);
      // Retry-on-empty (see find()): a zero-result DC search is often transient.
      let results = [];
      for (let attempt = 0; attempt <= searchRetries(); attempt++) {
        ({ results } = await runSearch(client, { pattern, hubs: hubList() }));
        if (results.length > 0) break;
      }
      for (const m of results) {
        if (!m.isPack && !COMIC_EXT.has(m.ext)) continue; // files must be comics; dirs allowed (packs)
        if (suspiciouslySmall(m.size)) continue;
        if (!byId.has(m.resultId)) byId.set(m.resultId, { ...m, query: pattern, score: scoreRelease(m.name, target), meta: m.isPack ? 'airdcpp · pack' : `airdcpp · ${m.hits} sources` });
      }
      // The instance stays open so a pick can download; AirDC++ expires it.
    }
    const results = [...byId.values()];
    // Synthesize FOLDER pack candidates: hubs on DC don't answer directory-type
    // searches, but every file hit names the peer + folder it lives in. Grabbing
    // one browses that peer's folder via filelist and cherry-picks only the
    // MISSING issues (see fetchPack). Group file hits by peer+folder.
    const folders = new Map();
    for (const m of results) {
      if (m.isPack || !m.user || !m.dir) continue;
      const key = `${m.user.cid}|${m.dir}`;
      const f = folders.get(key) || { files: 0, size: 0, user: m.user, dir: m.dir };
      f.files++; f.size += m.size;
      folders.set(key, f);
    }
    // Rank folders by how many search hits live in them (more matching files →
    // more likely a real series folder, not a mixed 0-day/week dump) and cap the
    // flood — a common series surfaces dozens of 1-hit junk folders. The nick +
    // match count go in the TITLE: several peers often share same-named folders
    // ("Superman" ×3) that are completely different in content.
    const ranked = [...folders.values()].sort((a, b) => b.files - a.files || b.size - a.size).slice(0, 15);
    for (const f of ranked) {
      const folderName = (f.dir.split(/[\\/]/).filter(Boolean).pop() || f.dir);
      const label = `📁 ${folderName} — ${f.user.nicks || 'peer'} (${f.files} match${f.files === 1 ? '' : 'es'})`;
      results.push({
        source: 'airdcpp', isPack: true,
        filelist: { user: { cid: f.user.cid, hub_url: f.user.hub_url }, path: f.dir },
        name: label,
        title: label,
        size: f.size, hits: f.files, seeders: f.files, score: null, // seeders drives core's pack ranking
        meta: 'airdcpp · peer folder — grabs only your missing issues',
      });
    }
    return { results, searched };
  },
};

// AirDC++'s configured download directory (its own filesystem view), used to
// map reported paths onto this app's view. Cached; auto-detected from AirDC++
// when not explicitly configured, so the user needn't know/match it.
let cachedRemoteDir = null;
async function resolveRemoteDir(client) {
  if (config.airdcppDownloadDirRemote) return config.airdcppDownloadDirRemote;
  if (cachedRemoteDir != null) return cachedRemoteDir;
  try { cachedRemoteDir = await client.settingGet('download_directory'); } catch { cachedRemoteDir = ''; }
  return cachedRemoteDir || '';
}

// Map a path AirDC++ reports (its own filesystem view) onto how THIS app reads
// it (e.g. over SMB). Swap the remote download-dir prefix for the local one;
// when they're the same (shared filesystem) the path passes through unchanged.
export function toLocalPath(remoteTarget, remoteDirRaw = config.airdcppDownloadDirRemote) {
  const remoteDir = String(remoteDirRaw || '').replace(/[\\/]+$/, '');
  const localDir = String(config.airdcppDownloadDir || '').replace(/[\\/]+$/, '');
  const t = String(remoteTarget || '');
  if (localDir && remoteDir && t.startsWith(remoteDir)) {
    return localDir + t.slice(remoteDir.length);
  }
  if (localDir) {
    // No/unknown remote prefix — rebase onto the reported basename.
    return path.join(localDir, t.split(/[\\/]/).pop() || '');
  }
  return t; // shared filesystem, or nothing to remap
}

// A search instance from find()/manualSearch() is ephemeral — AirDC++ garbage-
// collects it after a short idle, so by download time it may be gone ("Entity N
// was not found"), especially for a manually-grabbed candidate that sat queued.
// Re-run the query that found it and relocate the SAME result by its TTH
// (resultId is stable), returning a fresh live instance. Returns null if the
// file can no longer be found on the hubs.
async function relocate(client, candidate) {
  const pattern = candidate.query || candidate.name;
  const fileType = candidate.isPack ? 'directory' : 'file';
  for (let attempt = 0; attempt <= searchRetries(); attempt++) {
    const search = await runSearch(client, { pattern, fileType, hubs: hubList() });
    const found = search.results.find((m) => m.resultId === candidate.resultId)
      || search.results.find((m) => m.name === candidate.name && !!m.isPack === !!candidate.isPack);
    if (found) return { instanceId: search.instanceId, resultId: found.resultId };
    await client.removeSearchInstance(search.instanceId).catch(() => {});
    if (search.results.length > 0) break; // results, just not ours → stop
  }
  return null;
}

// Queue a result for download to AirDC++'s dir, then poll the bundle to
// completion, reporting AirDC++'s own byte + speed figures. Returns the finished
// path as THIS app reads it (remote→local mapped for a networked AirDC++).
async function downloadAndWait(client, candidate, name, onProgress, { directory = false } = {}) {
  const remoteDir = await resolveRemoteDir(client); // for mapping the finished path
  onProgress({ phase: 'download', unit: 'bytes', done: 0, total: candidate.size || 0, detail: 'AirDC++' });
  // Let AirDC++ write to its OWN configured download folder (guaranteed
  // writable). Forcing a target_directory AirDC++ can't write to fails the
  // bundle with "Permission denied"; we read the real path from the bundle and
  // map it to how this app reads it instead.
  // The finished path as this app reads it (used when AirDC++ already has the
  // file, so there's nothing to download/poll). Sniffed first: the on-disk copy
  // may be an old corrupt file — importing it blind is how garbage gets in.
  const localFinished = async () => {
    const found = await resolveOnDiskCopy(name, remoteDir);
    if (!found.path) {
      // AirDC++ swears it has the file but we can't find it — re-searching
      // would just hit "already on disk" again (the loop the user sees), so
      // fail once, clearly, with the fix. noRetry stops the queue bounce.
      const e = new Error(`AirDC++ has "${name}" on disk but BackIssue can't find it — set the AirDC++ download folder (airdcppDownloadDir) to AirDC++'s actual download directory.`);
      e.noRetry = true;
      throw e;
    }
    if (!found.valid) {
      // A real corrupt copy: delete + blacklist, and let the queue retry
      // (with the file gone, AirDC++ will download a fresh one).
      badCopies.add(candidate.resultId);
      await fsp.unlink(found.path).catch(() => {});
      throw new Error(`existing on-disk copy is corrupt (not a comic archive) — deleted and blacklisted (${name})`);
    }
    return found.path;
  };
  // AirDC++ refuses to download a file it already has on disk ("File exists on
  // the disk already"). That's a success for us — the wanted file is present and
  // shared; skip the download and import the existing copy.
  const alreadyOnDisk = (e) => /file exists on the disk already/i.test(String(e?.message || ''));
  const startDownload = (instanceId) => client.downloadResult(instanceId, candidate.resultId, {
    targetName: directory ? undefined : name,
    priority: 4,
  });
  let dl;
  try {
    dl = await startDownload(candidate.searchInstanceId);
  } catch (e) {
    if (alreadyOnDisk(e)) {
      // A shared (series-search) instance is still serving other issues — leave
      // it alive; AirDC++ expires it on its own.
      if (!candidate.shared) await client.removeSearchInstance(candidate.searchInstanceId).catch(() => {});
      onProgress({ phase: 'download', unit: 'bytes', done: candidate.size || 0, total: candidate.size || 0, detail: 'AirDC++ (already on disk)' });
      return await localFinished();
    }
    // Expired search instance → re-locate the same result and try once more.
    const expired = e?.status === 404 || /not found/i.test(String(e?.message || ''));
    if (!expired) throw e;
    const fresh = await relocate(client, candidate);
    if (!fresh) throw new Error(`AirDC++ lost the search result before download (${name})`);
    candidate.searchInstanceId = fresh.instanceId;
    candidate.resultId = fresh.resultId;
    try {
      dl = await startDownload(fresh.instanceId);
    } catch (e2) {
      if (!alreadyOnDisk(e2)) throw e2;
      await client.removeSearchInstance(fresh.instanceId).catch(() => {});
      onProgress({ phase: 'download', unit: 'bytes', done: candidate.size || 0, total: candidate.size || 0, detail: 'AirDC++ (already on disk)' });
      return await localFinished();
    }
  }
  const bundleId = dl?.bundle_info?.id;
  if (bundleId == null) throw new Error('AirDC++ did not return a bundle id');

  // Stall guard: a bundle with no seeders can sit at partial progress forever,
  // and a finished bundle can be auto-removed from the queue (getBundle → 404).
  // Without a bound, the poll loop hangs the worker and pins the issue in
  // 'downloading'. Bail if there's no byte progress for this long.
  const stallMs = Math.max(60000, Number(config.airdcppDownloadStallMs) || 300000);
  let target = null;
  let lastBytes = 0, lastSize = Number(candidate.size) || 0;
  let sawBundle = false;
  let stallSince = Date.now();
  for (;;) {
    await sleep(Math.max(1000, pollMs()));
    let b;
    try { b = await client.getBundle(bundleId); }
    catch (e) {
      // A completed bundle that AirDC++ dropped from the queue 404s here. If we
      // last saw it fully downloaded, it finished — proceed to import.
      if (e?.status === 404 && sawBundle && lastSize > 0 && lastBytes >= lastSize) break;
      if (Date.now() - stallSince > stallMs) throw new Error('AirDC++ bundle went missing before completing');
      continue;
    }
    sawBundle = true;
    target = b?.target || target;
    if (b?.status?.failed) throw new Error(`AirDC++ couldn't finish the download (${b?.status?.str || 'failed'})${target ? ' → ' + target : ''}`);
    const bytes = Number(b?.downloaded_bytes) || 0;
    lastSize = Number(b?.size) || lastSize;
    if (bytes > lastBytes) { lastBytes = bytes; stallSince = Date.now(); } // progress resets the clock
    onProgress({
      phase: 'download', unit: 'bytes',
      done: bytes,
      total: lastSize || candidate.size || 0,
      bps: Number(b?.speed) || 0,   // AirDC++ reports the speed
      detail: 'AirDC++',
    });
    if (b?.status?.completed) break;
    if (Date.now() - stallSince > stallMs) throw new Error('AirDC++ download stalled (no progress)');
  }
  // Done with the instance — unless it's the shared series search, which other
  // issues of this bulk grab still download from (AirDC++ expires it itself).
  if (!candidate.shared) await client.removeSearchInstance(candidate.searchInstanceId).catch(() => {});
  // Prefer the exact path AirDC++ reported (handles any subdir it added), mapped
  // onto this app's view using AirDC++'s real download dir.
  return target ? toLocalPath(target, remoteDir) : path.join(config.airdcppDownloadDir || remoteDir || '', name);
}

// ---- Filelist packs ---------------------------------------------------------
// "Download a pack" the DC-native way: open the peer's folder as a (partial)
// filelist — a direct peer connection, no hub search, no reply caps — match its
// contents against the series' MISSING issues, and queue exactly those files by
// TTH (so AirDC++ sources each from ANY peer sharing it, not just this one).
// The staged subdir is handed back for processPack to import; files stay put
// (keep: true) so they're shared onward, DC etiquette.

// The series' missing issue numbers. [] → nothing missing (refuse the grab);
// null → unknown (no db/seriesId or lookup failed → take all comics,
// processPack dedupes).
export function wantedNumbers(ctx) {
  try {
    if (!ctx?.db || !ctx?.seriesId) return null;
    const d = seriesCollectionDetail(ctx.db, ctx.seriesId);
    return (d?.issues || []).filter((i) => !i.owned).map((i) => i.number).filter((n) => n != null && n !== '');
  } catch { return null; }
}

// Pick the folder's comic files worth downloading: comics only, not tiny, and —
// when the missing set is known — ONE file per missing issue of THIS series
// (folders carry repacks/variants of the same issue; queueing them all wastes
// bandwidth and floods the import with dupes). Best variant = highest release
// score, then larger file.
export function selectPackFiles(items, { seriesTitle, seriesNames, wanted }) {
  const comics = (items || []).filter((it) =>
    it?.type?.id === 'file' && /\.(cbr|cbz)$/i.test(it.name || '') && !suspiciouslySmall(it.size));
  if (!wanted) return comics;
  const names = (seriesNames && seriesNames.length) ? seriesNames : [seriesTitle].filter(Boolean);
  const picked = [];
  for (const n of wanted) {
    const bestVariant = comics
      .map((it) => ({ it, score: scoreRelease(it.name, { series: seriesTitle, names, number: n }) }))
      .filter((x) => x.score != null)
      .sort((a, b) => b.score - a.score || (b.it.size - a.it.size))[0];
    if (bestVariant) picked.push(bestVariant.it);
  }
  return picked;
}

// AirDC++'s download dir as AIRDC++ knows it — always the settings API, never
// the user's airdcppDownloadDirRemote override. That override exists for
// remote→local path MAPPING and may be case-wrong (e.g. '/downloads' vs the
// real '/Downloads'); building a WRITE path from it makes every file bundle
// fail with 'No such file or directory' on a case-sensitive NAS.
let cachedTrueRemoteDir = null;
async function trueRemoteDir(client) {
  if (cachedTrueRemoteDir != null) return cachedTrueRemoteDir;
  try { cachedTrueRemoteDir = await client.settingGet('download_directory'); } catch { cachedTrueRemoteDir = ''; }
  return cachedTrueRemoteDir || config.airdcppDownloadDirRemote || '';
}

// List one directory of a peer's share (partial filelist: open → loaded → page
// items → close).
async function listPeerFolder(client, user, dir) {
  const open = await client.openFilelist(user, dir);
  const flid = open?.id || user.cid;
  const deadline = Date.now() + 60000;
  for (;;) {
    await sleep(1500);
    const info = await client.getFilelistInfo(flid).catch(() => null);
    if (info?.state?.id === 'loaded') break;
    if (Date.now() > deadline) { await client.closeFilelist(flid).catch(() => {}); throw new Error('peer filelist did not load (offline?)'); }
  }
  const items = [];
  for (let start = 0; items.length === start && start < 5000; start += 500) {
    items.push(...await client.getFilelistItems(flid, start, 500));
  }
  await client.closeFilelist(flid).catch(() => {});
  return items;
}

async function fetchFilelistPack(client, candidate, ctx, onProgress) {
  const { user, path: dir } = candidate.filelist;
  const remoteDir = await trueRemoteDir(client);

  // 1) Browse the folder (partial list — only this directory transfers).
  onProgress({ phase: 'download', unit: 'bytes', done: 0, total: candidate.size || 0, detail: 'AirDC++ · browsing folder' });
  let items = await listPeerFolder(client, user, dir);

  // Series runs often live one level DEEPER than the search hit's folder
  // ("DC Comics/Superman/Adventures of Superman (1987)/…"). Descend into
  // subfolders whose name matches the series (strongest matches first, capped)
  // and merge their contents.
  const names = (ctx.seriesNames && ctx.seriesNames.length) ? ctx.seriesNames : [ctx.seriesTitle].filter(Boolean);
  const subScore = (n) => {
    const norm = normalizeSeries(n);
    if (!norm) return 0;
    for (const sn of names.map(normalizeSeries)) {
      if (norm.includes(sn)) return 2;   // subfolder named after the series (maybe + year)
      if (sn.includes(norm)) return 1;   // series name contains the folder word ("Superman")
    }
    return 0;
  };
  const subs = items.filter((i) => i.type?.id === 'directory' && subScore(i.name) > 0)
    .sort((a, b) => subScore(b.name) - subScore(a.name)).slice(0, 4);
  for (const sub of subs) {
    onProgress({ phase: 'download', unit: 'bytes', done: 0, total: candidate.size || 0, detail: `AirDC++ · browsing ${sub.name}` });
    try { items = items.concat(await listPeerFolder(client, user, `${dir}${sub.name}/`)); } catch { /* offline mid-browse — use what we have */ }
  }

  // 2) Cherry-pick: only missing issues when the series' gaps are known.
  const wanted = wantedNumbers(ctx);
  if (wanted && !wanted.length) throw new Error('nothing is missing from this series');
  const files = selectPackFiles(items, { seriesTitle: ctx.seriesTitle, seriesNames: ctx.seriesNames, wanted });
  if (!files.length) throw new Error(wanted ? 'the folder has none of the missing issues' : 'no comic files in the folder');

  // 3) Queue each by TTH into a staging subdir of AirDC++'s own download dir.
  const safe = String(ctx.seriesTitle || 'pack').replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  const remoteSub = `${String(remoteDir).replace(/[\\/]+$/, '')}/BackIssue Pack - ${safe}/`;
  const bundles = new Map(); // bundleId → { name, size, done }
  for (const f of files) {
    try {
      const r = await client.queueFileByTth({ targetDirectory: remoteSub, targetName: f.name, size: f.size, tth: f.tth });
      const bid = r?.bundle_info?.id ?? r?.id;
      if (bid != null) bundles.set(bid, { name: f.name, size: f.size, done: 0 });
    } catch (e) {
      // "File exists on disk" etc. — already have it staged/shared; not fatal.
      if (!/exists/i.test(String(e?.message || ''))) throw e;
    }
  }
  if (!bundles.size) return { dir: toLocalPath(remoteSub, remoteDir), keep: true }; // everything already on disk

  // 4) Watch all bundles; overall stall guard so a dead peer can't hang the grab.
  const total = [...bundles.values()].reduce((s, b) => s + b.size, 0);
  const stallMs = Math.max(60000, Number(config.airdcppDownloadStallMs) || 300000);
  let stallSince = Date.now(), lastSum = 0, completed = 0, failed = 0;
  const active = new Set(bundles.keys());
  while (active.size) {
    await sleep(Math.max(1000, pollMs()));
    for (const bid of [...active]) {
      const st = bundles.get(bid);
      let b = null;
      try { b = await client.getBundle(bid); }
      catch { if (st.done >= st.size && st.size > 0) { completed++; active.delete(bid); } continue; } // finished + auto-removed
      st.done = Number(b?.downloaded_bytes) || st.done;
      if (b?.status?.failed) { failed++; active.delete(bid); }
      else if (b?.status?.completed) { st.done = st.size; completed++; active.delete(bid); }
    }
    const sum = [...bundles.values()].reduce((s, b) => s + b.done, 0);
    if (sum > lastSum) { lastSum = sum; stallSince = Date.now(); }
    onProgress({ phase: 'download', unit: 'bytes', done: sum, total, detail: `AirDC++ · ${completed}/${bundles.size} files` });
    if (active.size && Date.now() - stallSince > stallMs) {
      for (const bid of active) await client.removeBundle(bid).catch(() => {}); // abort stragglers
      break; // import whatever completed
    }
  }
  if (!completed) throw new Error(`no files completed (${failed} failed)`);
  return { dir: toLocalPath(remoteSub, remoteDir), keep: true };
}
