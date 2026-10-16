// Google CSE throttles this box's IP (429 "unusual traffic") if it is hit too fast.
// Every image search that touches searxng goes through here: calls are serialized with
// a minimum gap, and extra pages (2-5) are skipped when the recent budget is spent.
let last = 0, chain = Promise.resolve();
const stamps = [];
const GAP = 3000, BUDGET = 24, WINDOW = 10 * 60 * 1000;
export function cseBudgetLeft() {
	const now = Date.now(); while (stamps.length && now - stamps[0] > WINDOW) stamps.shift();
	return BUDGET - stamps.length;
}
export function cseGate() {
	const run = chain.then(async () => {
		const wait = last + GAP - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		last = Date.now(); stamps.push(last);
	});
	chain = run.catch(() => {});
	return run;
}
