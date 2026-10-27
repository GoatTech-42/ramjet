<script>
  import Icon from '../lib/components/Icon.svelte'
  import { Switch } from 'bits-ui'
  import { m10BeginLocal, m10Feedback } from '../lib/m10.js'
  import { applyCloak } from '../lib/cloak.js'
  // build-time identity (vite define): "v3 · <7-char source commit sha>"; production build fails without it
  const release = __RAMJET_RELEASE__
  // stamp row: the shell html carries the id it was built with; this bundle bakes its own. a cached
  // shell next to a newer bundle (or the reverse) shows the hard-refresh note instead of the date.
  const shellBuild = document.querySelector('meta[name="rj-build"]')?.getAttribute('content') || ''
  const stale = shellBuild !== __RAMJET_BUILD__
  let skin = $state(document.documentElement.dataset.skin === 'paper' ? 'paper' : 'dark')
  let reduceMotion = $state(false)
  try { reduceMotion = localStorage.getItem('rj-reduce-motion') === '1' } catch {}
  // the toggle is the only writer: persist it and apply live (App boot only reads it on load)
  $effect(() => { try { if (reduceMotion) { localStorage.setItem('rj-reduce-motion', '1'); document.documentElement.dataset.rm = '1' } else { localStorage.removeItem('rj-reduce-motion'); delete document.documentElement.dataset.rm } } catch {} })
  let cloakTabs = $state(true)
  try { cloakTabs = localStorage.getItem('rj-cloak') !== '0' } catch {} // same key + default as the r32 settings page
  $effect(() => { try { if (cloakTabs) localStorage.removeItem('rj-cloak'); else localStorage.setItem('rj-cloak', '0') } catch {} applyCloak() })
  // devices: pair/forget state machine matching the current product.
  // contract: lookup POST /api/devices/pair/lookup {code} -> {ok,name}; approve POST /api/devices/approve {code} -> {ok,device};
  // list GET /api/devices -> {devices:[{id,name,created,last_used}]}; revoke POST /api/devices/revoke {id}. 429 carries retry-after seconds.
  const DV = {
    empty: 'no devices yet.', never: 'never',
    localInvalid: 'enter the 8-character code from your tv.',
    checking: 'checking...',
    approveOk: 'approved. the tv should sign in in a moment.',
    cancel: 'cancelled.',
    expired: 'that code ran out of time.',
    unknown: "that code isn't valid anymore.",
    dead: 'that code was already used or replaced. press ok on the tv for a new one.',
    forbidden: "this device can't do that",
    notReady: "this part isn't ready yet.",
    offline: 'no connection. check your network.',
    generic: "that didn't work. try again.",
    forgotten: 'forgotten.'
  }
  const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
  const normCode = (v) => String(v ?? '').replace(/[- ]/g, '').toUpperCase()
  const fmtCode = (v) => v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4, 8) : v
  const validCode = (v) => v.length === 8 && [...v].every((c) => CODE_ALPHABET.includes(c))
  const coolCopy = (secs) => { const m = Math.max(1, Math.ceil((secs || 60) / 60)); return m === 1 ? 'slow down a bit. wait about a minute.' : `slow down a bit. wait about ${m} minutes.` }
  function mapErr(status, body, retryAfter) {
    if (status === 410) {
      const st = typeof body?.state === 'string' ? body.state : 'unknown'
      return { line: st === 'expired' ? DV.expired : (st === 'consumed' || st === 'superseded' || st === 'denied') ? DV.dead : DV.unknown }
    }
    if (status === 429) return { line: coolCopy(retryAfter), cooldown: retryAfter == null ? 60 : Math.max(1, retryAfter | 0) }
    if (status === 403) return { line: DV.forbidden }
    if (status === 501) return { line: DV.notReady }
    return { line: DV.generic }
  }
  async function dapi(path, opts = {}) {
    let res
    try { res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', 'x-ramjet-js': '1', ...(opts.headers || {}) } }) }
    catch { return { network: true } }
    const retryAfter = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10)
    let body = null
    try { body = await res.json() } catch {}
    return { status: res.status, body, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null }
  }
  const dv = {
    list: () => dapi('/api/devices'),
    lookup: (code) => dapi('/api/devices/pair/lookup', { method: 'POST', body: JSON.stringify({ code }) }),
    approve: (code) => dapi('/api/devices/approve', { method: 'POST', body: JSON.stringify({ code }) }),
    revoke: (id) => dapi('/api/devices/revoke', { method: 'POST', body: JSON.stringify({ id }) }),
    me: () => dapi('/api/auth/me'),
  }
  // pair box: idle -> checking -> preview -> pairing -> done, with a cooldown after 429s
  let pair = $state({ step: 'idle', code: '', name: null, line: '', lineKind: 'info', cooldownUntil: 0 })
  let pcode = $state('')
  const shown = $derived(fmtCode(normCode(pcode).slice(0, 8)))
  const inCool = () => pair.cooldownUntil > Date.now()
  function onCodeInput(e) {
    pcode = fmtCode(normCode(e.currentTarget.value).slice(0, 8))
    if (pair.step === 'preview' || pair.step === 'pairing' || pair.step === 'done') pair = { step: 'idle', code: '', name: null, line: '', lineKind: 'info', cooldownUntil: pair.cooldownUntil }
    else if (pair.line && !inCool()) pair = { ...pair, line: '' }
  }
  async function lookup(e) {
    e?.preventDefault()
    if (pair.step === 'checking') return
    if (inCool()) { pair = { ...pair, step: 'idle', line: pair.line, lineKind: 'info' }; return }
    if (!validCode(normCode(pcode).slice(0, 8))) { pair = { ...pair, step: 'idle', line: DV.localInvalid, lineKind: 'info' }; return }
    pair = { ...pair, step: 'checking', code: normCode(pcode).slice(0, 8), line: '' }
    const r = await dv.lookup(pair.code)
    if (r.network) { pair = { ...pair, step: 'idle', line: DV.offline, lineKind: 'err' }; return }
    if (r.status === 200 && r.body?.ok && typeof r.body.name === 'string') { pair = { ...pair, step: 'preview', name: r.body.name, line: '', lineKind: 'info' }; return }
    const m = mapErr(r.status, r.body, r.retryAfter)
    pair = { ...pair, step: 'idle', line: m.line, lineKind: m.cooldown ? 'info' : 'err', cooldownUntil: m.cooldown ? Date.now() + m.cooldown * 1000 : pair.cooldownUntil }
  }
  async function approve() {
    if (!(pair.step === 'preview' && pair.code === normCode(pcode).slice(0, 8))) { pair = { ...pair, step: 'idle', name: null }; return }
    pair = { ...pair, step: 'pairing' }
    const r = await dv.approve(pair.code)
    if (r.network) { pair = { ...pair, step: 'preview', line: DV.offline, lineKind: 'err' }; return }
    if (r.status === 200 && r.body?.ok && r.body.device) {
      pair = { step: 'done', code: '', name: null, line: DV.approveOk, lineKind: 'info', cooldownUntil: 0 }
      pcode = ''
      loadDevices()
      return
    }
    const m = mapErr(r.status, r.body, r.retryAfter)
    pair = { ...pair, step: 'idle', name: null, line: m.line, lineKind: m.cooldown ? 'info' : 'err', cooldownUntil: m.cooldown ? Date.now() + m.cooldown * 1000 : pair.cooldownUntil }
  }
  function cancelPair() { pair = { step: 'idle', code: '', name: null, line: DV.cancel, lineKind: 'info', cooldownUntil: pair.cooldownUntil } }
  // list + forget (two-step confirm per row)
  let devices = $state(null); let devLine = $state(''); let devLineKind = $state('info')
  let confirmForget = $state(null)
  async function loadDevices() {
    const r = await dv.list()
    if (r.status === 200 && r.body?.ok && Array.isArray(r.body.devices)) { devices = r.body.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, last_used: d.last_used ?? null })); devLine = ''; return }
    if (r.network) { devLine = DV.offline; devLineKind = 'err'; devices = null; return }
    const m = mapErr(r.status, r.body, r.retryAfter)
    devLine = m.line; devLineKind = m.cooldown ? 'info' : 'err'; devices = null
  }
  loadDevices()
  async function forget(d) {
    confirmForget = null
    const r = await dv.revoke(d.id)
    if (r.network) { pair = { ...pair, line: DV.offline, lineKind: 'err' }; return }
    if (r.status === 200) { devices = (devices || []).filter((x) => x.id !== d.id); pair = { ...pair, line: DV.forgotten, lineKind: 'info' }; return }
    if (r.status === 404) { loadDevices(); return }
    pair = { ...pair, line: mapErr(r.status, r.body, r.retryAfter).line, lineKind: 'err' }
  }
  const ago = (ms) => {
    if (ms == null) return DV.never
    const s = Math.max(0, Math.floor((clock - ms) / 1000))
    if (s < 60) return 'just now'
    const m = Math.floor(s / 60); if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`
    const h = Math.floor(m / 60); if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`
    const d = Math.floor(h / 24)
    return d < 30 ? `${d} ${d === 1 ? 'day' : 'days'} ago` : new Date(ms).toISOString().slice(0, 10)
  }
  // signed-in-as line (account section); 30s clock keeps the "last used" ages and cooldown fresh
  let meName = $state('')
  let clock = $state(Date.now())
  $effect(() => {
    dv.me().then((r) => { if (r.status === 200 && r.body?.ok && typeof r.body.user === 'string') meName = r.body.user })
    const t = setInterval(() => { clock = Date.now() }, 30000)
    return () => clearInterval(t)
  })
  $effect(() => {
    if (pair.cooldownUntil > Date.now()) {
      const t = setTimeout(() => { clock = Date.now() }, pair.cooldownUntil - Date.now() + 50)
      return () => clearTimeout(t)
    }
  })
  function mark(e) { m10Feedback(m10BeginLocal('settings', e)) }
  function pickSkin(s, e) {
    mark(e)
    skin = s
    document.documentElement.dataset.skin = s === 'paper' ? 'paper' : 'dark'
    try { localStorage.setItem('rj-skin', s === 'paper' ? 'paper' : 'dark') } catch {} // kept pages read this (theme-boot.js)
    try { const K = s === 'paper' ? 'paper' : 'dark'; document.cookie = 'rj_skin=' + K + '; path=/; max-age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '') } catch {} // server-rendered search/reader pages read this cookie
  }
  // radio-group pattern: one tab stop (the checked one), arrows move and select
  function skinKey(e) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = skin === 'dark' ? 'paper' : 'dark'
    pickSkin(next, e)
    queueMicrotask(() => document.querySelector(`[data-testid="skin-${next}"]`)?.focus())
  }
