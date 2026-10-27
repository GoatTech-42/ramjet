<script>
  // flick v1.1, legal-only: metadata, continue-watching, internet archive + youtube free.
  // built to the lead's C10c shapes. container keys for trending/search/meta are not spelled out, so those
  // reads accept {items}|{metas}|{results} and {meta}|bare - one place to fix: rows()/metaOf().
  // internet archive plays through archive.org/embed/<identifier> (direct, benign host) and has no
  // ia-files (GET ?identifier= -> {files:[{name,format,size,url}]}) gives direct files: video + download (IA only). youtube entries are listed but not played: no direct youtube
  // connection from the browser (banned host); they play later via the same-origin jetstream stream. progress is not tracked: embeds report no position.
  import '../../tokens.css';
  import { api, errCopy } from '../../lib/api.js';
  import { subscribe } from '../../lib/classc.js';
  let net = $state({ filtered: false });
  $effect(() => subscribe((v) => { net = v; }));

  const poster = (u) => (u ? `/api/apps/flick/img?u=${encodeURIComponent(u)}` : '');
  const rows = (d) => (d && (d.items || d.metas || d.results)) || [];
  const metaOf = (d) => (d && (d.meta || (d.id ? d : null))) || null;
  let view = $state('home'); // home | search | detail | watch
  let q = $state('');
  let kind = $state('movie');
  let trending = $state([]); let tState = $state('loading'); // loading | ok | empty | err
  let cont = $state([]);
  let results = $state([]); let sState = $state('');
  let meta = $state(null); let dErr = $state('');
  let legal = $state(null); let lState = $state(''); let legalErr = $state(''); // '' | loading | ok | err
  let season = $state(1);
  let iaFiles = $state({}); // identifier -> {state:'loading'|'ok'|'err', files:[]}
  let play = $state(null); // {src, ep}
  let cut = $state(false);
  
  async function loadTrending() {
    tState = 'loading';
    const r = await api(`/api/apps/flick/trending?type=${kind}`);
    if (!r.ok) { tState = 'err'; trending = []; return; }
    trending = rows(r.data);
    tState = trending.length ? 'ok' : 'empty';
  }
  async function loadCont() {
    const r = await api('/api/apps/flick/watch');
    cont = r.ok ? (r.data?.items || []) : [];
  }
  $effect(() => { kind; loadTrending(); });
  loadCont();

  async function search() {
    const t = q.trim();
    if (!t) { view = 'home'; return; }
    view = 'search'; sState = 'loading'; results = [];
    const r = await api(`/api/apps/flick/search?q=${encodeURIComponent(t)}`);
    if (!r.ok) { sState = 'err'; return; }
    results = rows(r.data);
    sState = results.length ? 'ok' : 'empty';
  }
  async function open(it) {
    view = 'detail'; meta = null; dErr = ''; legal = null; lState = 'loading'; play = null; season = 1;
    window.scrollTo(0, 0);
    const type = it.type || kind;
    const m = await api(`/api/apps/flick/meta?type=${type}&id=${encodeURIComponent(it.id)}`);
    if (!m.ok || !metaOf(m.data)) { dErr = errCopy(m, "this title couldn't load."); return; }
    meta = metaOf(m.data);
    const yr = /^\d{4}/.exec(String(meta.year || ''))?.[0];
    const l = await api(`/api/apps/flick/legal?q=${encodeURIComponent(meta.name)}${yr ? '&year=' + yr : ''}`);
    if (l.ok) { legal = l.data; lState = 'ok'; } else { lState = 'err'; legalErr = errCopy(l, ''); }
  }
  const sources = $derived(legal?.items || []);
  const playable = $derived(sources.find((x) => x.source === 'internet-archive') || null);
  const skey = (x) => x.source + (x.identifier || x.id);
  const seasons = $derived(meta?.videos ? [...new Set(meta.videos.map((v) => v.season).filter((s) => s > 0))].sort((a, b) => a - b) : []);
  const episodes = $derived((meta?.videos || []).filter((v) => v.season === season).sort((a, b) => a.episode - b.episode));
  const resume = $derived(meta ? cont.find((c) => c.id === meta.id) : null);

  async function loadFiles(id) {
    if (iaFiles[id]) return;
    iaFiles[id] = { state: 'loading', files: [] };
    const r = await api(`/api/apps/flick/ia-files?identifier=${encodeURIComponent(id)}`);
    iaFiles[id] = r.ok ? { state: 'ok', files: r.data?.files || [] } : { state: 'err', files: [], msg: errCopy(r, '') };
  }
  $effect(() => { for (const s of sources) if (s.source === 'internet-archive') loadFiles(s.identifier); });
  const filesOf = (s) => (s?.source === 'internet-archive' ? iaFiles[s.identifier]?.files || [] : []);
  const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' gb' : n > 1e6 ? Math.round(n / 1e6) + ' mb' : n ? Math.round(n / 1e3) + ' kb' : '');
  // series: file list rows are matched to episodes by sxxexx / NxNN in the file name, else by order
  function fileForEp(s, ep) {
    const fs = filesOf(s); if (!fs.length || !ep) return null;
    const a = new RegExp(`s0*${ep.season}[ ._-]?e0*${ep.episode}(?!\\d)`, 'i'), b = new RegExp(`(^|[^\\d])${ep.season}x0*${ep.episode}(?!\\d)`, 'i');
    return fs.find((f) => a.test(f.name) || b.test(f.name)) || null;
  }
  function watch(src, ep) { play = { src, ep }; cut = false; view = 'watch'; window.scrollTo(0, 0); saveWatch(ep); }
  const srcName = (s) => (s.source === 'internet-archive' ? 'internet archive - public domain' : 'youtube free');
  function saveWatch(ep) {
    if (!meta || !/^tt\d{9,10}$/.test(meta.id)) return;
    api('/api/apps/flick/watch', { method: 'POST', body: { id: meta.id, type: meta.type || kind, title: meta.name, poster: meta.poster || undefined, season: ep?.season, episode: ep?.episode } });
  }
  function back() {
    if (view === 'watch') view = 'detail';
    else if (view === 'detail') view = results.length && q.trim() ? 'search' : 'home';
    else { view = 'home'; q = ''; }
    if (view === 'home') loadCont();
  }
