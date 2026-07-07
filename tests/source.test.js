// AirDC++ source: pure logic + the adaptive-search loop with a fake client.
// The live API shapes (result/bundle fields) were verified against a real
// instance during development; these lock in the parsing + search behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapResult, toLocalPath, runSearch, dcPattern, airdcpp, clearSeriesSearches, clearBadCopies, selectPackFiles } from '../source.js';
import config from '../../../src/config.js';

// Fast, cooldown-free timings for the search-loop tests.
config.airdcppSearchPollMs = 20;
config.airdcppSearchWaitMs = 2000;
config.airdcppSearchCooldownMs = 0;

// A real result object (trimmed) captured from a live AirDC++ search.
const LIVE_FILE = {
  id: 'UWAT47SNEQFA5JICVJRLN3HSJIOYEXFXLG4YFNQ',
  name: 'Batman - Gargoyle of Gotham 004 (2026) (Digital) (Pyrate-DCP).cbz',
  size: 131481263,
  hits: 10,
  slots: { free: 101, total: 103, str: '101/103' },
  tth: 'UWAT47SNEQFA5JICVJRLN3HSJIOYEXFXLG4YFNQ',
  type: { id: 'file', str: 'cbz', content_type: '' },
};
const LIVE_DIR = { id: 'ABC', name: 'Saga Vol 1', size: 250e6, type: { id: 'directory', str: '' }, slots: { free: 5, total: 5 }, hits: 3 };

test('mapResult reads the live AirDC++ result shape', () => {
  const m = mapResult(LIVE_FILE, 7);
  assert.equal(m.source, 'airdcpp');
  assert.equal(m.name, LIVE_FILE.name);
  assert.equal(m.size, 131481263);
  assert.equal(m.resultId, LIVE_FILE.id);
  assert.equal(m.searchInstanceId, 7);
  assert.equal(m.isPack, false);
  assert.equal(m.ext, 'cbz');
  assert.equal(m.hits, 10);
});

test('mapResult flags a directory result as a pack', () => {
  const m = mapResult(LIVE_DIR, 7);
  assert.equal(m.isPack, true);
  assert.equal(m.ext, null);
});

test('toLocalPath maps AirDC++ paths onto this app\'s view', () => {
  const save = { r: config.airdcppDownloadDirRemote, l: config.airdcppDownloadDir };
  try {
    // Networked: AirDC++ writes /downloads/comics, we read it over SMB.
    config.airdcppDownloadDirRemote = '/downloads/comics';
    config.airdcppDownloadDir = '\\\\TOWER\\downloads\\comics';
    assert.equal(toLocalPath('/downloads/comics/Batman 001.cbz'), '\\\\TOWER\\downloads\\comics/Batman 001.cbz');
    // Shared filesystem (no remote set) → path passes through unchanged.
    config.airdcppDownloadDirRemote = '';
    config.airdcppDownloadDir = '';
    assert.equal(toLocalPath('/downloads/x.cbz'), '/downloads/x.cbz');
  } finally {
    config.airdcppDownloadDirRemote = save.r; config.airdcppDownloadDir = save.l;
  }
});

test('runSearch: a stable count of ZERO keeps polling (does not bail early)', async () => {
  // The bug this guards: DC results arrive with a delay, so the first polls
  // return []. A naive "count stopped changing" would exit at 0 results.
  let poll = 0;
  const fake = {
    async createSearchInstance() { return 1; },
    async hubSearch() { return { search_id: 'x' }; },
    async getResults() {
      poll++;
      // empty for the first 3 polls, then results arrive.
      return poll <= 3 ? [] : [LIVE_FILE];
    },
    async removeSearchInstance() {},
  };
  const { results } = await runSearch(fake, { pattern: 'Batman' });
  assert.equal(results.length, 1, 'must wait past the empty polls for late results');
});

test('runSearch: gives up early when a search stays empty past the empty window', async () => {
  const { resetSearchThrottle } = await import('../source.js');
  resetSearchThrottle(); // clear any inherited inter-search cooldown from prior tests
  // Not-found tail: a persistently-empty search must NOT burn the full Max-wait.
  const prev = config.airdcppSearchEmptyMs;
  config.airdcppSearchEmptyMs = 100; // give up fast when nothing comes back
  const fake = {
    async createSearchInstance() { return 1; },
    async hubSearch() { return {}; },
    async getResults() { return []; }, // nobody shares it — always empty
    async removeSearchInstance() {},
  };
  try {
    const t0 = Date.now();
    const { results } = await runSearch(fake, { pattern: 'Nonexistent' });
    const elapsed = Date.now() - t0;
    assert.equal(results.length, 0);
    assert.ok(elapsed < 1000, `gave up early (~${elapsed}ms) instead of the full ${config.airdcppSearchWaitMs}ms wait`);
  } finally { config.airdcppSearchEmptyMs = prev; }
});

