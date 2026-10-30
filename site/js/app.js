/* Dynasty Archive - static site. Reads JSON from ./data, no server needed. */
(function () {
  'use strict';
  const rootEl = document.getElementById('root');
  const sideEl = document.getElementById('side');
  const navEl = document.getElementById('nav');
  let DYN = [];

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cache = {};
  const getJSON = (u) => cache[u] || (cache[u] = fetch(u).then((r) => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); }));
  const dyn = (slug) => DYN.find((d) => d.slug === slug);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function theme(d) {
    const r = document.documentElement.style;
    r.setProperty('--p', d ? d.p : '#2B3040');
    r.setProperty('--s', d ? d.s : '#9AA0AE');
  }
  function cell(c, slug) {
    if (Array.isArray(c)) return `<a href="#/d/${slug}/p/${c[1]}">${esc(c[0])}</a>`;
    return c == null ? '' : esc(c);
  }
  function table(heads, rowsHtml) {
    return `<div class="tw"><table class="t"><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rowsHtml.join('')}</tbody></table></div>`;
  }
  const tr = (cells, slug, cls) => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c) => `<td>${cell(c, slug)}</td>`).join('')}</tr>`;
  const pn = (cls, h, body, link) => `<section class="pn ${cls}"><h3>${h}${link ? `<a href="${link[0]}">${link[1]}</a>` : ''}</h3>${body}</section>`;

  /* minimal markdown: paragraphs, headings, quotes, bold/italic/links */
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
      .replace(/\[(.+?)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  }
  function markdown(md) {
    return md.replace(/\r/g, '').split(/\n{2,}/).map((b) => {
      b = b.trim();
      if (!b) return '';
      if (/^-{3,}$/.test(b)) return '<hr>';
      const h = b.match(/^(#{1,3})\s+(.+)$/);
      if (h) return `<h2>${inline(h[2])}</h2>`;
      if (b.startsWith('>')) return `<blockquote>${inline(b.replace(/^>\s?/gm, ' ').trim())}</blockquote>`;
      return `<p>${inline(b.replace(/\n/g, ' '))}</p>`;
    }).join('');
  }

  /* ---------- baseball rate stats (derived from counting stats) ---------- */
  const DERIVE = {
    bat(o) {
      const ab = o.ab || 0, h = o.h || 0, bb = o.bb || 0, hp = o.hp || 0, sf = o.sf || 0;
      const tb = h + (o.d || 0) + 2 * (o.t || 0) + 3 * (o.hr || 0);
      const obp = ab + bb + hp + sf ? (h + bb + hp) / (ab + bb + hp + sf) : null;
      const slg = ab ? tb / ab : null;
      return { avg: ab ? h / ab : null, obp, slg, ops: obp != null && slg != null ? obp + slg : null };
    },
    pit(o) {
      const outs = o.outs || 0;
      return { ip: Math.floor(outs / 3) + '.' + (outs % 3), era: outs ? ((o.er || 0) * 27) / outs : null, whip: outs ? (((o.ha || 0) + (o.bb || 0)) * 3) / outs : null };
    },
  };
  const RATE3 = new Set(['avg', 'obp', 'slg', 'ops']);
  function fv(key, v) {
    if (v == null || v === '') return '–';
    if (typeof v === 'string') return esc(v);
    if (RATE3.has(key)) { const s = v.toFixed(3); return s.startsWith('0') ? s.slice(1) : s; }
    if (key === 'era' || key === 'whip') return v.toFixed(2);
    if (key === 'war') return v.toFixed(1);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  /* ---------- chrome: sidebar + nav ---------- */
  function drawChrome(active) {
    navEl.innerHTML = [['home', '#/', 'Home'], ['dynasties', '#/dynasties', 'Dynasties'], ['players', '#/players', 'Players']]
      .map((n) => `<a href="${n[1]}"${n[0] === active.nav ? ' class="on"' : ''}>${n[2]}</a>`).join('');
    const groups = {};
    DYN.forEach((d) => (groups[d.group] = groups[d.group] || []).push(d));
    sideEl.innerHTML = '<h5>Dynasties</h5><a href="#/dynasties">All Dynasties</a>' +
      Object.keys(groups).map((g) => `<h5>${esc(g)}</h5>` + groups[g].map((d) =>
        `<a href="#/d/${d.slug}"${d.slug === active.slug ? ' class="on"' : ''}><i style="background:${d.p}"></i>${esc(d.name)}</a>`).join('')).join('') +
      '<h5>Quick Links</h5><a href="#/players">Player Search</a><a href="#/admin"'+(active.nav==='admin'?' class="on"':'')+'>Control Panel</a>';
  }

  /* ---------- home / dynasties ---------- */
  function tile(d) {
    const sub = d.seasons.length ? `${d.seasons.length} season${d.seasons.length > 1 ? 's' : ''} · ${d.players.toLocaleString()} players` : 'No stats imported yet';
    return `<a class="tile${d.seasons.length ? '' : ' empty'}" href="#/d/${d.slug}" style="--p:${d.p};--s:${d.s}"><b>${esc(d.name)}</b><span>${esc(d.group)} · ${d.status === 'current' ? 'Current' : 'Archived'}</span><span>${sub}</span>${d.latest ? `<em>${d.latest.year} · ${esc(d.latest.record)}</em>` : ''}</a>`;
  }
  async function latestStories(n) {
    const all = [];
    await Promise.all(DYN.map(async (d) => {
      (await getJSON(`data/${d.slug}/articles.json`)).forEach((a) => all.push(Object.assign({ d }, a)));
    }));
    all.sort((a, b) => (b.season || 0) - (a.season || 0) || (parseInt(b.week) || 0) - (parseInt(a.week) || 0));
    return all.slice(0, n);
  }
  const storyRow = (a, showDyn) => `<a class="story" href="#/d/${a.d ? a.d.slug : a.slug}/a/${a.id}">${showDyn ? `<span class="chip" style="--c:${a.d.p}">${esc(a.d.name)}</span>` : ''}<span class="lbl">${a.season || ''}${a.week ? ' · Week ' + esc(a.week) : ''} · ${esc(a.kind)}</span><h4>${esc(a.title)}</h4><p>${esc(a.dek)}</p></a>`;

  async function homeView() {
    theme(null); drawChrome({ nav: 'home' });
    const stories = await latestStories(8);
    rootEl.innerHTML = `<div class="page"><h2>Dynasties</h2><div class="tiles">${DYN.map(tile).join('')}</div><h2>Latest stories</h2>` +
      (stories.length ? `<div class="pn">${stories.map((a) => storyRow(a, true)).join('')}</div>` : '<p class="empty">No stories yet. Add markdown files to the content folder and rebuild.</p>') + '</div>';
    document.title = 'Dynasty Archive';
  }
  function dynastiesView() {
    theme(null); drawChrome({ nav: 'dynasties' });
    const groups = {};
    DYN.forEach((d) => (groups[d.group] = groups[d.group] || []).push(d));
    rootEl.innerHTML = '<div class="page">' + Object.keys(groups).map((g) => `<h2>${esc(g)}</h2><div class="tiles">${groups[g].map(tile).join('')}</div>`).join('') + '</div>';
    document.title = 'Dynasties · Dynasty Archive';
  }

  /* ---------- dynasty pages ---------- */
  const TABS = [['overview', 'Overview'], ['schedule', 'Schedule'], ['roster', 'Roster'], ['stats', 'Stats'], ['stories', 'Stories'], ['players', 'Players']];

  function schedTable(d, rows, slug) {
    const hasDate = rows.some((r) => r[1]);
    const pf = d.game === 'ootp' ? ['R', 'RA'] : ['PF', 'PA'];
    const heads = ['Wk'.replace('Wk', d.game === 'ootp' ? 'Gm' : 'Wk')].concat(hasDate ? ['Date'] : [], ['Opponent', 'Site', 'Result', pf[0], pf[1]]);
    return table(heads, rows.map((g) => {
      if (g[2] === 'Bye') return `<tr class="bye"><td>${g[0]}</td><td colspan="${heads.length - 1}">Bye</td></tr>`;
      const cells = [g[0]].concat(hasDate ? [g[1]] : [], [g[2], g[3] === 'home' ? 'VS' : '@', `<b class="${g[4]}">${g[4]}</b>`, g[5], g[6]]);
      return `<tr>${cells.map((c, i) => `<td>${typeof c === 'string' && c.startsWith('<b') ? c : esc(c)}</td>`).join('')}</tr>`;
    }));
  }
  function leadersPanel(b, slug, group) {
    const names = Object.keys(b.leaders);
    group = names.includes(group) ? group : names[0];
    const cards = (b.leaders[group] || []).map((l) => `<div class="ld"><div class="lc">${esc(l[0])}</div><div class="ln"><a href="#/d/${slug}/p/${l[5]}">${esc(l[1])}</a><span>${l[3] !== '' ? '#' + esc(l[3]) + ' ' : ''}${esc(l[2])}</span></div><div class="lv">${l[4].map((v) => `<div><small>${esc(v[0])}</small>${esc(v[1])}</div>`).join('')}</div></div>`).join('');
    return `<div class="seg">${names.map((n) => `<button type="button" data-g="${esc(n)}" aria-pressed="${n === group}">${esc(n)}</button>`).join('')}</div>${cards || '<p class="empty">No data.</p>'}`;
  }

  async function dynastyView(slug, year, tab) {
    const d = dyn(slug);
    if (!d) return rootEl.innerHTML = '<p class="empty">Dynasty not found.</p>';
    theme(d);
    drawChrome({ nav: 'dynasties', slug });
    const hasData = d.seasons.length > 0;
    if (!year || !d.seasons.includes(year)) year = d.current_year;
    const b = hasData ? await getJSON(`data/${slug}/season-${year}.json`) : null;
    const articles = await getJSON(`data/${slug}/articles.json`);
    const seasonArticles = articles.filter((a) => a.season === year || a.season == null).reverse();

    const trio = b ? b.hero.trio.map((t) => `<div><b>${esc(t[0])}</b><small>${esc(t[1])}</small></div>`).join('') : '';
    const meta = b ? b.hero.meta : [d.group];
    const sel = d.seasons.length > 1 ? `<label class="seasonsel">Season<select id="seasonsel">${d.seasons.slice().reverse().map((y) => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select></label>` : '';
    const hero = `<section class="hero">${sel}<div class="mono" aria-hidden="true">${esc(d.short[0])}</div><div class="hrow"><div class="crest">${esc(d.init)}</div><div><h1>${esc(d.short)}</h1><div class="sub">${esc(d.full)}</div><div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div><div class="trio">${trio}</div></div></div></section>`;
    const base = hasData ? `#/d/${slug}/${year}/` : `#/d/${slug}/`;
    const tabs = `<nav class="tabs">${TABS.map((t) => `<a href="${t[0] === 'players' ? `#/d/${slug}/players` : base + t[0]}"${t[0] === tab ? ' class="on"' : ''}>${t[1]}</a>`).join('')}</nav>`;

    let body = '';
    if (tab === 'players') {
      body = '<main id="plmount"></main>';
    } else if (!hasData) {
      body = '<main><p class="empty">No stats have been imported for this dynasty yet. Add its files to the imports folder and run the build.</p>' +
        (articles.length ? `<div class="pn">${articles.map((a) => storyRow(Object.assign({ slug }, a), false)).join('')}</div>` : '') + '</main>';
    } else if (tab === 'overview') {
      const sched = b.sched.length > 14 ? b.sched.slice(-12) : b.sched;
      const recap = seasonArticles[0];
      const ps = d.game === 'ootp';
      body = `<main><div class="ov">` +
        pn('sch', `${year} Schedule &amp; Results`, schedTable(d, sched, slug) + `<p class="foot">${esc(b.record)} overall${b.conf ? ' · ' + esc(b.conf) + ' conference' : ''}${b.sched.length > 14 ? ` · <a href="${base}schedule">View all ${b.sched.length} games</a>` : ''}</p>`) +
        `<section class="pn led"><h3>Season Leaders</h3><div id="leaders">${leadersPanel(b, slug)}</div></section>` +
        '<div class="rt">' +
        pn('', `Team Stats (${year})`, `<div class="nums">${b.teamStats.map((t) => `<div>${esc(t[0])}<small>${esc(t[1])}</small></div>`).join('')}</div>`) +
        (b.ranks.length ? pn('', 'Rankings', b.ranks.map((r) => `<div class="kv"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')) : '') +
        (b.staff.length ? pn('', ps ? 'Manager' : 'Coaching Staff', b.staff.map((r) => `<div class="kv"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')) : '') +
        '</div>' +
        (recap ? `<section class="pn rec"><div class="yr">${year}</div><div class="bd"><div class="lbl" style="color:var(--gold)">Latest story${recap.week ? ' · Week ' + esc(recap.week) : ''}</div><h2>${esc(recap.title)}</h2><p>${esc(recap.dek)}</p><a class="btn" href="#/d/${slug}/a/${recap.id}">Read story →</a></div></section>` : '') +
        pn('ros', `Team Roster (${b.roster.r.length})`, table(b.roster.h, b.roster.r.slice(0, 6).map((r) => tr(r, slug))), [`${base}roster`, 'View full roster']) +
        pn('sto', 'Key Storylines', seasonArticles.length ? seasonArticles.slice(0, 5).map((a) => `<a class="st" href="#/d/${slug}/a/${a.id}"><b>${a.week ? 'WK ' + esc(a.week) : esc(a.kind).toUpperCase()}</b><span>${esc(a.title)}</span></a>`).join('') : '<p class="empty" style="padding:6px 0">No stories for this season yet.</p>', [`${base}stories`, 'View all']) +
        '</div></main>';
    } else if (tab === 'schedule') {
      body = `<main>${pn('', `${year} Schedule &amp; Results`, schedTable(d, b.sched, slug) + `<p class="foot">${esc(b.record)} overall${b.conf ? ' · ' + esc(b.conf) + ' conference' : ''}</p>`)}</main>`;
    } else if (tab === 'roster') {
      body = `<main>${pn('', `Team Roster (${b.roster.r.length})`, table(b.roster.h, b.roster.r.map((r) => tr(r, slug))))}</main>`;
    } else if (tab === 'stats') {
      body = '<main>' + Object.keys(b.stats).map((k) => pn('', cap(k), table(b.stats[k].h, b.stats[k].r.map((r) => tr(r, slug)))) + '<div style="height:16px"></div>').join('') + '</main>';
    } else if (tab === 'stories') {
      body = `<main>${pn('', 'Stories', seasonArticles.length ? seasonArticles.map((a) => storyRow(Object.assign({ slug }, a), false)).join('') : '<p class="empty">No stories for this season yet. Add a markdown file to <code>content/' + slug + '/</code> and rebuild.</p>')}</main>`;
    }
    rootEl.innerHTML = hero + tabs + body;
    document.title = `${d.name}${hasData ? ' ' + year : ''} · Dynasty Archive`;

    const ss = document.getElementById('seasonsel');
    if (ss) ss.onchange = () => { location.hash = `#/d/${slug}/${ss.value}/${tab === 'players' ? 'overview' : tab}`; };
    const lead = document.getElementById('leaders');
    if (lead) lead.onclick = (e) => { const bt = e.target.closest('button[data-g]'); if (bt) lead.innerHTML = leadersPanel(b, slug, bt.dataset.g); };
    if (tab === 'players') playerSearch(document.getElementById('plmount'), slug, new URLSearchParams(location.hash.split('?')[1] || ''));
  }

  /* ---------- article ---------- */
  async function articleView(slug, id) {
    const d = dyn(slug);
    theme(d); drawChrome({ nav: 'dynasties', slug });
    const a = (await getJSON(`data/${slug}/articles.json`)).find((x) => x.id === id);
    if (!a) return rootEl.innerHTML = '<p class="empty">Story not found.</p>';
    const back = d.seasons.includes(a.season) ? `#/d/${slug}/${a.season}/stories` : `#/d/${slug}`;
    rootEl.innerHTML = `<article class="read"><a class="back" href="${back}">← ${esc(d.name)} stories</a><div><span class="chip">${esc(d.name)}</span><span class="lbl">${a.season || ''}${a.week ? ' · Week ' + esc(a.week) : ''}${a.date ? ' · ' + esc(a.date) : ''}</span></div><h1>${esc(a.title)}</h1>${markdown(a.body)}</article>`;
    document.title = `${a.title} · Dynasty Archive`;
    window.scrollTo(0, 0);
  }

  /* ---------- player search ---------- */
  async function playerSearch(mount, slug, q) {
    const slugs = DYN.filter((d) => d.players > 0).map((d) => d.slug);
    let cur = slug || q.get('d') || 'all';
    mount.innerHTML = `<div class="row"><input id="pq" type="search" placeholder="Search by name…" value="${esc(q.get('q') || '')}" aria-label="Player name">` +
      (slug ? '' : `<select id="pd"><option value="all">All dynasties</option>${slugs.map((s) => `<option value="${s}"${cur === s ? ' selected' : ''}>${esc(dyn(s).name)}</option>`).join('')}</select>`) +
      '</div><div id="pres"></div>';
    const input = mount.querySelector('#pq'), dd = mount.querySelector('#pd'), res = mount.querySelector('#pres');
    async function run() {
      const term = input.value.trim().toLowerCase();
      const which = slug ? [slug] : (dd.value === 'all' ? slugs : [dd.value]);
      if (term.length < 2) { res.innerHTML = '<p class="empty">Type at least two letters.</p>'; return; }
      const hits = [];
      for (const s of which) {
        const idx = await getJSON(`data/${s}/players/index.json`);
        for (const p of idx) { if (p[1].toLowerCase().includes(term)) hits.push([s, p]); if (hits.length > 400) break; }
      }
      hits.sort((a, b) => b[1][4] - a[1][4]);
      const shown = hits.slice(0, 100);
      res.innerHTML = shown.length ? pn('', `${hits.length > 100 ? 'First 100 of ' : ''}${hits.length} match${hits.length === 1 ? '' : 'es'}`,
        table(['Name', 'Pos', 'Active', 'Dynasty'], shown.map(([s, p]) => `<tr><td><a href="#/d/${s}/p/${p[0]}">${esc(p[1])}</a></td><td>${esc(p[2])}</td><td>${p[3] === p[4] ? p[3] : p[3] + '–' + p[4]}</td><td>${esc(dyn(s).name)}</td></tr>`))) : '<p class="empty">No players found.</p>';
    }
    let t; input.oninput = () => { clearTimeout(t); t = setTimeout(run, 150); };
    if (dd) dd.onchange = run;
    run();
  }
  function playersView() {
    theme(null); drawChrome({ nav: 'players' });
    rootEl.innerHTML = '<div class="page"><h2>Player search</h2><div id="plmount"></div></div>';
    playerSearch(document.getElementById('plmount'), null, new URLSearchParams(location.hash.split('?')[1] || ''));
    document.title = 'Players · Dynasty Archive';
  }

  /* ---------- player page ---------- */
  function sumTotals(cat, rows) {
    const t = {};
    cat.sum.forEach((k) => { t[k] = 0; });
    rows.forEach((r) => cat.sum.forEach((k) => { if (typeof r.o[k] === 'number') t[k] += r.o[k]; }));
    t.g = rows.reduce((a, r) => a + (r.games || 0), 0);
    return cat.derive ? Object.assign(t, DERIVE[cat.derive](t)) : t;
  }
  async function playerView(slug, id) {
    const d = dyn(slug);
    theme(d); drawChrome({ nav: 'players', slug });
    const sc = await getJSON(`data/${slug}/schema.json`);
    const shard = await getJSON(`data/${slug}/players/s${Math.floor(id / 250)}.json`);
    const p = shard[id];
    if (!p) return rootEl.innerHTML = '<p class="empty">Player not found.</p>';
    const start = sc.start_year;
    const rows = p.rows.map((r) => {
      const cat = sc.cats[r[4]];
      const o = {};
      cat.store.forEach((k, i) => { o[k] = r[6][i]; });
      if (cat.derive) Object.assign(o, DERIVE[cat.derive](o));
      return { year: r[0], team: sc.teams[r[1]] || '', level: r[2], po: r[3] === 1, cat: r[4], games: r[5], o };
    });
    // games per season = most games in any one category (regular season, top level)
    const per = {};
    rows.filter((r) => !r.po && r.level === 1 && r.games != null).forEach((r) => {
      per[r.year] = per[r.year] || {};
      per[r.year][r.cat] = (per[r.year][r.cat] || 0) + r.games;
    });
    let total = 0, pre = 0, since = 0;
    Object.keys(per).forEach((y) => {
      const g = Math.max.apply(null, Object.values(per[y]));
      total += g;
      if (start && +y < start) pre += g; else since += g;
    });
    const hasPre = pre > 0;
    const club = since >= 200 ? '200-game club' : since >= 100 ? '100-game club' : since >= 50 ? '50-game club' : '';
    const bio = p.bio || {};
    const bioTxt = [p.pos, bio.bats ? `Bats ${bio.bats} · Throws ${bio.throws || '?'}` : '', bio.dob ? 'Born ' + bio.dob : ''].filter(Boolean).map(esc).join(' · ');

    let html = `<div class="page"><a class="back" href="#/d/${slug}">← ${esc(d.name)}</a><div class="ph"><h1>${esc(p.n)}</h1><div class="lbl">${bioTxt}${club ? `<span class="club">${club}</span>` : ''}</div></div>`;
    html += '<div class="cards">' +
      `<div class="gold"><b>${total}</b><span>Career games</span></div>` +
      (hasPre ? `<div><b>${pre}</b><span>Before dynasty (${start})</span></div><div class="gold"><b>${since}</b><span>Since dynasty began</span></div>` : '') +
      `<div><b>${Object.keys(per).length}</b><span>Seasons</span></div></div>`;

    Object.keys(sc.cats).forEach((cname) => {
      const cat = sc.cats[cname];
      const cr = rows.filter((r) => r.cat === cname).sort((a, b) => a.year - b.year || a.po - b.po || a.level - b.level);
      if (!cr.length) return;
      const multiLevel = cr.some((r) => r.level !== 1), anyPo = cr.some((r) => r.po);
      const cols = cat.cols.some((c) => c[0] === 'g') ? cat.cols : [['g', 'G']].concat(cat.cols);
      const lead = ['Year', 'Team'].concat(multiLevel ? ['Lvl'] : []);
      const n = lead.length + cols.length;
      const out = [];
      let divDone = false;
      const line = (r) => {
        const base = [r.year + (r.po ? ' · PO' : ''), r.team].concat(multiLevel ? [r.level] : []);
        return base.map((c) => `<td>${esc(c)}</td>`).join('') + cols.map((c) => `<td>${fv(c[0], c[0] === 'g' && r.o.g === undefined ? r.games : r.o[c[0]])}</td>`).join('');
      };
      cr.forEach((r) => {
        const isSince = start && r.year >= start;
        if (hasPre && isSince && !divDone) { out.push(`<tr class="div"><td colspan="${n}">Dynasty begins · ${start}</td></tr>`); divDone = true; }
        out.push(`<tr${hasPre && isSince ? ' class="since"' : ''}>${line(r)}</tr>`);
      });
      const reg = cr.filter((r) => !r.po && r.level === 1);
      const totalRow = (label, set) => {
        if (!set.length) return;
        const t = sumTotals(cat, set);
        out.push(`<tr class="tot"><td colspan="${lead.length}">${label}</td>${cols.map((c) => `<td>${c[0] in t && (cat.sum.includes(c[0]) || c[0] === 'g' || (cat.derive && RATE3.has(c[0])) || c[0] === 'ip' || c[0] === 'era' || c[0] === 'whip') ? fv(c[0], t[c[0]]) : ''}</td>`).join('')}</tr>`);
      };
      totalRow('Career (regular season)', reg);
      if (hasPre && reg.some((r) => r.year >= start)) {
        totalRow('Before dynasty', reg.filter((r) => r.year < start));
        totalRow('Since dynasty began', reg.filter((r) => r.year >= start));
      }
      html += pn('', cat.label + (anyPo ? ' <span class="lbl">· PO = postseason</span>' : ''), `<div class="tw"><table class="t"><thead><tr>${lead.concat(cols.map((c) => c[1])).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${out.join('')}</tbody></table></div>`) + '<div style="height:16px"></div>';
    });
    if (!rows.length) html += '<p class="empty">No stats recorded for this player.</p>';
    if (bio.seasons) {
      html += pn('', 'Roster history', table(['Year', '#', 'Class', 'Ovr'], Object.keys(bio.seasons).sort().map((y) => `<tr><td>${y}</td><td>${esc(bio.seasons[y].j)}</td><td>${esc(bio.seasons[y].c)}</td><td>${esc(bio.seasons[y].o)}</td></tr>`)));
    }
    rootEl.innerHTML = html + '</div>';
    document.title = `${p.n} · ${d.name} · Dynasty Archive`;
    window.scrollTo(0, 0);
  }

  /* ---------- router ---------- */
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path] = h.split('?');
    const seg = path.split('/').filter(Boolean);
    try {
      if (!seg.length) await homeView();
      else if (seg[0] === 'dynasties') dynastiesView();
      else if (seg[0] === 'players') playersView();
      else if (seg[0] === 'admin') { theme(null); drawChrome({ nav: 'admin' }); document.title = 'Control Panel · Dynasty Archive'; await window.DAAdmin.render(rootEl); }
      else if (seg[0] === 'd' && seg[1]) {
        if (seg[2] === 'p') await playerView(seg[1], +seg[3]);
        else if (seg[2] === 'a') await articleView(seg[1], seg.slice(3).join('/'));
        else if (seg[2] === 'players') await dynastyView(seg[1], null, 'players');
        else if (/^\d{4}$/.test(seg[2] || '')) await dynastyView(seg[1], +seg[2], seg[3] || 'overview');
        else await dynastyView(seg[1], null, 'overview');
      } else await homeView();
      if (!/\/(p|a)\//.test(h)) window.scrollTo(0, 0);
    } catch (e) {
      console.error(e);
      rootEl.innerHTML = `<p class="empty">Something went wrong loading this page (${esc(e.message)}). If you just rebuilt the data, refresh.</p>`;
    }
  }

  document.getElementById('srchf').onsubmit = (e) => {
    e.preventDefault();
    location.hash = '#/players?q=' + encodeURIComponent(document.getElementById('srch').value);
  };
  window.addEventListener('hashchange', route);
  getJSON('data/dynasties.json').then((list) => { DYN = list; route(); })
    .catch((e) => { rootEl.innerHTML = `<p class="empty">Could not load data/dynasties.json (${esc(e.message)}). Run <code>python tools/build.py</code> first.</p>`; });
})();
