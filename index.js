// AirDC++ download source plugin for BackIssue.
//
// AirDC++ (the Web Client) is a Direct Connect client with a JSON Web API — it
// is both the search engine and the download client. DC hubs carry a lot of
// comics that indexers/DDL sites don't, so this reaches material other sources
// can't. An "immediate" source in our model: find() searches (async, with an
// adaptive early-exit poll), fetch() queues the download in AirDC++ and watches
// the bundle to completion, then the finished file is imported (copied — the
// AirDC++ copy is left in place so it keeps sharing).
import { airdcpp } from './source.js';
import { makeAirClient } from './http.js';
import config from '../../src/config.js';

export default function register(api) {
  api.registerSource(airdcpp);

  api.registerSettings({
    airdcppEnabled: { type: 'bool' },
    airdcppHost: { type: 'string', allowEmpty: true },      // http://host:5600
    airdcppUser: { type: 'string', allowEmpty: true },
    airdcppPass: { type: 'string', allowEmpty: true },
    // Comma-separated hub URLs to limit the search to (blank = all connected hubs).
    airdcppHubs: { type: 'string', allowEmpty: true },
    // Where finished downloads land — AirDC++'s own filesystem view.
    airdcppDownloadDirRemote: { type: 'string', allowEmpty: true },
    // The same folder as THIS app reads it (e.g. over SMB). Blank = same as remote.
    airdcppDownloadDir: { type: 'string', allowEmpty: true },
    // Adaptive search: cap the wait for results, and how often to poll for them.
    airdcppSearchWaitMs: { type: 'int', min: 2000, max: 120000 },
    airdcppSearchPollMs: { type: 'int', min: 500, max: 10000 },
    // Give up on a search that has returned NOTHING by this long — a shared
    // file's peers reply within a few seconds, so continued silence means it
    // isn't on DC. Cuts the wait on not-found issues (the slow tail). The full
    // Max-wait still applies once ANY result has arrived (let the set settle).
    airdcppSearchEmptyMs: { type: 'int', min: 1500, max: 60000 },
    // Minimum gap between searches — DC hubs rate-limit; searches run one at a
    // time spaced by this, so bulk downloads don't get throttled to failure.
    airdcppSearchCooldownMs: { type: 'int', min: 0, max: 60000 },
    // Extra tries for a search that comes back EMPTY (a single DC search
    // sometimes misses even when the file is shared). KEEP LOW: hubs flag the
    // SAME search repeated ~3x as spam and return nothing, so 1 (2 searches
    // total) is the safe default; 0 disables retries for stricter hubs.
    airdcppSearchRetries: { type: 'int', min: 0, max: 5 },
    // Give up on a download with no byte progress for this long, so a seeder-less
    // or vanished bundle can't hang the worker forever.
    airdcppDownloadStallMs: { type: 'int', min: 60000, max: 1800000 },
  });

  api.registerClientAsset({ js: 'client/ui.js' });

  // Connection test: verify host + credentials (posted form values first, so it
  // works before Save).
  api.registerRoute('post', '/api/airdcpp/test', async (req, res) => {
    const b = req.body || {};
    const cfg = {
      airdcppHost: b.airdcppHost || config.airdcppHost,
      airdcppUser: b.airdcppUser != null ? b.airdcppUser : config.airdcppUser,
      airdcppPass: b.airdcppPass != null ? b.airdcppPass : config.airdcppPass,
    };
    if (!cfg.airdcppHost) return res.json({ ok: false, message: 'Enter the AirDC++ Web API URL.' });
    try {
      await makeAirClient(cfg).ping();
      return res.json({ ok: true, message: 'Connected to AirDC++.' });
    } catch (e) {
      const m = e.status === 401 || e.status === 403 ? 'Authentication failed — check username/password.' : String(e?.message || e);
      return res.json({ ok: false, message: m });
    }
  });
}