test('runSearch: early-exits as soon as accept() matches', async () => {
  let poll = 0;
  const fake = {
    async createSearchInstance() { return 1; },
    async hubSearch() { return {}; },
    async getResults() { poll++; return [LIVE_FILE]; },
    async removeSearchInstance() {},
  };
  const before = Date.now();
  const { results } = await runSearch(fake, { pattern: 'Batman' }, (m) => m.ext === 'cbz');
  assert.equal(results.length, 1);
  assert.ok(poll <= 2, 'should stop on the first matching poll, not wait the full cap');
  assert.ok(Date.now() - before < 8000);
});

test('runSearch serializes: concurrent searches never overlap (DC hub rate-limit fix)', async () => {
  // Two searches fired "at once" must run one-at-a-time — the second must not
  // create its instance until the first has finished, or the hub throttles them.
  let active = 0, maxActive = 0;
  const fake = {
    async createSearchInstance() { active++; maxActive = Math.max(maxActive, active); return active; },
    async hubSearch() { return {}; },
    async getResults() { return [LIVE_FILE]; },
    async removeSearchInstance() { active--; },
  };
  // Run each to completion (remove the instance) so `active` returns to 0.
  const one = async () => { const { instanceId } = await runSearch(fake, { pattern: 'a' }, (m) => m.ext === 'cbz'); await fake.removeSearchInstance(instanceId); };
  await Promise.all([one(), one(), one()]);
  assert.equal(maxActive, 1, 'at most one AirDC++ search runs at a time');
});

test('find retries an EMPTY search (transient DC miss) then succeeds', async () => {
  config.airdcppSearchRetries = 2;
  const MATCH = { ...LIVE_FILE, name: 'Batman 004 (2026) (Digital) (Pyrate-DCP).cbz' };
  // Empty on the first two searches (transient), results on the third.
  let searches = 0;
  const client = {
    async createSearchInstance() { return ++searches; },
    async hubSearch() { return {}; },
    async getResults() { return searches >= 3 ? [MATCH] : []; },
    async removeSearchInstance() {},
  };
  const ctx = { client, config, seriesTitle: 'Batman', seriesNames: ['Batman'],
    seriesYear: '2026', issue: { issue_number: '004' } };
  // LIVE_FILE is "Batman - Gargoyle of Gotham 004" — matches series+number.
  const hit = await airdcpp.find(ctx);
  assert.ok(hit, 'recovers the file after retrying the empty searches');
  assert.equal(searches, 3, 'searched three times (two empty + one hit)');
});

test('find does NOT retry when a search returns results but no match', async () => {
  config.airdcppSearchRetries = 3;
  // A non-comic result: search is non-empty, so no point re-searching.
  const NONMATCH = { ...LIVE_FILE, name: 'Some Other Book 001.cbz', type: { id: 'file', str: 'cbz' } };
  let searches = 0;
  const client = {
    async createSearchInstance() { return ++searches; },
    async hubSearch() { return {}; },
    async getResults() { return [NONMATCH]; },
    async removeSearchInstance() {},
  };
  const ctx = { client, config, seriesTitle: 'Batman', seriesNames: ['Batman'],
    seriesYear: '2026', issue: { issue_number: '004' } };
  const hit = await airdcpp.find(ctx);
  assert.equal(hit, null, 'no match found');
  assert.equal(searches, 1, 'stopped after one non-empty search — did not burn retries');
});

// A temp dir holding a VALID tiny zip (PK bytes) — downloads are sniffed now,
// so fetch tests need real files at the bundle's reported target.
async function validComicDir(name) {
  const os = await import('node:os');
  const nfs = await import('node:fs');
  const npath = await import('node:path');
  const dir = nfs.mkdtempSync(npath.join(os.tmpdir(), 'cv-fetch-'));
  const file = npath.join(dir, name);
  nfs.writeFileSync(file, Buffer.from('PKfakezip', 'latin1'));
  return { dir, file, cleanup: () => nfs.rmSync(dir, { recursive: true, force: true }) };
}

