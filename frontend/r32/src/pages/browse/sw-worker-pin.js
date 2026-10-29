// a service worker update replaces the worker object the scramjet controller
// captured at connect time (new Controller({ serviceworker: sw, ... })). the
// vendored revive path re-registers with that captured object, so across an
// update the $controller$init goes to a dead (redundant) worker, the new
// worker's registry stays empty, and every proxied navigation fails until
// reload. pin the controller to the live worker of the SAME registration
// connect() used - never navigator.serviceWorker.controller (the page sits
// outside the /a/ scope, so that is null here) and never an event source.
export function pinControllerWorker(controller, reg) {
  const origSetup = controller.setupMessagePort.bind(controller);
  // reg is the live Registration object from connect()'s register() call; its
  // .active tracks the current worker. re-resolved at every use, and the
  // state is re-checked each time - an activating worker is not a target.
  const liveActive = () => {
    const w = reg && reg.active;
    return w && w.state === 'activated' ? w : null;
  };
  controller.setupMessagePort = function () {
    const w = liveActive();
    if (w) controller.serviceWorkerController = w;
    origSetup();
  };
  // the vendored revive listener ignores revives during its first-5s guard.
  // bypass it only for a verified worker replacement (the live worker differs
  // from the captured one); the same worker keeps the guard, and a stopped
  // same-version worker stays the right target (postMessage restarts it).
  // after the first bypass the captured field IS the live worker, so later
  // duplicate revives dedupe themselves against it - no port-reset storms.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || !e.data.$controller$swrevive) return;
    if (!controller.guardServiceWorkerRevive) return; // guard off: the vendored path handles it
    const w = liveActive();
    if (!w || w === controller.serviceWorkerController) return;
    controller.serviceWorkerController = w;
    origSetup();
  });
}
