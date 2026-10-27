// one manifest: the home verb cards are generated from this list.
// target.hash -> in-app route (needs its view registered in App.svelte);
// target.path -> real server page (full navigation, leaves the shell).
// no save verb: its only real surface is browse itself (star a page there),
// which go already opens - re-add when a distinct save surface exists.
export const VERBS = [
  { verb: 'go', label: 'go', target: { path: '/browse' } },
  { verb: 'watch', label: 'watch', target: { path: '/jetstream' } },
  { verb: 'listen', label: 'listen', target: { path: '/amp' } },
  { verb: 'ask', label: 'ask', target: { path: '/sage' } },
]
export const visibleVerbs = () => VERBS
