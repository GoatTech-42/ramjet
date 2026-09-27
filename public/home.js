// ramjet home - a real new-tab page. clock + greeting, search front and center,
// quick links from your bookmarks, mini jetstream trending, addon tiles.
(function () {
	const $ = (id) => document.getElementById(id);

	// -- clock + greeting -------------------------------------------------------
	function greeting(h) {
		if (h < 5) return "up late";
		if (h < 12) return "good morning";
		if (h < 17) return "good afternoon";
		if (h < 22) return "good evening";
		return "good night";
	}
	let who = "";
	fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then((d) => {
		who = (d && (d.user || d.username)) || "";
		tick();
	}).catch(() => {});
	function tick() {
		const now = new Date();
		const clock = $("ntClock"), date = $("ntDate"), greet = $("ntGreet");
		if (!clock) return;
		let h = now.getHours();
		const ampm = h >= 12 ? "pm" : "am";
		h = h % 12 || 12;
		clock.textContent = h + ":" + String(now.getMinutes()).padStart(2, "0");
		const ap = $("ntAmPm");
		if (ap) ap.textContent = ampm;
		if (date) date.textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
		if (greet) greet.textContent = greeting(now.getHours()) + (who ? ", " + who : "");
	}
	tick();
	setInterval(tick, 5000);

	// -- search: one path - hand it to the real bar ------------------------------
	function ignite(url) {
		const bar = $("w37dc41");
		const form = $("w894381");
		if (!bar || !form) return;
		bar.value = url;
		form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
	}
	const sf = $("ntSearch");
	if (sf) sf.addEventListener("submit", (e) => {
		e.preventDefault();
		const q = $("ntQ").value.trim();
		if (q) ignite(q);
	});

	// -- quick links from bookmarks ----------------------------------------------
	function hostOf(u) {
		try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
	}
	try {
		const bms = JSON.parse(localStorage.getItem("rj.bookmarks") || "[]").slice(0, 8);
		const box = $("ntLinks");
		if (box && bms.length) {
			for (const b of bms) {
				const host = hostOf(b.url);
				if (!host) continue;
				const a = document.createElement("a");
				a.className = "nt-link";
				a.href = b.url;
				a.innerHTML = '<span class="nt-letter">' + host[0].toUpperCase() + "</span><span class=\"nt-host\">" + host + "</span>";
				a.addEventListener("click", (e) => { e.preventDefault(); ignite(b.url); });
				box.appendChild(a);
			}
			box.hidden = false;
		}
	} catch (e) {}

	// -- mini jetstream trending ---------------------------------------------------
	let lowData = false;
	try { lowData = !!(JSON.parse(localStorage.getItem("rj.settings") || "{}").lowData); } catch (e) {}
	if (!lowData) {
		fetch("/api/jetstream/trending").then((r) => (r.ok ? r.json() : null)).then((d) => {
			const all = (d && d.items) || [];
			const nonlive = all.filter((x) => !x.live);
			const items = (nonlive.length ? nonlive : all).slice(0, 4);
			const w = $("ntTrendWrap"), grid = $("ntTrend");
			if (!w || !grid || !items.length) return;
			for (const it of items) {
				const a = document.createElement("a");
				a.className = "nt-trend-card";
				a.href = "/jetstream/#/w/" + encodeURIComponent(it.id);
				a.innerHTML = '<span class="nt-thumb"><img loading="lazy" src="' + it.thumb.replace(/"/g, "&quot;") + '" alt="">' +
					(it.live ? '<span class="nt-live">LIVE</span>' : "") + "</span>" +
					'<span class="nt-trend-title"></span>';
				a.querySelector(".nt-trend-title").textContent = it.title;
				grid.appendChild(a);
			}
			w.hidden = false;
		}).catch(() => {});
	}
})();
