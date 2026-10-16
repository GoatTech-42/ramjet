// Single-source pacing/circuit breaker. Limits reduce risk, not a bot-wall guarantee.
export function createRequestBudget({ now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), budget = 24, gap = 3000, window = 600000, cooldown = 600000, state = {}, save = () => {} } = {}) {
  let last = Number(state.last) || 0, until = Number(state.until) || 0, chain = Promise.resolve();
  const stamps = Array.isArray(state.stamps) ? state.stamps.filter(Number.isFinite) : [];
  const trim = () => { while (stamps.length && now() - stamps[0] >= window) stamps.shift(); };
  const persist = () => save({ last, until, stamps: [...stamps] });
  return {
    left() { trim(); return Math.max(0, budget - stamps.length); },
    cooldown() { return Math.max(0, until - now()); },
    fail() { until = Math.max(until, now() + cooldown); persist(); },
    admit() {
      const run = chain.then(async () => {
        trim(); if (now() < until || stamps.length >= budget) return false;
        const wait = last + gap - now(); if (wait > 0) await sleep(wait);
        trim(); if (now() < until || stamps.length >= budget) return false;
        last = now(); stamps.push(last); persist(); return true;
      });
      chain = run.catch(() => {}); return run;
    },
  };
}