test('fetch relocates the result when the search instance has expired', async () => {
  clearBadCopies();
  config.airdcppSearchRetries = 1;
  config.airdcppDownloadStallMs = 60000;
  const { dir, file, cleanup } = await validComicDir(LIVE_FILE.name);
  try {
    // The candidate carries a stale instance id (7). The first download call
    // fails "Entity 7 was not found"; fetch must re-search, find the same TTH on
    // a fresh instance, and download from that.
    const candidate = { source: 'airdcpp', name: LIVE_FILE.name, size: LIVE_FILE.size,
      resultId: LIVE_FILE.id, searchInstanceId: 7, isPack: false, ext: 'cbz', query: 'Batman 4' };
    const downloadCalls = [];
    const client = {
      async downloadResult(instanceId) {
        downloadCalls.push(instanceId);
        if (instanceId === 7) { const e = new Error('POST /search/7/.../download: Entity 7 was not found'); e.status = 404; throw e; }
        return { bundle_info: { id: 99 } };
      },
      async createSearchInstance() { return 42; },
      async hubSearch() { return {}; },
      async getResults() { return [LIVE_FILE]; },       // fresh search finds the same file (same TTH)
      async removeSearchInstance() {},
      async getBundle() { return { downloaded_bytes: LIVE_FILE.size, size: LIVE_FILE.size, target: file, status: { completed: true, str: 'Shared' } }; },
      async settingGet() { return dir; },
    };
    const res = await airdcpp.fetch(candidate, { config, client });
    assert.ok(res.srcPath, 'download completed after relocating');
    assert.equal(res.keep, true);
    assert.deepEqual(downloadCalls, [7, 42], 'tried the stale instance, then the fresh one');
  } finally { cleanup(); }
});

test('fetch treats "File exists on the disk already" as done — after sniffing the existing file', async () => {
  clearBadCopies();
  const save = { r: config.airdcppDownloadDirRemote, l: config.airdcppDownloadDir };
  const { dir, cleanup } = await validComicDir(LIVE_FILE.name);
  try {
    config.airdcppDownloadDirRemote = ''; config.airdcppDownloadDir = dir;
    const candidate = { source: 'airdcpp', name: LIVE_FILE.name, size: LIVE_FILE.size,
      resultId: LIVE_FILE.id, searchInstanceId: 5, isPack: false, ext: 'cbz', query: 'x' };
    let polled = false;
    const client = {
      async downloadResult() { throw new Error('POST /search/5/.../download: File exists on the disk already'); },
      async settingGet() { return '/Downloads'; },
      async getBundle() { polled = true; return {}; },
      async removeSearchInstance() {},
    };
    const res = await airdcpp.fetch(candidate, { config, client });
    assert.equal(res.keep, true);
    assert.ok(res.srcPath.endsWith(LIVE_FILE.name), 'returns the existing file path');
    assert.equal(polled, false, 'no bundle polling — nothing was queued');
  } finally {
    config.airdcppDownloadDirRemote = save.r; config.airdcppDownloadDir = save.l;
    cleanup();
  }
});

test('a corrupt on-disk copy is deleted + blacklisted instead of imported', async () => {
  clearBadCopies();
  const os = await import('node:os');
  const nfs = await import('node:fs');
  const npath = await import('node:path');
  const dir = nfs.mkdtempSync(npath.join(os.tmpdir(), 'cv-junk-'));
  const save = { r: config.airdcppDownloadDirRemote, l: config.airdcppDownloadDir };
  try {
    config.airdcppDownloadDirRemote = ''; config.airdcppDownloadDir = dir;
    const junk = npath.join(dir, LIVE_FILE.name);
    nfs.writeFileSync(junk, Buffer.from([0x21, 0xf4, 0xcf, 0xc0])); // the real #646 bytes
    const candidate = { source: 'airdcpp', name: LIVE_FILE.name, size: 4,
      resultId: 'JUNKTTH', searchInstanceId: 5, ext: 'cbr', query: 'x' };
    const client = {
      async downloadResult() { throw new Error('File exists on the disk already'); },
      async settingGet() { return '/Downloads'; },
      async removeSearchInstance() {},
    };
    await assert.rejects(() => airdcpp.fetch(candidate, { config, client }), /corrupt/);
    assert.ok(!nfs.existsSync(junk), 'the junk file was deleted');
  } finally {
    config.airdcppDownloadDirRemote = save.r; config.airdcppDownloadDir = save.l;
    nfs.rmSync(dir, { recursive: true, force: true });
    clearBadCopies();
  }
});

