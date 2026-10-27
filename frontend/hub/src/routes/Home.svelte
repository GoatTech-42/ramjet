<script>
  import Icon from '../lib/components/Icon.svelte'
  import { m10Invoke, m10BeginLocal, m10Feedback } from '../lib/m10.js'
  import { visibleVerbs } from '../lib/verbs.js'
  // real data only: sites browse recorded on this device (rj-browse-recent). empty = section hidden.
  let recents = []
  try {
    const a = JSON.parse(localStorage.getItem('rj-browse-recent') || '[]')
    recents = (Array.isArray(a) ? a : []).filter((r) => r && typeof r.name === 'string' && /^https?:\/\//i.test(r.url)).slice(0, 5)
  } catch {}
  // starred pages: real bookmarks from browse (the star in browse's menu). hidden when empty or the call fails.
  let starred = $state([])
  fetch('/api/apps/browse/bookmarks').then((r) => (r.ok ? r.json() : null)).then((d) => {
    const a = d && Array.isArray(d.bookmarks) ? d.bookmarks : []
    starred = a.filter((b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url)).slice(0, 8)
  }).catch(() => {})
  function openStar(e, url) {
    e.preventDefault()
    try { sessionStorage.setItem('rj-open', url) } catch {}
    location.assign('/browse')
  }
  let q = $state('')
  let paletteMarked = false
  function oninput(e) {
    if (paletteMarked) return
    paletteMarked = true
    m10Feedback(m10BeginLocal('palette', e))
  }
  function submit(e) {
    e.preventDefault()
    if (!q.trim()) return // validate destination first
    m10Invoke(e) // trusted submit event, before any proxy work
    try { sessionStorage.setItem('rj-open', q.trim()) } catch {}
    location.assign('/browse')
  }
</script>

<div class="shell">
  <div class="topbar">
    <span class="wm">ramjet</span>
    <a class="ticon pressable" data-testid="hub-settings-link" href="#/settings" aria-label="settings"><Icon name="settings" size={20} /></a>
  </div>
  <div class="homewrap">
    <div class="homecol">
      <p class="intro">this is your home. type a site or a search and go.</p>
      <form class="cmd" data-m10="palette" onsubmit={submit}>
        <Icon name="search" size={18} />
        <input data-testid="hub-command-bar" data-m10="omnibox" type="text" bind:value={q} oninput={oninput} placeholder="type a site or a search" aria-label="command bar" />
      </form>
      <div class="verbs">
        {#each visibleVerbs() as v, i}
          <a class="verb pressable" data-testid={"hub-verb-" + v.label} class:on={i === 0} href={v.target.hash ? `#/${v.target.hash}` : v.target.path}>{v.label}</a>
        {/each}
      </div>
      {#if starred.length}
        <div class="seclabel">starred</div>
        <div class="ledger">
          {#each starred as b (b.id ?? b.url)}
            <a class="row" data-testid={"hub-starred-" + (b.id ?? b.url)} href="/browse" onclick={(e) => openStar(e, b.url)}>
              <Icon name="globe" size={16} />
              <span class="rt">{b.name || b.url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}</span>
              <span class="ru">{b.url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}</span>
            </a>
          {/each}
        </div>
      {/if}
      {#if recents.length}
        <div class="seclabel">lately</div>
        <div class="ledger">
          {#each recents as r}
            <a class="row" data-testid={"hub-lately-" + r.url} href="/browse" onclick={(e) => { e.preventDefault(); try { sessionStorage.setItem('rj-open', r.url) } catch {} location.assign('/browse') }}>
              <Icon name="globe" size={16} />
              <span class="rt">{r.name}</span>
              <span class="ru">{r.url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}</span>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
