// Ramjet service worker - Scramjet v2 engine integration
// (@mercuryworkshop/scramjet-controller, MIT).
importScripts("/controller/controller.sw.js");

addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) {
		e.respondWith($scramjetController.route(e));
	}
});
