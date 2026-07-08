// Announce-bot watcher: magnet parsing, matching against wanted issues, the
// exactly-once dedupe, and the TTH hint handed to the source's fast path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertSeries, setSeriesCv, setFollowed, upsertCvSeries, upsertCvIssue,
  upsertLibraryFile, linkFileCvIssue,
} from '../../../src/db.js';
import config from '../../../src/config.js';
import { parseMagnets, runWatch, announceHints, takeHint } from '../watch.js';

const MAG = (tth, name, size = 40e6) =>
  `magnet:?xt=urn:tree:tiger:${tth}&xl=${size}&dn=${encodeURIComponent(name)}`;

test('parseMagnets: TTH + size + decoded name; junk tolerated', () => {
  const text = `New upload! ${MAG('AAA111', 'Saga 002 (2012) (Digital).cbz')} enjoy\n` +
    `also magnet:?xt=urn:btih:notdc&dn=torrent-style (ignored: not a tiger hash)`;
  const out = parseMagnets(text);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { tth: 'AAA111', size: 40e6, name: 'Saga 002 (2012) (Digital).cbz' });
  assert.deepEqual(parseMagnets('no links here'), []);
});

// Followed Saga owns #1 of 3 → #2/#3 wanted; X-Men not followed.
function seed() {
  const db = openDb(':memory:');
  const saga = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, saga, 46568, { locked: 0 }); setFollowed(db, saga, 1);
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 3 });
  for (let n = 1; n <= 3; n++) upsertCvIssue(db, { id: n, cv_series_id: 46568, number: String(n), name: 'ch' + n });
  upsertLibraryFile(db, { path: '/s1.cbz', dir: '/', name: 's1.cbz', size: 1, mtime: 1, valid: 1, series_id: saga });
  linkFileCvIssue(db, '/s1.cbz', 1);
  const xm = upsertSeries(db, { title: 'X-Men (1991)', url: 'cv:100' });
  setSeriesCv(db, xm, 100, { locked: 0 });
  upsertCvSeries(db, { id: 100, name: 'X-Men', publisher: 'Marvel', start_year: '1991', count_of_issues: 1 });
  upsertCvIssue(db, { id: 101, cv_series_id: 100, number: '1', name: 'x' });
  return db;
}

// A fake AirDC++ client: one hub whose chat has bot + human messages, and one
// PM session with the bot.
function fakeClient() {
  return {
    listHubs: async () => [{ id: 7 }],
    hubMessages: async () => [
      { chat_message: { id: 1, text: `ADDED ${MAG('TTH2', 'Saga 002 (2012) (Digital).cbz')}`, from: { nick: 'UploadBot' } } },
      { chat_message: { id: 2, text: `chatter ${MAG('TTHX', 'Saga 003 (2012).cbz')}`, from: { nick: 'RandomUser' } } }, // not the bot
      { log_message: { id: 3, text: 'status line' } },
    ],
    // Real API shape: user.nicks is a comma-joined STRING (multi-hub users);
    // matching is case-insensitive on any of them.
    listPrivateChats: async () => [{ id: 'pm1', user: { nicks: 'somebody, uploadbot' } }],
    privateMessages: async () => [
      { chat_message: { id: 9, text: `New: ${MAG('TTH-XM', 'X-Men 001 (1991).cbz')} and ${MAG('TTH-TINY', 'Saga 003 (2012).cbz', 200e3)}` } },
    ],
  };
}

test('runWatch: matches bot announcements to wanted issues, queues, hints, dedupes', async () => {
  const db = seed();
  config.airdcppWatchNicks = 'UploadBot';
  config.airdcppHost = 'http://air:5600';
  announceHints.clear();
  let kicked = 0;
  const ctx = { db, startDownloads: () => kicked++ };

  const r1 = await runWatch(ctx, { client: fakeClient() });
  // Saga #2 (bot, hub chat) matches; RandomUser's Saga #3 is ignored (not the
  // bot); X-Men isn't followed; the tiny Saga #3 PM magnet is a KB fake.
  assert.equal(r1.queued, 1);
  assert.equal(kicked, 1);
  const row = db.prepare("SELECT status FROM issues WHERE url='cvissue:2'").get();
  assert.equal(row.status, 'queued');
  // The TTH hint is waiting for the source's fast path — and is consumed once.
  assert.deepEqual(takeHint(2), { tth: 'TTH2', size: 40e6, name: 'Saga 002 (2012) (Digital).cbz' });
  assert.equal(takeHint(2), null);

  // Second run: every message already seen → nothing new, no re-queue.
  const r2 = await runWatch(ctx, { client: fakeClient() });
  assert.equal(r2.fresh, 0);
  assert.equal(r2.queued, 0);
  assert.equal(kicked, 1);
});

test('runWatch: unconfigured (no nicks) and missing ctx are clean no-ops', async () => {
  const db = seed();
  config.airdcppWatchNicks = '';
  assert.match((await runWatch({ db })).skipped, /nicks/);
  config.airdcppWatchNicks = 'Bot';
  assert.match((await runWatch(null)).skipped || '', /context/);
});
