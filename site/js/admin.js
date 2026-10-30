/* Dynasty Archive - control panel.
   A static site can't save files, so this talks to the GitHub API from your browser
   (using a personal access token you paste in) and commits the changes to your repo.
   GitHub Actions then redeploys the site. */
(function () {
  'use strict';
  const GAMES = [
    ['cfb', 'College Football (CFB27)', 'College Football'],
    ['madden', 'Madden', 'Madden'],
    ['nba', 'NBA 2K27', 'NBA 2K'],
    ['cbb', 'College Basketball (2K8)', 'College Basketball'],
    ['ootp', 'Out of the Park Baseball (OOTP 27)', 'Baseball'],
    ['fm', 'Football Manager', 'Football Manager'],
    ['other', 'Other game', 'Other'],
  ];
  const KEY = 'da_admin';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let S = null, root = null, current = [];

  /* ---------- saved connection ---------- */
  function loadConn() { try { return JSON.parse(localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function saveConn(c, remember) {
    try {
      const j = JSON.stringify(c);
      (remember ? localStorage : sessionStorage).setItem(KEY, j);
      (remember ? sessionStorage : localStorage).removeItem(KEY);
    } catch (e) { /* storage blocked: connection lasts until the page closes */ }
  }
  function clearConn() { try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } S = null; }
  function guessRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split('/').filter(Boolean)[0] || '';
    return { owner: m ? m[1] : '', repo: m && seg && !/\.html?$/.test(seg) ? seg : '' };
  }

  /* ---------- GitHub API ---------- */
  async function gh(method, path, body) {
    const r = await fetch('https://api.github.com' + path, {
      method,
      headers: Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + S.token, 'X-GitHub-Api-Version': '2022-11-28' },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      let m = '';
      try { m = (await r.json()).message; } catch (e) { /* no body */ }
      const err = new Error(`GitHub said ${r.status}${m ? ': ' + m : ''}`);
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? null : r.json();
  }
  const repoPath = () => `/repos/${S.owner}/${S.repo}`;
  const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  async function readJSON(path) {
    try {
      const j = await gh('GET', `${repoPath()}/contents/${path}?ref=${encodeURIComponent(S.branch)}`);
      return JSON.parse(b64d(j.content));
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }
  /* One commit: write some files, delete everything under some folders. */
  async function commit(message, writes, deletePrefixes) {
    const base = repoPath();
    const ref = await gh('GET', `${base}/git/ref/heads/${encodeURIComponent(S.branch)}`);
    const parent = ref.object.sha;
    const pc = await gh('GET', `${base}/git/commits/${parent}`);
    const tree = writes.map((w) => ({ path: w.path, mode: '100644', type: 'blob', content: w.content }));
    if (deletePrefixes.length) {
      const t = await gh('GET', `${base}/git/trees/${pc.tree.sha}?recursive=1`);
      if (t.truncated) throw new Error('The repository is too large to list through the API. Delete the folder on github.com instead.');
      t.tree.filter((e) => e.type === 'blob' && deletePrefixes.some((p) => (p.endsWith('/') ? e.path.startsWith(p) : e.path === p)))
        .forEach((e) => tree.push({ path: e.path, mode: '100644', type: 'blob', sha: null }));
    }
    const nt = await gh('POST', `${base}/git/trees`, { base_tree: pc.tree.sha, tree });
    const nc = await gh('POST', `${base}/git/commits`, { message, tree: nt.sha, parents: [parent] });
    await gh('PATCH', `${base}/git/refs/heads/${encodeURIComponent(S.branch)}`, { sha: nc.sha });
    return nc.sha;
  }

  /* ---------- views ---------- */
  function setMsg(kind, html) {
    const el = root.querySelector('#msg');
    if (el) el.innerHTML = html ? `<div class="msg ${kind}">${html}</div>` : '';
  }
  function connectView() {
    const g = guessRepo();
    root.innerHTML = `<div class="page"><h2>Control panel</h2>
      <div class="pn" style="max-width:640px">
        <h3>Connect to GitHub</h3>
        <p class="foot" style="margin-top:0">Changes made here are saved as commits to your repository, so the panel needs a token that is allowed to edit it. Only you will have it, and it stays in this browser.</p>
        <ol class="foot" style="padding-left:18px">
          <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.</li>
          <li>Name it "Dynasty Archive", pick an expiration, and under <b>Repository access</b> choose <b>Only select repositories</b> and pick this repo.</li>
          <li>Under <b>Permissions → Repository permissions</b>, set <b>Contents</b> to <b>Read and write</b>. Generate the token and paste it below.</li>
        </ol>
        <form id="cf" class="fgrid" autocomplete="off">
          <label class="f"><span>GitHub username</span><input id="co" required value="${esc(g.owner)}"></label>
          <label class="f"><span>Repository name</span><input id="cr" required value="${esc(g.repo)}"></label>
          <label class="f"><span>Branch</span><input id="cb" required value="main"></label>
          <label class="f full"><span>Access token</span><input id="ct" type="password" required placeholder="github_pat_…"></label>
          <label class="f full chk"><input id="cm" type="checkbox"> Remember on this device (otherwise it's forgotten when you close the tab)</label>
          <div class="full"><button class="btn" type="submit">Connect</button></div>
        </form>
        <div id="msg"></div>
      </div></div>`;
    root.querySelector('#cf').onsubmit = async (e) => {
      e.preventDefault();
      const c = { owner: root.querySelector('#co').value.trim(), repo: root.querySelector('#cr').value.trim(),
        branch: root.querySelector('#cb').value.trim() || 'main', token: root.querySelector('#ct').value.trim() };
      S = c;
      setMsg('', '');
      try {
        const r = await gh('GET', repoPath());
        if (r.permissions && !r.permissions.push) throw new Error('This token can read the repo but not change it. Give it Contents: Read and write.');
        saveConn(c, root.querySelector('#cm').checked);
        await panelView();
      } catch (err) {
        S = null;
        setMsg('err', esc(err.status === 404 ? 'Repository not found. Check the username and repo name, and that the token has access to it.' : err.status === 401 ? 'GitHub rejected that token.' : err.message));
      }
    };
  }

  function dynRow(d) {
    return `<tr><td><span class="sw" style="background:${esc(d.p)}"></span><b>${esc(d.name)}</b><br><span class="lbl">${esc(d.slug)}</span></td><td>${esc(d.group)}</td><td>${esc(d.status)}</td><td>${(d.seasons || []).length}</td><td>${(d.players || 0).toLocaleString()}</td><td>${d.articles || 0}</td><td><button class="btn danger del" type="button" data-slug="${esc(d.slug)}">Delete</button></td></tr>`;
  }
  async function refreshList() {
    const box = root.querySelector('#lst');
    try {
      current = await readJSON('site/data/dynasties.json');
      populateStoryDyn();
      box.innerHTML = current.length
        ? `<div class="tw"><table class="t"><thead><tr><th>Dynasty</th><th>Game</th><th>Status</th><th>Seasons</th><th>Players</th><th>Stories</th><th></th></tr></thead><tbody>${current.map(dynRow).join('')}</tbody></table></div>`
        : '<p class="empty" style="padding:6px 0">No dynasties yet. Create one below.</p>';
    } catch (err) {
      box.innerHTML = `<p class="empty">Could not read the dynasty list (${esc(err.message)}).</p>`;
    }
  }

  async function panelView() {
    const yr = new Date().getFullYear();
    root.innerHTML = `<div class="page"><h2>Control panel</h2>
      <p class="foot" style="margin-top:0">Connected to <b>${esc(S.owner)}/${esc(S.repo)}</b> (${esc(S.branch)}) · <a href="#" id="disc">Disconnect</a></p>
      <div id="msg"></div>
      <div class="pn"><h3>Your dynasties</h3><div id="lst"><p class="loading">Loading…</p></div></div>
      <h2>Stories</h2>
      <div class="pn"><h3>Stories</h3>
        <label class="f" style="max-width:360px"><span>Dynasty</span><select id="sd"></select></label>
        <div id="sl" style="margin-top:12px"></div>
      </div>
      <div class="gap"></div>
      <form id="sf" class="pn fgrid" autocomplete="off">
        <h3 class="full" style="margin-bottom:0">Write a story</h3>
        <label class="f"><span>Type</span><select id="sk">${KINDS.map((k) => `<option value="${k[0]}">${k[1]}</option>`).join('')}</select></label>
        <label class="f full"><span>Headline</span><input id="stt" required maxlength="200"></label>
        <label class="f"><span>Season (year)</span><input id="ss" type="number" min="1800" max="2200" required></label>
        <label class="f"><span>Week or game # (optional)</span><input id="sw" maxlength="6"></label>
        <label class="f"><span>Date shown (optional)</span><input id="sdt" maxlength="30" placeholder="e.g. Sept. 12"></label>
        <label class="f full"><span>One-line summary (optional)</span><input id="sde" maxlength="300" placeholder="If blank, the first paragraph is used"></label>
        <label class="f full"><span>Story (markdown)</span><textarea id="sb" rows="14" required></textarea></label>
        <p class="foot full" style="margin:0">A blank line starts a new paragraph. <b>**bold**</b>, <i>*italic*</i>, and a line starting with &gt; becomes a pull quote.</p>
        <div class="full"><button class="btn" type="submit" id="sbtn">Publish story</button></div>
      </form>
      <div class="gap"></div>
      <div class="pn fgrid" id="si">
        <h3 class="full" style="margin-bottom:0">Import story files</h3>
        <label class="f full"><span>Markdown files (.md), pick one or several</span><input id="if" type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain"></label>
        <label class="f"><span>Season, for files that don't say</span><input id="iss" type="number" min="1800" max="2200"></label>
        <label class="f"><span>Type, for files that don't say</span><select id="ik">${KINDS.map((k) => `<option value="${k[0]}">${k[1]}</option>`).join('')}</select></label>
        <div class="full" id="ipv"></div>
        <div class="full"><button class="btn" type="button" id="ibtn" disabled>Publish</button></div>
      </div>
      <h2>New dynasty</h2>
      <form id="nf" class="pn fgrid" autocomplete="off">
        <label class="f"><span>Game</span><select id="ng">${GAMES.map((g) => `<option value="${g[0]}">${esc(g[1])}</option>`).join('')}</select></label>
        <label class="f"><span>Dynasty name</span><input id="nn" required maxlength="40" placeholder="e.g. Charlotte Hornets"></label>
        <label class="f"><span>Short name (big headline)</span><input id="ns" maxlength="20" placeholder="e.g. Hornets"></label>
        <label class="f"><span>Full team name (under it)</span><input id="nl" maxlength="40" placeholder="optional"></label>
        <label class="f"><span>Initials (crest)</span><input id="ni" maxlength="4" placeholder="auto"></label>
        <label class="f"><span>Starting season (year)</span><input id="ny" type="number" min="1800" max="2200" required value="${yr}"></label>
        <label class="f"><span>Status</span><select id="nt"><option value="current">Current</option><option value="archived">Archived</option></select></label>
        <label class="f"><span>Main color</span><input id="np" type="color" value="#2b3a67"></label>
        <label class="f"><span>Accent color</span><input id="na" type="color" value="#c9a24b"></label>
        <div class="full"><button class="btn" type="submit" id="nb">Create dynasty</button></div>
      </form>
      <p class="foot">Changes are saved to GitHub as a commit, then the site redeploys (usually 1–2 minutes). If you also build on your computer, <b>pull the latest changes first</b> so you don't overwrite what you did here.</p>
    </div>`;
    root.querySelector('#disc').onclick = (e) => { e.preventDefault(); clearConn(); connectView(); };
    root.querySelector('#lst').onclick = onDelete;
    root.querySelector('#nf').onsubmit = onCreate;
    root.querySelector('#sd').onchange = () => { selSlug = root.querySelector('#sd').value; onStoryDynChange(); };
    root.querySelector('#sl').onclick = onStoryDelete;
    root.querySelector('#sf').onsubmit = onStoryCreate;
    root.querySelector('#if').onchange = onFilesPicked;
    root.querySelector('#iss').oninput = renderPreview;
    root.querySelector('#ik').onchange = renderPreview;
    root.querySelector('#ibtn').onclick = onImport;
    await refreshList();
  }

  const actionsLink = () => `<a href="https://github.com/${esc(S.owner)}/${esc(S.repo)}/actions" target="_blank" rel="noopener">Watch the deploy on GitHub</a>`;
  function slugify(s) { return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  async function onCreate(e) {
    e.preventDefault();
    const btn = root.querySelector('#nb');
    const val = (id) => root.querySelector('#' + id).value.trim();
    btn.disabled = true; setMsg('', '');
    try {
      const name = val('nn'), game = val('ng'), year = parseInt(val('ny'), 10);
      const slug = slugify(name);
      if (!slug) throw new Error('Give the dynasty a name using letters or numbers.');
      if (!year) throw new Error('Enter the starting season as a year.');
      const [cfg, list] = await Promise.all([readJSON('dynasties.json'), readJSON('site/data/dynasties.json')]);
      if (cfg.some((d) => d.slug === slug) || list.some((d) => d.slug === slug)) throw new Error(`A dynasty called "${slug}" already exists. Pick a different name.`);
      const short = val('ns') || name, full = val('nl') || name;
      const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
      const init = (val('ni') || (words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 3) : (words[0] || name).slice(0, 3))).toUpperCase();
      const entry = { slug, name, short, full, init, game, status: val('nt'), p: val('np'), s: val('na'), start_year: year };
      const group = GAMES.find((g) => g[0] === game)[2];
      const cfgEntry = Object.assign({}, entry);
      if (game === 'cfb') cfgEntry.source = `imports/${slug}/*.html`;
      if (game === 'ootp') cfgEntry.source = `imports/${slug}/csv`;
      const listEntry = Object.assign({}, entry, { group, seasons: [], current_year: null, latest: null, players: 0, articles: 0 });
      cfg.push(cfgEntry); list.push(listEntry);
      await commit(`Add dynasty: ${name}`, [
        { path: 'dynasties.json', content: JSON.stringify(cfg, null, 2) + '\n' },
        { path: 'site/data/dynasties.json', content: JSON.stringify(list) },
        { path: `site/data/${slug}/articles.json`, content: '[]' },
        { path: `site/data/${slug}/schema.json`, content: JSON.stringify({ cats: {}, teams: [], start_year: year }) },
      ], []);
      root.querySelector('#nf').reset();
      setMsg('ok', `<b>${esc(name)}</b> was added. The site redeploys in a minute or two, then it appears on the home page. ${actionsLink()}`);
      await refreshList();
    } catch (err) {
      setMsg('err', esc(err.message));
    } finally { btn.disabled = false; }
  }

  async function onDelete(e) {
    const b = e.target.closest('button.del');
    if (!b) return;
    const slug = b.dataset.slug, d = current.find((x) => x.slug === slug);
    if (!d) return;
    const typed = window.prompt(`Delete "${d.name}"?\n\nThis removes the dynasty, its stats data and any stories in content/${slug}/ from your repository (they stay in GitHub's history). Files on your own computer are not touched.\n\nType "${slug}" to confirm:`);
    if (typed !== slug) return;
    b.disabled = true; setMsg('', '');
    try {
      const [cfg, list] = await Promise.all([readJSON('dynasties.json'), readJSON('site/data/dynasties.json')]);
      await commit(`Delete dynasty: ${d.name}`, [
        { path: 'dynasties.json', content: JSON.stringify(cfg.filter((x) => x.slug !== slug), null, 2) + '\n' },
        { path: 'site/data/dynasties.json', content: JSON.stringify(list.filter((x) => x.slug !== slug)) },
      ], [`site/data/${slug}/`, `content/${slug}/`]);
      setMsg('ok', `<b>${esc(d.name)}</b> was deleted. The site updates after it redeploys. ${actionsLink()}`);
      await refreshList();
    } catch (err) {
      setMsg('err', esc(err.message));
      b.disabled = false;
    }
  }

  /* ---------- stories ---------- */
  const KINDS = [['recap', 'Game recap'], ['preview', 'Preview'], ['review', 'Season review'], ['feature', 'Feature'], ['other', 'Other']];
  let selSlug = '', stories = [], picked = [];
  const q = (id) => root.querySelector('#' + id);

  function parseMd(text) {
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const meta = {};
    let body = text;
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (m) {
      m[1].split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1'); });
      body = m[2];
    }
    if (!meta.title) {
      const h = body.match(/^\s*#\s+(.+)\n?/);
      if (h) { meta.title = h[1].trim(); body = body.replace(/^\s*#\s+.+\n?/, ''); }
    }
    return { meta, body: body.trim() };
  }
  function excerpt(md, limit) {
    limit = limit || 280;
    for (const para of md.split(/\n{2,}/)) {
      const t = para.replace(/\*+/g, '').trim();
      if (para.startsWith('**') || para.startsWith('#') || t.length < 60) continue;
      if (t.length <= limit) return t;
      const cut = t.slice(0, limit);
      const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      return i > 120 ? cut.slice(0, i + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…';
    }
    return '';
  }
  /* Same shape the build tool produces, so a later rebuild agrees with what the panel wrote. */
  function makeEntry(slug, stem, meta, body, dflt) {
    const season = /^\d+$/.test(meta.season || '') ? +meta.season : (dflt.season || null);
    const kind = meta.kind || dflt.kind || 'recap';
    const entry = { id: `${slug}-${stem}`, season, week: meta.week || null, date: meta.date || '', kind,
      title: meta.title || stem, dek: meta.dek || excerpt(body), body, source: 'md' };
    const fm = ['---', 'title: ' + entry.title];
    if (season) fm.push('season: ' + season);
    if (entry.week) fm.push('week: ' + entry.week);
    fm.push('kind: ' + kind);
    if (entry.date) fm.push('date: ' + entry.date);
    if (meta.dek) fm.push('dek: ' + meta.dek);
    fm.push('---', '');
    return { stem, entry, text: fm.join('\n') + '\n' + body + '\n' };
  }
  const sortArticles = (a) => a.sort((x, y) => (x.season || 0) - (y.season || 0) || (parseInt(x.week, 10) || 0) - (parseInt(y.week, 10) || 0) || String(x.date).localeCompare(String(y.date)));

  async function publishStories(slug, items, message) {
    const [arts, list] = await Promise.all([readJSON(`site/data/${slug}/articles.json`), readJSON('site/data/dynasties.json')]);
    const d = list.find((x) => x.slug === slug);
    if (!d) throw new Error('That dynasty no longer exists.');
    let replaced = 0;
    items.forEach((it) => {
      const i = arts.findIndex((a) => a.id === it.entry.id);
      if (i >= 0) {
        if (arts[i].source === 'report') throw new Error(`"${it.entry.id}" is already used by a story from a season report. Rename the file or headline.`);
        arts[i] = it.entry; replaced++;
      } else arts.push(it.entry);
    });
    sortArticles(arts);
    d.articles = arts.length;
    await commit(message, items.map((it) => ({ path: `content/${slug}/${it.stem}.md`, content: it.text })).concat([
      { path: `site/data/${slug}/articles.json`, content: JSON.stringify(arts) },
      { path: 'site/data/dynasties.json', content: JSON.stringify(list) },
    ]), []);
    return replaced;
  }

  function populateStoryDyn() {
    const sel = root && root.querySelector('#sd');
    if (!sel) return;
    if (!current.some((d) => d.slug === selSlug)) selSlug = current.length ? current[0].slug : '';
    sel.innerHTML = current.map((d) => `<option value="${esc(d.slug)}"${d.slug === selSlug ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
    onStoryDynChange();
  }
  async function onStoryDynChange() {
    const d = current.find((x) => x.slug === selSlug);
    const dflt = d ? (d.current_year || d.start_year || '') : '';
    ['ss', 'iss'].forEach((id) => { const el = q(id); if (el && !el.dataset.touched) el.value = dflt; });
    const box = q('sl');
    if (!d) { box.innerHTML = '<p class="empty" style="padding:0">Create a dynasty first.</p>'; stories = []; return; }
    box.innerHTML = '<p class="loading" style="padding:0">Loading…</p>';
    try {
      stories = await readJSON(`site/data/${d.slug}/articles.json`);
      box.innerHTML = stories.length
        ? `<div class="tw"><table class="t"><thead><tr><th>Headline</th><th>Season</th><th>Type</th><th></th></tr></thead><tbody>${stories.slice().reverse().map((a) =>
          `<tr><td>${esc(a.title)}</td><td>${a.season || ''}${a.week ? ' · ' + esc(a.week) : ''}</td><td>${esc(a.kind)}</td><td>${a.source === 'md' ? `<button class="btn danger sdel" type="button" data-id="${esc(a.id)}">Delete</button>` : '<span class="lbl">from season report</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty" style="padding:0">No stories for this dynasty yet.</p>';
    } catch (err) { box.innerHTML = `<p class="empty" style="padding:0">Could not read stories (${esc(err.message)}).</p>`; }
  }
  document.addEventListener('input', (e) => { if (e.target && (e.target.id === 'ss' || e.target.id === 'iss')) e.target.dataset.touched = '1'; });

  async function onStoryCreate(e) {
    e.preventDefault();
    const btn = q('sbtn'), v = (id) => q(id).value.trim();
    btn.disabled = true; setMsg('', '');
    try {
      const d = current.find((x) => x.slug === selSlug);
      if (!d) throw new Error('Pick a dynasty first (the Stories box above).');
      const title = v('stt'), season = parseInt(v('ss'), 10), body = q('sb').value.trim(), week = v('sw');
      if (!title || !body) throw new Error('A story needs a headline and some text.');
      if (!season) throw new Error('Enter the season as a year.');
      const stem = `${season}-${week ? 'wk' + slugify(week) + '-' : ''}${slugify(title).slice(0, 50) || 'story'}`;
      if (stories.some((a) => a.id === `${d.slug}-${stem}`)) throw new Error('You already have a story with that headline for this season.');
      const meta = { title, season: String(season), week, kind: v('sk'), date: v('sdt'), dek: v('sde') };
      await publishStories(d.slug, [makeEntry(d.slug, stem, meta, body, {})], `Add story: ${title}`);
      q('sf').reset();
      q('ss').value = season;
      setMsg('ok', `<b>${esc(title)}</b> was published to ${esc(d.name)}. It appears after the site redeploys (a minute or two). ${actionsLink()}`);
      await refreshList();
    } catch (err) { setMsg('err', esc(err.message)); } finally { btn.disabled = false; }
  }

  const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read ' + f.name)); r.readAsText(f); });
  async function onFilesPicked() {
    const files = Array.from(q('if').files || []);
    try { picked = await Promise.all(files.map(async (f) => ({ name: f.name, text: await readFile(f) }))); } catch (err) { picked = []; setMsg('err', esc(err.message)); }
    renderPreview();
  }
  function importItems() {
    const dflt = { season: parseInt(q('iss').value, 10) || null, kind: q('ik').value };
    return picked.map((f) => {
      const { meta, body } = parseMd(f.text);
      const stem = slugify(f.name.replace(/\.[^.]+$/, '')) || 'story';
      return makeEntry(selSlug, stem, meta, body, dflt);
    });
  }
  function renderPreview() {
    const box = q('ipv'), btn = q('ibtn');
    if (!picked.length) { box.innerHTML = ''; btn.disabled = true; return; }
    const items = importItems();
    const bad = items.filter((it) => !it.entry.season || !it.entry.body);
    box.innerHTML = `<div class="tw"><table class="t"><thead><tr><th>File</th><th>Headline</th><th>Season</th><th>Type</th><th></th></tr></thead><tbody>${items.map((it) =>
      `<tr><td>${esc(it.stem)}.md</td><td>${esc(it.entry.title)}</td><td>${it.entry.season || '<b class="L">missing</b>'}${it.entry.week ? ' · ' + esc(it.entry.week) : ''}</td><td>${esc(it.entry.kind)}</td><td>${stories.some((a) => a.id === it.entry.id) ? '<span class="lbl">replaces existing</span>' : '<span class="lbl">new</span>'}</td></tr>`).join('')}</tbody></table></div>` +
      (bad.length ? '<p class="foot">Some files have no season. Fill in the season box above, or add a season: line to the file.</p>' : '');
    btn.disabled = !!bad.length;
    btn.textContent = `Publish ${items.length} ${items.length === 1 ? 'story' : 'stories'}`;
  }
  async function onImport() {
    const btn = q('ibtn');
    btn.disabled = true; setMsg('', '');
    try {
      const d = current.find((x) => x.slug === selSlug);
      if (!d) throw new Error('Pick a dynasty first.');
      const items = importItems();
      const replaced = await publishStories(d.slug, items, items.length === 1 ? `Add story: ${items[0].entry.title}` : `Add ${items.length} stories to ${d.name}`);
      picked = []; q('if').value = ''; renderPreview();
      setMsg('ok', `${items.length} ${items.length === 1 ? 'story was' : 'stories were'} published to <b>${esc(d.name)}</b>${replaced ? ` (${replaced} replaced an existing story)` : ''}. They appear after the site redeploys. ${actionsLink()}`);
      await refreshList();
    } catch (err) { setMsg('err', esc(err.message)); btn.disabled = false; }
  }

  async function onStoryDelete(e) {
    const b = e.target.closest('button.sdel');
    if (!b) return;
    const d = current.find((x) => x.slug === selSlug), a = stories.find((x) => x.id === b.dataset.id);
    if (!d || !a) return;
    if (!window.confirm(`Delete the story "${a.title}"? It stays in GitHub's history.`)) return;
    b.disabled = true; setMsg('', '');
    try {
      const [arts, list] = await Promise.all([readJSON(`site/data/${d.slug}/articles.json`), readJSON('site/data/dynasties.json')]);
      const rest = arts.filter((x) => x.id !== a.id);
      const ld = list.find((x) => x.slug === d.slug);
      if (ld) ld.articles = rest.length;
      await commit(`Delete story: ${a.title}`, [
        { path: `site/data/${d.slug}/articles.json`, content: JSON.stringify(rest) },
        { path: 'site/data/dynasties.json', content: JSON.stringify(list) },
      ], [`content/${d.slug}/${a.id.slice(d.slug.length + 1)}.md`]);
      setMsg('ok', `<b>${esc(a.title)}</b> was deleted. ${actionsLink()}`);
      await refreshList();
    } catch (err) { setMsg('err', esc(err.message)); b.disabled = false; }
  }

  window.DAAdmin = {
    render(el) { root = el; S = S || loadConn(); if (S && S.token) return panelView(); connectView(); return Promise.resolve(); },
  };
})();
