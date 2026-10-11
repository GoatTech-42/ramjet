// One fresh=1 pull at a time. openFeed and the last-slide pull used to race
// each other (and a 500ms timer); callers now share the in-flight request.
export function createFreshGate(pull) {
  let inflight = null, gen = 0;
  return {
    get() { if (!inflight) { const g = gen; inflight = Promise.resolve().then(pull).finally(() => { if (g === gen) inflight = null; }); } return inflight; },
    cancel() { gen++; inflight = null; },
  };
}

// Intent generation: anything that invalidates a pending open or a late response
// (close, navigation, list swap, a newer open) calls bump(). A caller captures
// begin() before awaiting and checks ok(g) after.
export function createIntent() {
  let g = 0;
  return { begin() { return ++g; }, bump() { g++; }, cur() { return g; }, ok(x) { return x === g; } };
}