test('dcPattern strips filename-illegal punctuation that breaks DC name search', () => {
  assert.equal(dcPattern('Avengers: Armageddon 1'), 'Avengers Armageddon 1'); // the reported bug
  assert.equal(dcPattern('What If...? / Secret'), 'What If... Secret'); // ? and / gone, dots kept
  assert.equal(dcPattern('Spider-Man 2099'), 'Spider-Man 2099'); // hyphens/digits kept
  assert.equal(dcPattern("X-Men '97"), "X-Men '97"); // apostrophes kept
});

test('find shares ONE series search across issues of a bulk grab', async () => {
  clearSeriesSearches();
  config.airdcppSearchRetries = 0;
  // The series search ("Batman 2026") returns the whole run in one shot.
  const RUN = ['001', '002', '003'].map((n) => ({ ...LIVE_FILE, id: 'TTH' + n, name: `Batman ${n} (2026) (Digital) (Pyrate-DCP).cbz` }));
  let searches = 0;
  const client = {
    async createSearchInstance() { return ++searches; },
    async hubSearch() { return {}; },
    async getResults() { return RUN; },
    async removeSearchInstance() {},
  };
  const mk = (n) => ({ client, config, seriesTitle: 'Batman', seriesNames: ['Batman'], seriesYear: '2026', issue: { issue_number: n } });
  // Three issues — fired concurrently, like queue workers do.
  const [a, b, c] = await Promise.all([airdcpp.find(mk('1')), airdcpp.find(mk('2')), airdcpp.find(mk('3'))]);
  assert.equal(searches, 1, 'one hub search served all three issues');
  assert.match(a.name, /Batman 001/); assert.match(b.name, /Batman 002/); assert.match(c.name, /Batman 003/);
  assert.equal(a.shared, true, 'candidates are marked shared (instance must survive each download)');
  assert.equal(a.searchInstanceId, b.searchInstanceId, 'same live instance for all');
  clearSeriesSearches();
});

test('find falls back to a per-issue search when the series results miss the issue', async () => {
  clearSeriesSearches();
  config.airdcppSearchRetries = 0;
  // Series search only surfaces #1; asking for #7 must trigger its own search.
  const patterns = [];
  const client = {
    async createSearchInstance() { return patterns.length + 1; },
    async hubSearch(id, { pattern }) { patterns.push(pattern); return {}; },
    async getResults() {
      // The bare series search ('Batman') only surfaces #1; any numbered
      // per-issue pattern surfaces #7.
      return patterns[patterns.length - 1] === 'Batman'
        ? [{ ...LIVE_FILE, id: 'T1', name: 'Batman 001 (2026) (Digital) (Pyrate-DCP).cbz' }]
        : [{ ...LIVE_FILE, id: 'T7', name: 'Batman 007 (2026) (Digital) (Pyrate-DCP).cbz' }];
    },
    async removeSearchInstance() {},
  };
  const hit = await airdcpp.find({ client, config, seriesTitle: 'Batman', seriesNames: ['Batman'], seriesYear: '2026', issue: { issue_number: '7' } });
  assert.ok(hit, 'found via the per-issue fallback');
  assert.match(hit.name, /Batman 007/);
  assert.notEqual(hit.shared, true, 'fallback candidate owns its instance');
  assert.ok(patterns.some((p) => p !== 'Batman'), 'a specific per-issue search ran after the series search');
  clearSeriesSearches();
});

test('a shared candidate\'s download leaves the series search instance alive', async () => {
  clearBadCopies();
  const { dir, file, cleanup } = await validComicDir('x.cbz');
  try {
    const removed = [];
    const client = {
      async downloadResult() { return { bundle_info: { id: 9 } }; },
      async settingGet() { return dir; },
      async getBundle() { return { downloaded_bytes: 5, size: 5, target: file, status: { completed: true } }; },
      async removeSearchInstance(id) { removed.push(id); },
    };
    const candidate = { source: 'airdcpp', name: 'x.cbz', size: 5, resultId: 'T', searchInstanceId: 3, shared: true, query: 'Batman' };
    await airdcpp.fetch(candidate, { config, client });
    assert.deepEqual(removed, [], 'shared instance not removed — other issues still use it');
  } finally { cleanup(); }
});