</script>

<div class="shell">
  <div class="topbar settop">
    <div class="topmid">
      <a class="backbtn pressable" data-testid="settings-back" href="#/home" aria-label="back"><Icon name="back" size={20} /></a>
      <span class="wm">ramjet</span>
    </div>
  </div>
  <div class="setwrap">
    <div class="setcol">
      <h1>settings</h1>

      <section><h2>appearance</h2>
      <p class="expl">one look, two skins. everything themed, nothing hidden in apps.</p>
      <div class="srow">
        <span class="sl">skin</span>
        <span class="skinpick" role="radiogroup" aria-label="skin" onkeydown={skinKey}>
          <button data-testid="skin-dark" role="radio" aria-checked={skin === 'dark'} tabindex={skin === 'dark' ? 0 : -1} class:on={skin === 'dark'} onclick={(e) => pickSkin('dark', e)}>dark</button>
          <button data-testid="skin-paper" role="radio" aria-checked={skin === 'paper'} tabindex={skin === 'paper' ? 0 : -1} class:on={skin === 'paper'} onclick={(e) => pickSkin('paper', e)}>paper</button>
        </span>
      </div>
      <div class="srow">
        <span class="sl">reduce motion</span>
        <Switch.Root bind:checked={reduceMotion} class="tg" data-testid="toggle-reduce-motion" data-m10="settings" onclick={mark} aria-label="reduce motion"><Switch.Thumb class="knob" /></Switch.Root>
      </div>

      </section><section><h2>account</h2>
      <p class="expl acct">your stuff stays on your box. the server can read it while you use it.</p>
      {#if meName}<p class="expl">signed in as {meName}.</p>{/if}

      </section><section data-testid="devices"><h2>devices</h2>
      {#if devices === null}
        {#if devLine}<div data-testid="devices-line" class="dvline" class:err={devLineKind === 'err'}>{devLine}</div>{/if}
      {:else if devices.length === 0}
        <div class="srow"><span class="sv" data-testid="devices-empty">{DV.empty}</span></div>
      {:else}
        {#each devices as d (d.id)}
          <div class="srow" data-testid="device-row">
            <span class="sl">{d.name}</span>
            {#if confirmForget === d.id}
              <span class="dvact"><span class="sv">forget this device?</span> <button class="dvbtn danger" data-testid="device-confirm-forget" onclick={() => forget(d)}>forget</button> <button class="dvbtn" data-testid="device-confirm-keep" onclick={() => { confirmForget = null }}>keep</button></span>
            {:else}
              <span class="dvact"><span class="sv m">created {ago(d.created)} · last used {ago(d.last_used)}</span> <button class="dvbtn" data-testid="device-forget" onclick={() => { confirmForget = d.id }}>forget</button></span>
            {/if}
          </div>
        {/each}
      {/if}
      <p class="expl">pair a tv with the code on its screen. forgetting one signs it out.</p>
      {#if pair.step === 'preview' || pair.step === 'pairing'}
        <div class="srow" data-testid="pair-preview">
          <span class="sl">pair '{pair.name ?? ''}'?</span>
          <span class="dvact"><button class="dvbtn primary" data-testid="pair-approve" disabled={pair.step === 'pairing'} onclick={approve}>{pair.step === 'pairing' ? 'pairing...' : 'pair'}</button> <button class="dvbtn" data-testid="pair-cancel" disabled={pair.step === 'pairing'} onclick={cancelPair}>cancel</button></span>
        </div>
      {:else}
        <form class="srow" data-testid="pair-form" onsubmit={lookup}>
          <span class="sl">pair a device</span>
          <span class="dvact"><span class="dvpair"><input data-testid="pair-code" value={shown} oninput={onCodeInput} placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" aria-label="pair a device" disabled={inCool()} /></span> <button type="submit" class="dvbtn primary" data-testid="pair-submit" disabled={inCool() || pair.step === 'checking'}>{pair.step === 'checking' ? DV.checking : 'check the code'}</button></span>
        </form>
      {/if}
      {#if pair.line}<div data-testid="pair-line" class="dvline" class:err={pair.lineKind === 'err'}>{pair.line}</div>{/if}

      </section><section><h2>advanced</h2>
      <div class="srow">
        <span class="sl">connection</span>
        <span class="sv m">websocket</span>
      </div>
      <div class="srow">
        <span class="sl">version</span>
        <span class="sv m">{stale ? 'new build - if anything looks stale, hard-refresh once' : `${release} · ${__RAMJET_DATE__}`}</span>
      </div>
      {#if __RAMJET_SOURCE_URL__}
      <div class="srow">
        <span class="sl">source code</span>
        <span class="sv m"><a data-testid="source-offer" href={__RAMJET_SOURCE_URL__} rel="noopener">corresponding source</a></span>
      </div>
      {/if}
      <div class="srow">
        <span class="sl">look like docs</span>
        <Switch.Root bind:checked={cloakTabs} class="tg" data-testid="toggle-look-like-docs" data-m10="settings" onclick={mark} aria-label="look like docs"><Switch.Thumb class="knob" /></Switch.Root>
      </div>
    </section>
    </div>
  </div>
</div>
