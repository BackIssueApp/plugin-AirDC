// Announce-bot watcher: DC hubs run bot USERS that announce new uploads with
// magnet links (magnet:?xt=urn:tree:tiger:<TTH>&xl=<size>&dn=<filename>). This
// job polls messages from the configured bot nicks — wherever they appear:
// their private-message sessions AND main-chat lines they post — parses the
// magnets, and matches the filenames against missing issues of followed series
// using the host's canonical matcher. A match queues the issue and leaves a
// TTH hint so the source's find() grabs EXACTLY the announced file (a TTH is
// DC's precise file identity; names collide, hashes don't).
import { queueIssues, ensureCvIssueRow } from '../../src/db.js';
import { buildWantedIndex, matchFeedItems } from '../../src/rsswatch.js';
import { logInfo } from '../../src/logstore.js';
import config from '../../src/config.js';
import { makeAirClient } from './http.js';

// cvIssueId → { tth, size, name } — consumed by source.find() as a fast path.
// Bounded: oldest evicted past 500 (an unconsumed hint means the queue row was
// cancelled; the normal name search still works without it).
export const announceHints = new Map();
export function takeHint(cvIssueId) {
  const h = announceHints.get(cvIssueId);
  if (h) announceHints.delete(cvIssueId);
  return h || null;
}