test('mapResult keeps the peer + parent folder off a file hit (for folder packs)', () => {
  const m = mapResult({ ...LIVE_FILE, path: '/Comics/2015/Week 04/File.cbr',
    users: { count: 3, user: { cid: 'CID1', hub_url: 'hub:777', nicks: 'Sparrow' } } }, 7);
  assert.equal(m.dir, '/Comics/2015/Week 04/');
  assert.deepEqual(m.user, { cid: 'CID1', hub_url: 'hub:777', nicks: 'Sparrow' });
});

test('manualSearch synthesizes a folder pack candidate from file hits (peer+folder)', async () => {
  config.airdcppSearchRetries = 0;
  Object.assign(config, { airdcppEnabled: true, airdcppHost: 'http://x', airdcppUser: 'u' }); // pass the isEnabled gate
  const mk = (n) => ({ ...LIVE_FILE, id: 'T' + n, name: `Alex + Ada 0${n} (2015) (digital).cbr`,
    path: `/Comics/Alex + Ada/Alex + Ada 0${n}.cbr`,
    users: { user: { cid: 'CID1', hub_url: 'hub:777', nicks: 'Sparrow' } } });
  const client = {
    async createSearchInstance() { return 1; },
    async hubSearch() { return {}; },
    async getResults() { return [mk(1), mk(2)]; },
    async removeSearchInstance() {},
  };
  const { results } = await airdcpp.manualSearch({ client, config, seriesTitle: 'Alex + Ada', seriesNames: ['Alex + Ada'], issue: {} });
  const pack = results.find((r) => r.isPack);
  assert.ok(pack, 'a folder pack candidate exists');
  assert.equal(pack.filelist.user.cid, 'CID1');
  assert.equal(pack.filelist.path, '/Comics/Alex + Ada/');
  assert.equal(pack.hits, 2, 'counts the file hits in that folder');
  assert.equal(pack.seeders, 2, 'hit count doubles as seeders so core ranks folders by it');
  assert.match(pack.name, /Sparrow.*2 matches/, 'nick + match count distinguish same-named folders');
  assert.match(pack.meta, /missing issues/);
});

test('selectPackFiles keeps only comics, only MISSING issues, ONE variant per issue', () => {
  const items = [
    { type: { id: 'file' }, name: 'Alex + Ada 014 (2015) (digital).cbr', size: 21e6, tth: 'A' },
    { type: { id: 'file' }, name: 'Alex + Ada 014 (2015) (digital) (Repack).cbr', size: 23e6, tth: 'A2' }, // variant of the same issue
    { type: { id: 'file' }, name: 'Alex + Ada 015 (2015) (digital).cbz', size: 22e6, tth: 'B' },
    { type: { id: 'file' }, name: 'Avengers 044 (2015).cbr', size: 40e6, tth: 'C' },      // other series
    { type: { id: 'file' }, name: 'info.nfo', size: 21e6, tth: 'D' },                     // not a comic
    { type: { id: 'directory' }, name: 'Subdir', size: 0 },
  ];
  const all = selectPackFiles(items, { seriesTitle: 'Alex + Ada', seriesNames: ['Alex + Ada'], wanted: null });
  assert.equal(all.length, 4, 'unknown gaps → every real comic (processPack dedupes)');
  const picked = selectPackFiles(items, { seriesTitle: 'Alex + Ada', seriesNames: ['Alex + Ada'], wanted: ['14'] });
  assert.equal(picked.length, 1, 'one file per missing issue — variants deduped');
  assert.equal(picked[0].tth, 'A2', 'best variant wins (same score → larger file)');
});

test('fetchPack (folder) browses the filelist, queues by TTH, and stages a dir', async () => {
  config.airdcppDownloadStallMs = 60000;
  const queued = [];
  const client = {
    async openFilelist(user, dir) { return { id: user.cid, dir }; },
    async getFilelistInfo() { return { state: { id: 'loaded' } }; },
    async getFilelistItems(id, start) {
      return start === 0 ? [
        { type: { id: 'file' }, name: 'Alex + Ada 014 (2015) (digital).cbr', size: 21e6, tth: 'TTH14' },
        { type: { id: 'file' }, name: 'readme.txt', size: 20e6, tth: 'TTHX' },
      ] : [];
    },
    async closeFilelist() {},
    async queueFileByTth(q) { queued.push(q); return { id: 500 + queued.length }; },
    async getBundle() { return { downloaded_bytes: 21e6, size: 21e6, status: { completed: true } }; },
    async removeBundle() {},
    async settingGet() { return '/Downloads'; },
  };
  const candidate = { source: 'airdcpp', isPack: true, filelist: { user: { cid: 'CID1', hub_url: 'hub:777' }, path: '/Comics/Alex + Ada/' }, name: '📁 Alex + Ada' };
  const res = await airdcpp.fetchPack(candidate, { config, client, seriesTitle: 'Alex + Ada', seriesNames: ['Alex + Ada'] });
  assert.equal(res.keep, true);
  assert.match(res.dir, /BackIssue Pack - Alex \+ Ada/);
  assert.equal(queued.length, 1, 'only the comic queued, not the .txt');
  assert.equal(queued[0].tth, 'TTH14');
  assert.match(String(queued[0].targetDirectory), /\/$/, 'target dir keeps its trailing slash');
});

