// AirDC++ Web API client (JSON over REST). AirDC++ IS both the search engine and
// the download client — one running service with an HTTP API at {host}/api/v1,
// authenticated with HTTP Basic. Unlike an HTTP indexer, a DC search is
// asynchronous: create a search instance, send it to the hubs, then results
// trickle back from peers over several seconds (we poll with early-exit).
import { request } from 'undici';

function apiBase(host) {
  const h = String(host || '').replace(/\/+$/, '');
  return h + '/api/v1';
}

function authHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user || ''}:${pass || ''}`).toString('base64');
}

// One configured client bound to a host + credentials. All calls are authed.
export function makeAirClient(config) {
  const base = apiBase(config.airdcppHost);
  const headers = {
    authorization: authHeader(config.airdcppUser, config.airdcppPass),
    'content-type': 'application/json',
  };

  async function call(method, path, body) {
    const res = await request(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: 30000,
      bodyTimeout: 30000,
    });
    const text = await res.body.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (res.statusCode >= 400) {
      const msg = (json && (json.message || json.error)) || text || ('HTTP ' + res.statusCode);
      const err = new Error(`AirDC++ ${method} ${path}: ${msg}`);
      err.status = res.statusCode;
      throw err;
    }
    return json;
  }

  return {
    base,

    // A cheap authed call to verify host + credentials (used by the test button).
    // AirDC++ exposes system info; if the exact path differs we fall back to
    // creating+removing a search instance, which also proves auth works.
    async ping() {
      try { return await call('GET', '/system/stats'); }
      catch (e) {
        if (e.status === 401 || e.status === 403) throw e; // auth failure — real
        const inst = await call('POST', '/search'); // proves auth another way
        if (inst && inst.id != null) { await this.removeSearchInstance(inst.id).catch(() => {}); return { ok: true }; }
        throw e;
      }
    },

    // Stateful search: an instance holds the result→source mapping used to
    // download. POST /search → { id }.
    async createSearchInstance() {
      const d = await call('POST', '/search');
      return d && d.id;
    },

    // Send a query to the hubs. file_type 'file' | 'directory' | 'tth';
    // extensions restricts server-side. Optional hub_urls limits which hubs.
    async hubSearch(instanceId, { pattern, fileType = 'file', extensions = null, hubs = null, priority = 3 } = {}) {
      const query = { pattern, file_type: fileType };
      if (extensions && extensions.length) query.extensions = extensions;
      const body = { query, priority };
      if (hubs && hubs.length) body.hub_urls = hubs;
      return call('POST', `/search/${instanceId}/hub_search`, body);
    },

    // Fetch accumulated results (grouped per file, sorted by relevance).
    async getResults(instanceId, start = 0, count = 50) {
      return (await call('GET', `/search/${instanceId}/results/${start}/${count}`)) || [];
    },

    // Queue a specific result for download. AirDC++ writes to target_directory
    // (its own filesystem view). Returns { bundle_info: { id } }.
    async downloadResult(instanceId, resultId, { targetDirectory, targetName, priority = 4 } = {}) {
      const body = { priority };
      if (targetDirectory) body.target_directory = targetDirectory;
      if (targetName) body.target_name = targetName;
      return call('POST', `/search/${instanceId}/results/${resultId}/download`, body);
    },

    // Bundle status for monitoring a download to completion.
    async getBundle(bundleId) {
      return call('GET', `/queue/bundles/${bundleId}`);
    },

    // Cancel/remove a queued bundle (used to abort a grab).
    async removeBundle(bundleId, { removeFinished = false } = {}) {
      return call('POST', `/queue/bundles/${bundleId}/remove`, { remove_finished: removeFinished });
    },

    async removeSearchInstance(instanceId) {
      return call('DELETE', `/search/${instanceId}`);
    },

    // Read an AirDC++ setting (e.g. 'download_directory' — where finished
    // downloads land in AirDC++'s own filesystem view).
    async settingGet(key) {
      const d = await call('POST', '/settings/get', { keys: [key] });
      return d ? d[key] : undefined;
    },

    // ---- Filelists (browse a peer's share directly — no hub search) --------
    // Open a PARTIAL filelist at one directory of a peer's share. Cheap: only
    // that folder is transferred. Returns the session (id == the user's CID).
    async openFilelist(user, directory) {
      return call('POST', '/filelists', { user: { cid: user.cid, hub_url: user.hub_url }, directory });
    },
    // Session state — state.id becomes 'loaded' when the folder listing is in.
    async getFilelistInfo(id) {
      return call('GET', `/filelists/${id}`);
    },
    // Items of the loaded directory ({ items: [{ id, name, path, size, tth, type, dupe }] }).
    async getFilelistItems(id, start = 0, count = 500) {
      const d = await call('GET', `/filelists/${id}/items/${start}/${count}`);
      return d?.items || [];
    },
    async closeFilelist(id) {
      return call('DELETE', `/filelists/${id}`);
    },

    // Queue a single file by TTH (content hash). AirDC++ finds sources for it
    // itself — any peer sharing the file serves it, not just the one whose
    // filelist we saw it in. NOTE: target_directory must end with '/' (AirDC++
    // string-concatenates directory + name).
    async queueFileByTth({ targetDirectory, targetName, size, tth, priority = 4 }) {
      const dir = String(targetDirectory).replace(/\/*$/, '/');
      return call('POST', '/queue/bundles/file', {
        target_directory: dir, target_name: targetName, size, tth, priority,
      });
    },
  };
}