</script>

<div class="shell">
  <header>
    <a class="home" href="/" aria-label="back to ramjet">ramjet</a>
    <button class="wm" onclick={() => { view = 'home'; q = ''; }}>flick</button>
    <form onsubmit={(e) => { e.preventDefault(); search(); }}>
      <input bind:value={q} placeholder="find something to watch" aria-label="search" />
    </form>
  </header>

  {#if view !== 'home'}<button class="back" onclick={back} aria-label="back">&larr; back</button>{/if}

  {#if view === 'home'}
    <p class="tag">things you can watch for free, legally - no accounts, no ads from us.</p>
    {#if cont.length}
      <h2>continue watching</h2>
      <div class="rail">
        {#each cont as c (c.key || c.id)}
          <button class="card" onclick={() => open(c)}>
            <img src={poster(c.poster)} alt="" loading="lazy" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            <span class="t">{c.title}{#if c.season} · s{c.season}e{c.episode}{/if}</span>
          </button>
        {/each}
      </div>
    {/if}
    <h2>trending today</h2>
    <div class="seg"><button class:on={kind === 'movie'} onclick={() => (kind = 'movie')}>movies</button><button class:on={kind === 'series'} onclick={() => (kind = 'series')}>series</button></div>
    {#if tState === 'loading'}<p class="dim">loading</p>
    {:else if tState === 'err'}<p class="dim">trending isn't available right now.</p>
    {:else if tState === 'empty'}<p class="dim">nothing trending right now</p>
    {:else}
      <div class="grid">
        {#each trending as it (it.id)}
          <button class="card" onclick={() => open(it)}>
            <img src={poster(it.poster)} alt="" loading="lazy" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            <span class="t">{it.name}{#if it.year} · {it.year}{/if}</span>
          </button>
        {/each}
      </div>
      <p class="dim small">trending shows what people are watching anywhere. open one to see if there is a free, legal copy.</p>
    {/if}

  {:else if view === 'search'}
    {#if sState === 'loading'}<p class="dim">loading</p>
    {:else if sState === 'err'}<p class="dim">search isn't available right now.</p>
    {:else if sState === 'empty'}<p class="dim">nothing for "{q.trim()}". try fewer words.</p>
    {:else}
      <div class="grid">
        {#each results as it (it.id)}
          <button class="card" onclick={() => open(it)}>
            <img src={poster(it.poster)} alt="" loading="lazy" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            <span class="t">{it.name}{#if it.year} · {it.year}{/if}</span>
          </button>
        {/each}
      </div>
    {/if}

  {:else if view === 'detail'}
    {#if dErr}<p class="error">{dErr}</p>
    {:else if !meta}<p class="dim">loading</p>
    {:else}
      <div class="detail">
        <img class="poster" src={poster(meta.poster)} alt="" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
        <div class="info">
          <h1>{meta.name}</h1>
          <p class="dim">{[meta.year, meta.runtime, meta.rating ? meta.rating + ' on imdb' : ''].filter(Boolean).join(' · ')}</p>
          {#if meta.description}<p class="ov">{meta.description}</p>{/if}
          {#if meta.genres?.length}<p class="dim small">{meta.genres.join(' · ')}</p>{/if}

          <h3>where to watch</h3>
          {#if lState === 'loading'}<p class="dim">loading</p>
          {:else if lState === 'err'}<p class="dim">{legalErr || "watching options couldn't load."}</p>
          {:else}
            {#if legal?.archive_down}<p class="dim small">internet archive couldn't be checked.</p>{/if}
            {#if legal?.youtube_down}<p class="dim small">youtube couldn't be checked.</p>{/if}
            {#if !sources.length}<p class="dim">no watching options found.</p>{/if}
            {#each sources as s (skey(s))}
              <div class="src">
                <span class="sn">{s.title}{#if s.year} · {s.year}{/if}<span class="dim small"> - {srcName(s)}{#if s.channel} · {s.channel}{/if}</span></span>
                {#if s.source !== 'internet-archive'}
                  <span class="dim small">{net.filtered ? 'not playable on this network' : 'plays at home for now, school blocks youtube'}</span>
                {:else if !meta.videos?.length}
                  <button class="go" onclick={() => watch(s, null)}>watch</button>
                  {#each filesOf(s).slice(0, 1) as f}<a class="dl" href={f.url} download>download{fmtSize(f.size) ? ' · ' + fmtSize(f.size) : ''}</a>{/each}
                {/if}
              </div>
            {/each}
          {/if}

          {#if meta.videos?.length}
            {#if seasons.length > 1}<div class="seg">{#each seasons as n}<button class:on={season === n} onclick={() => (season = n)}>season {n}</button>{/each}</div>{/if}
            {#if resume}<p class="dim small">you stopped at s{resume.season}e{resume.episode}</p>{/if}
            <div class="eps">
              {#each episodes as ep (ep.id || ep.episode)}
                <div class="ep">
                  <span class="en">{ep.episode}. {ep.title || ep.name || 'episode ' + ep.episode}</span>
                  {#if playable && fileForEp(playable, ep)}
                    <button class="go" onclick={() => watch(playable, ep)}>watch</button>
                    <a class="dl" href={fileForEp(playable, ep).url} download>download</a>
                  {:else if playable && iaFiles[playable.identifier]?.state === 'loading'}<span class="dim small">loading</span>
                  {:else if playable}<span class="dim small">not in this archive item</span>{/if}
                </div>
              {/each}
            </div>
            {#if playable}<p class="dim small">episodes are matched to files in the first internet archive item above.</p>{:else if sources.length}<p class="dim small">no playable copy found.</p>{/if}
          {/if}
        </div>
      </div>
    {/if}

  {:else if view === 'watch' && play}
    <h1 class="wt">{meta?.name}{#if play.ep} · s{play.ep.season}e{play.ep.episode}{/if}</h1>
    {#if cut}
      <p class="error">the video stopped playing.</p>
      <button class="go" onclick={() => { cut = false; }}>try again</button>
    {:else if play.src.source === 'internet-archive'}
      {@const pf = play.ep ? fileForEp(play.src, play.ep) : filesOf(play.src)[0]}
      {#if pf}
        <video controls playsinline src={pf.url} onerror={() => (cut = true)}></video>
        <a class="dl" href={pf.url} download>download</a>
      {:else}
        <iframe title="internet archive" src={`https://archive.org/embed/${encodeURIComponent(play.src.identifier)}`} allowfullscreen></iframe>
      {/if}
    {/if}
    <div class="pills">
      {#each sources.filter((x) => x.source === 'internet-archive') as s (skey(s))}<button class:on={s === play.src} onclick={() => watch(s, play.ep)}>{srcName(s)}</button>{/each}
    </div>
  {/if}
</div>

<style>
  .shell { max-width: 1100px; margin: 0 auto; padding: 16px 18px 60px; color: var(--rj-text); font-family: var(--rj-font, system-ui); text-transform: none; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
  .home { color: var(--rj-text-faint); text-decoration: none; font-size: 13px; }
  .wm { background: none; border: 0; color: inherit; font-size: 20px; font-weight: 600; cursor: pointer; padding: 0; }
  form { flex: 1; min-width: 200px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--rj-border, #333); background: transparent; color: inherit; font: inherit; }
  h2 { font-size: 15px; margin: 22px 0 8px; font-weight: 600; }
  h3 { font-size: 13px; margin: 18px 0 6px; font-weight: 600; color: var(--rj-text-faint); }
  .tag, .dim { color: var(--rj-text-faint); font-size: 14px; }
  .small { font-size: 12.5px; }
  .error { color: var(--rj-text-dim); font-size: 14px; }
  .back { background: none; border: 0; color: var(--rj-text-faint); cursor: pointer; padding: 4px 0 10px; font: inherit; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; }
  .rail { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 6px; }
  .rail .card { flex: 0 0 140px; }
  .card { background: none; border: 0; color: inherit; text-align: left; cursor: pointer; padding: 0; font: inherit; position: relative; }
  .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; border-radius: 8px; background: var(--rj-surface, #1a1a1a); display: block; }
  .t { display: block; font-size: 13px; margin-top: 6px; }
  .bar { display: block; height: 3px; background: var(--rj-border, #333); margin-top: 4px; border-radius: 2px; }
  .bar i { display: block; height: 100%; background: var(--rj-text); border-radius: 2px; }
  .seg, .pills { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 12px; }
  .seg button, .pills button { background: none; border: 1px solid var(--rj-border, #333); color: inherit; padding: 5px 12px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 13px; }
  .seg .on, .pills .on { border-color: var(--rj-text); }
  .detail { display: flex; gap: 22px; align-items: flex-start; }
  .poster { width: 220px; aspect-ratio: 2/3; object-fit: cover; border-radius: 10px; background: var(--rj-surface, #1a1a1a); flex: none; }
  .info { flex: 1; min-width: 0; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .ov { font-size: 14.5px; line-height: 1.5; }
  .src, .ep { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--rj-border, #2a2a2a); }
  .sn, .en { flex: 1; font-size: 14px; }
  .go, .dl { background: none; border: 1px solid var(--rj-border, #444); color: inherit; padding: 5px 14px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; text-decoration: none; }
  video, iframe { width: 100%; aspect-ratio: 16/9; border: 0; background: #000; border-radius: 10px; display: block; margin-bottom: 10px; }
  .wt { font-size: 18px; }
  @media (max-width: 640px) { .detail { flex-direction: column; } .poster { width: 150px; } .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); } }
</style>
