// AirDC++ client UI — injected by core via window.BackIssue. Adds the source
// settings section (toggle + connection + hubs + download dir + search timing)
// and a Test button. Reuses core CSS classes; no extra stylesheet.
(function () {
  const $ = (id) => document.getElementById(id);

  window.BackIssue.registerClient((api) => {
    // Translations: api.t when the host has it (BackIssue > 0.9.0), the inline
    // English otherwise. Catalog keys live under locales/<lang>.json.
    const NS = 'airdcpp.';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k]))) : String(s));
    const tr = (key, en, params) => { if (typeof api.t !== 'function') return fill(en, params); const v = api.t(NS + key, params); return v === NS + key ? fill(en, params) : v; };
    // innerHTML variant: params escaped, only simple inline tags pass through.
    const trh = (key, en, params) => {
      if (typeof api.th === 'function' && api.t(NS + key) !== NS + key) return api.th(NS + key, params);
      const tokens = params ? Object.fromEntries(Object.keys(params).map((k) => [k, '\u0000' + k + '\u0000'])) : undefined;
      let html = esc(fill(en, tokens)).replace(/&lt;(\/?)(b|i|em|strong|code|br|kbd)&gt;/g, '<$1$2>');
      if (params) for (const [k, v] of Object.entries(params)) html = html.split('\u0000' + k + '\u0000').join(esc(v ?? ''));
      return html;
    };
    const te = (key, en, params) => esc(tr(key, en, params));

    const src = api.slot('settings-plugin-sources');
    if (src) {
      const block = document.createElement('div');
      block.className = 'src-block';
      block.innerHTML =
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-airdcppEnabled" type="checkbox"><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>AirDC++</b><span class="modal__note src-toggle__note">' + te('intro', 'Search & download from Direct Connect hubs via the AirDC++ Web API. Reaches material indexers/DDL sites don\'t.') + '</span></div>' +
        '</div>' +
        '<div id="airdcpp-config" class="src-config">' +
          '<label class="field"><span>' + te('webApiUrl', 'Web API URL') + '</span><input id="set-airdcppHost" type="text" spellcheck="false" placeholder="http://192.168.1.109:5600"></label>' +
          '<label class="field"><span>' + te('username', 'Username') + '</span><input id="set-airdcppUser" type="text" spellcheck="false" autocomplete="off"></label>' +
          '<label class="field"><span>' + te('password', 'Password') + '</span><input id="set-airdcppPass" type="password" spellcheck="false" autocomplete="new-password"></label>' +
          '<div class="client-test"><button id="airdcpp-test" class="btn btn--ghost" type="button">' + te('testConnection', 'Test connection') + '</button><span id="airdcpp-test-result" class="client-status" hidden></span></div>' +
          '<label class="field"><span>' + te('hubUrls', 'Hub URLs (optional)') + '</span><input id="set-airdcppHubs" type="text" spellcheck="false" placeholder="' + te('hubUrlsPlaceholder', 'adcs://hub.example:2780 (comma-separated)') + '"></label>' +
          '<p class="modal__note">' + te('hubsNote', 'Limit searches to specific comic hubs (comma-separated). Blank searches every hub AirDC++ is connected to.') + '</p>' +

          '<p class="modal__subhead modal__subhead--sub">' + te('announceBots', 'Announce bots') + '</p>' +
          '<label class="field"><span>' + te('watchNicks', 'Watch bot nicks') + '</span><input id="set-airdcppWatchNicks" type="text" spellcheck="false" placeholder="' + te('watchNicksPlaceholder', 'UploadBot, Announce (comma-separated)') + '"></label>' +
          '<p class="modal__note">' + trh('watchNote', 'Hub bots (users) that announce new uploads with magnet links. Messages from these nicks — in main chat or PM — are scanned, and announced files matching a <b>missing issue of a followed series</b> download automatically by exact hash. Enable and schedule the check on the <b>Jobs</b> page ("Watch AirDC++ announcements").') + '</p>' +

          '<p class="modal__subhead modal__subhead--sub">' + te('completedFiles', 'Completed files') + '</p>' +
          '<label class="field"><span>' + te('downloadDirRemote', 'Download folder (AirDC++\'s view)') + '</span><input id="set-airdcppDownloadDirRemote" type="text" spellcheck="false" placeholder="/downloads/comics"></label>' +
          '<label class="field"><span>' + te('downloadDirLocal', 'Download folder (this app\'s view)') + '</span><input id="set-airdcppDownloadDir" type="text" spellcheck="false" placeholder="\\\\TOWER\\downloads\\comics"></label>' +
          '<p class="modal__note">' + te('downloadNote', 'AirDC++ downloads to the first path; this app imports (copies) from the second. Only differ if AirDC++ is on another machine — map its folder onto the path this app reads over the network. The AirDC++ copy is left in place so it keeps sharing.') + '</p>' +

          '<p class="modal__subhead modal__subhead--sub">' + te('search', 'Search') + '</p>' +
          '<div class="fields-row">' +
            '<label class="field"><span>' + te('maxWait', 'Max wait (ms)') + '</span><input id="set-airdcppSearchWaitMs" type="number" min="2000" max="120000" step="1000"></label>' +
            '<label class="field"><span>' + te('giveUpEmpty', 'Give up if empty (ms)') + '</span><input id="set-airdcppSearchEmptyMs" type="number" min="1500" max="60000" step="500" placeholder="5000"></label>' +
            '<label class="field"><span>' + te('pollEvery', 'Poll every (ms)') + '</span><input id="set-airdcppSearchPollMs" type="number" min="500" max="10000" step="500"></label>' +
            '<label class="field"><span>' + te('cooldown', 'Cooldown (ms)') + '</span><input id="set-airdcppSearchCooldownMs" type="number" min="0" max="60000" step="500"></label>' +
            '<label class="field"><span>' + te('retryEmpties', 'Retry empties') + '</span><input id="set-airdcppSearchRetries" type="number" min="0" max="5" step="1" placeholder="1"></label>' +
          '</div>' +
          '<p class="modal__note">' + trh('searchNote', 'DC results arrive from peers over a few seconds; the search returns as soon as a confident match arrives, or when the wait cap is hit. A search that returns <b>nothing</b> by <b>Give up if empty</b> stops there — a shared file\'s peers reply within seconds, so continued silence means it isn\'t on DC (this is what keeps searches for rarely-shared issues from crawling). Searches run <b>one at a time</b> spaced by the cooldown — DC hubs rate-limit, so bulk downloads are throttled (slow but reliable) rather than failing. An empty search may be retried <b>Retry empties</b> times, but <b>keep this at 1 (or 0)</b>: many hubs flag the same search repeated ~3 times as spam and then return nothing anyway.') + '</p>' +
          '<label class="field"><span>' + te('stallTimeout', 'Download stall timeout (ms)') + '</span><input id="set-airdcppDownloadStallMs" type="number" min="60000" max="1800000" step="30000"></label>' +
          '<p class="modal__note">' + te('stallNote', 'Give up on a download that makes no progress for this long — a bundle with no seeders (or one AirDC++ drops from its queue) can otherwise stall the queue slot forever.') + '</p>' +
        '</div>';
      src.appendChild(block);
    }

    const enabled = $('set-airdcppEnabled');
    if (enabled) enabled.onchange = () => api.refreshSourceUI();

    api.onSourcesSync(() => {
      const en = !!(enabled && enabled.checked);
      const cfg = $('airdcpp-config'); if (cfg) cfg.classList.toggle('open', en);
      return en;
    });

    const testBtn = $('airdcpp-test');
    if (testBtn) testBtn.onclick = async () => {
      const el = $('airdcpp-test-result');
      el.hidden = false; el.className = 'client-status is-testing'; el.textContent = tr('testing', 'Testing…');
      let r;
      try {
        r = await api.post('/api/airdcpp/test', {
          airdcppHost: ($('set-airdcppHost').value || '').trim(),
          airdcppUser: ($('set-airdcppUser').value || '').trim(),
          airdcppPass: $('set-airdcppPass').value || '',
        });
      } catch (e) { r = { ok: false, message: String(e) }; }
      el.className = 'client-status ' + (r.ok ? 'is-ok' : 'is-bad');
      el.textContent = (r.ok ? '✓ ' : '✕ ') + r.message;
    };
  });
})();