test('fetch rejects a corrupt download, deletes it, and blacklists the copy', async () => {
  const os = await import('node:os');
  const nfs = await import('node:fs');
  const npath = await import('node:path');
  const dir = nfs.mkdtempSync(npath.join(os.tmpdir(), 'cv-corrupt-'));
  const save = { r: config.airdcppDownloadDirRemote, l: config.airdcppDownloadDir };
  try {
    config.airdcppDownloadDirRemote = ''; config.airdcppDownloadDir = '';
    // The 'finished' file is garbage — not ZIP/RAR/PDF.
    const garbage = npath.join(dir, 'Fake 001.cbr');
    nfs.writeFileSync(garbage, Buffer.from([0x21, 0xf4, 0xcf, 0xc0, 0x81, 0x70]));
    const client = {
      async downloadResult() { return { bundle_info: { id: 7 } }; },
      async settingGet() { return dir; },
      async getBundle() { return { downloaded_bytes: 6, size: 6, target: garbage, status: { completed: true } }; },
      async removeSearchInstance() {},
    };
    const candidate = { source: 'airdcpp', name: 'Fake 001.cbr', size: 6, resultId: 'BADTTH', searchInstanceId: 3, query: 'Fake' };
    await assert.rejects(() => airdcpp.fetch(candidate, { config, client }), /corrupt/);
    assert.ok(!nfs.existsSync(garbage), 'garbage file deleted so it cannot be re-imported');
    // Blacklisted: an immediate re-fetch of the same copy refuses without downloading.
    await assert.rejects(() => airdcpp.fetch(candidate, { config, client }), /already proved corrupt/);
  } finally {
    config.airdcppDownloadDirRemote = save.r; config.airdcppDownloadDir = save.l;
    nfs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the source is an immediate, toggle+host-gated adapter with pack support', () => {
  assert.equal(airdcpp.id, 'airdcpp');
  assert.equal(airdcpp.kind, 'immediate');
  assert.equal(airdcpp.isEnabled({ airdcppEnabled: true, airdcppHost: 'http://x', airdcppUser: 'u' }), true);
  assert.equal(airdcpp.isEnabled({ airdcppEnabled: true }), false); // needs host + user
  assert.equal(airdcpp.isEnabled({}), false);
  for (const k of ['find', 'fetch', 'fetchPack', 'manualSearch']) assert.equal(typeof airdcpp[k], 'function');
});

test('resolveOnDiskCopy: finds valid/corrupt copies incl. subfolders; null when absent', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveOnDiskCopy } = await import('../source.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'air-disk-'));
  const prev = config.airdcppDownloadDir;
  config.airdcppDownloadDir = root;
  try {
    // a valid archive (ZIP magic) directly in the root
    fs.writeFileSync(path.join(root, 'Good #1.cbz'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
    // a valid archive nested in a per-bundle subfolder
    fs.mkdirSync(path.join(root, 'Bundle'));
    fs.writeFileSync(path.join(root, 'Bundle', 'Nested #2.cbz'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
    // a corrupt copy (not an archive)
    fs.writeFileSync(path.join(root, 'Bad #3.cbz'), Buffer.from('not a zip at all'));

    const good = await resolveOnDiskCopy('Good #1.cbz');
    assert.ok(good.path && good.valid, 'valid archive found + validated');

    const nested = await resolveOnDiskCopy('Nested #2.cbz');
    assert.ok(nested.path && nested.valid, 'nested archive found via shallow scan');

    const bad = await resolveOnDiskCopy('Bad #3.cbz');
    assert.ok(bad.path && !bad.valid, 'corrupt copy found but flagged invalid (→ delete + retry)');

    const missing = await resolveOnDiskCopy('Missing #9.cbz');
    assert.equal(missing.path, null, 'absent file → null (→ noRetry, no bounce)');
  } finally {
    config.airdcppDownloadDir = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
