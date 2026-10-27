<script>
  import Home from './routes/Home.svelte'
  import Settings from './routes/Settings.svelte'
  import NotFound from './routes/NotFound.svelte'
  import { initM10 } from './lib/m10.js'

  // route table: fixed shell routes only. Every verb is a real server page today
  // (path targets) - a future hash target would need its view registered here.
  const routes = { home: Home, settings: Settings, notfound: NotFound }
  let route = $state('home')

  // SPA boot: pathname -> view (the shell html is emitted byte-identical at
  // pages/{index,settings}/<name>.html; the server also maps the pretty paths
  // / and /settings). An in-app hash route wins when present.
  // /browse and /jetstream are r32's real app pages again - the shell neither
  // serves nor renders them.
  const pathView = (p) => {
    if (/(^|\/)settings(\.html)?$/.test(p)) return 'settings'
    return 'home'
  }
  function sync() {
    const h = location.hash.replace(/^#\/?/, '')
    const legacy = { browse: '/browse', watch: '/jetstream' }
    if (Object.hasOwn(legacy, h)) { location.replace(legacy[h]); return } // legacy hub hashes land on the real pages; own keys only so prototype names fall through
    route = h === '' ? pathView(location.pathname) : Object.hasOwn(routes, h) ? h : 'notfound'
    const qp = new URLSearchParams(location.search).get('skin')
    let stored = null
    try { stored = localStorage.getItem('rj-skin') } catch {}
    const skin = qp || stored // explicit ?skin= preview param still wins
    document.documentElement.dataset.skin = skin === 'paper' ? 'paper' : 'dark'
    if (stored === 'paper' || stored === 'dark') { try { const K = stored; document.cookie = 'rj_skin=' + K + '; path=/; max-age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '') } catch {} } // mirror the saved skin (not a ?skin= preview) for server-rendered pages
    try { if (localStorage.getItem('rj-reduce-motion') === '1') document.documentElement.dataset.reduceMotion = '1'; else delete document.documentElement.dataset.reduceMotion } catch {}
  }
  $effect(() => {
    initM10()
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  })
  const Page = $derived(routes[route])
</script>

<Page />