// Every magnet link in a message → { tth, size, name }. DC magnets carry the
// Tiger Tree Hash in xt, the byte size in xl, and the filename in dn.
export function parseMagnets(text) {
  const out = [];
  for (const m of String(text || '').match(/magnet:\?[^\s<>"']+/gi) || []) {
    let tth = null, size = 0, name = '';
    for (const part of m.slice(8).split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq), v = part.slice(eq + 1);
      if (k === 'xt' && /urn:tree:tiger:/i.test(v)) tth = v.replace(/urn:tree:tiger:/i, '').trim();
      else if (k === 'xl') size = Number(v) || 0;
      else if (k === 'dn') { try { name = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { name = v; } }
    }
    if (tth && name) out.push({ tth, size, name });
  }
  return out;
}

// The API wraps messages ({ chat_message: {...} } / { log_message: {...} });
// tolerate bare objects too.
const msgOf = (m) => (m && (m.chat_message || m.log_message)) || m || {};
const textOf = (m) => String(msgOf(m).text || '');
const nickOf = (m) => String(msgOf(m).from?.nick || '');

// Recent messages FROM the given bot nicks, across every connected hub's main
// chat and every open PM session with them. Each carries a stable dedupe key
// and where it came from (for the verification logs). Also reports what was
// scanned, so "0 messages" is distinguishable from "0 hubs connected".
export async function collectAnnouncements(client, nicks) {
  const want = new Set(nicks.map((n) => n.toLowerCase()));
  const found = [];
  const hubs = await client.listHubs().catch(() => []);
  for (const h of hubs) {
    for (const m of await client.hubMessages(h.id, 100).catch(() => [])) {
      const mm = msgOf(m);
      if (mm.id != null && want.has(nickOf(m).toLowerCase())) {
        found.push({ key: `hub:${h.id}:${mm.id}`, text: textOf(m), from: nickOf(m), where: `hub ${h.identity?.name || h.hub_url || h.id}` });
      }
    }
  }
  let pmSessions = 0;
  for (const s of await client.listPrivateChats().catch(() => [])) {
    // The live API carries the name(s) on user.nicks — a comma-joined string
    // when the user sits in several hubs. Tolerate a bare .nick too.
    const names = String(s?.user?.nicks ?? s?.user?.nick ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const hit = names.find((n) => want.has(n.toLowerCase()));
    if (!hit) continue;
    pmSessions++;
    for (const m of await client.privateMessages(s.id, 100).catch(() => [])) {
      const mm = msgOf(m);
      if (mm.id != null) found.push({ key: `pm:${s.id}:${mm.id}`, text: textOf(m), from: hit, where: 'PM' });
    }
  }
  return { messages: found, hubCount: hubs.length, pmSessions };
}

function initSeen(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS airdcpp_watch_seen (
    key TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
}

// The job body. ctx = { db, startDownloads } from the host; client injectable
// for tests. Each message is considered exactly once.
export async function runWatch(ctx, { client } = {}) {
  const db = ctx && ctx.db;
  if (!db) return { skipped: 'host does not pass a job context — update BackIssue' };
  const nicks = String(config.airdcppWatchNicks || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!nicks.length || !config.airdcppHost) return { skipped: 'no watch nicks configured' };
  initSeen(db);
  const air = client || makeAirClient(config);
  const { messages, hubCount, pmSessions } = await collectAnnouncements(air, nicks);
  const check = db.prepare('SELECT 1 FROM airdcpp_watch_seen WHERE key=?');
  const fresh = messages.filter((m) => !check.get(m.key));

  // Verification logging: each fresh bot message is logged ONCE (the dedupe
  // caps volume) so it's easy to confirm the bots and formats are what we
  // expect — and to spot messages that carry no parseable magnet.
  const trunc = (s, n = 180) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  // Magnets from the new messages → feed-shaped items for the host matcher
  // (guid = TTH: a repost of the same file is the same item).
  const items = [];
  const seenTth = new Set();
  for (const m of fresh) {
    const links = parseMagnets(m.text);
    logInfo(`AirDC++ bot msg [${m.from} @ ${m.where}] ${links.length} magnet(s): "${trunc(m.text)}"`, 'airdcpp');
    for (const l of links) {
      if (seenTth.has(l.tth)) continue;
      seenTth.add(l.tth);
      items.push({ guid: l.tth, title: l.name, size: l.size, tth: l.tth });
    }
  }
  const matches = items.length ? matchFeedItems(items, buildWantedIndex(db)) : [];
  // Per-magnet verdicts for the announces that DIDN'T match — the other half
  // of confirming the pipeline sees what we expect.
  const matched = new Set(matches.map((x) => x.item.tth));
  for (const it of items) {
    if (matched.has(it.tth)) continue;
    const why = it.size > 0 && it.size < 1024 * 1024 ? 'suspiciously small (fake?)' : 'no missing followed issue matches this name';
    logInfo(`AirDC++ announce unmatched: "${it.title}" (${it.size ? Math.round(it.size / 1e6) + ' MB' : 'size unknown'}) — ${why}`, 'airdcpp');
  }
  const ids = [];
  for (const { item, wanted } of matches) {
    const id = ensureCvIssueRow(db, { seriesId: wanted.series_id, cvIssueId: wanted.cv_issue_id, number: wanted.issue_number, title: wanted.issue_name });
    if (announceHints.size >= 500) announceHints.delete(announceHints.keys().next().value);
    announceHints.set(wanted.cv_issue_id, { tth: item.tth, size: item.size, name: item.title });
    ids.push(id);
    logInfo(`AirDC++ announce: "${item.title}" → ${wanted.series_title} #${wanted.issue_number}`, 'airdcpp');
  }
  queueIssues(db, ids);
  const ins = db.prepare('INSERT OR IGNORE INTO airdcpp_watch_seen (key) VALUES (?)');
  db.transaction((list) => { for (const m of list) ins.run(m.key); })(messages);
  db.prepare("DELETE FROM airdcpp_watch_seen WHERE seen_at < datetime('now', '-7 days')").run();
  if (ids.length && typeof ctx.startDownloads === 'function') ctx.startDownloads();
  logInfo(`AirDC++ watch: ${hubCount} hub(s), ${pmSessions} bot PM session(s), ${messages.length} bot message(s), ${fresh.length} new, ${items.length} magnet(s), matched ${ids.length}`, 'airdcpp');
  return { messages: messages.length, fresh: fresh.length, magnets: items.length, queued: ids.length };
}
