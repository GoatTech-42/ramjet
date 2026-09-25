// ramjet native search page (v0.9.4) - server-rendered results from the
// local searxng JSON api. one coherent layout, no stock template.
import http from "http";
import https from "https";

const UP = { host: "127.0.0.1", port: 8888 };
const CATS = ["general", "images", "videos", "news", "map"];
const SAFES = [["1", "Moderate"], ["0", "Off"], ["2", "Strict"]];
const TIMES = [["", "Anytime"], ["day", "Past day"], ["week", "Past week"], ["month", "Past month"], ["year", "Past year"]];
const LANGS = [["auto", "Auto-detect"], ["en-US", "English (US)"], ["es-ES", "Espanol"], ["fr-FR", "Francais"], ["de-DE", "Deutsch"]];

function esc(s) {
	return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fetchJson(path) {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: UP.host, port: UP.port, path, timeout: 12000 }, (res) => {
			let buf = "";
			res.on("data", (c) => (buf += c));
			res.on("end", () => {
				try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("bad json")); }
			});
		});
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
	});
}

const cache = new Map();
const TTL = 10 * 60 * 1000;
async function search(params) {
	const qs = new URLSearchParams();
	qs.set("q", params.q);
	qs.set("format", "json");
	if (params.category && params.category !== "general") qs.set("categories", params.category);
	if (params.pageno > 1) qs.set("pageno", String(params.pageno));
	if (params.safesearch !== "") qs.set("safesearch", params.safesearch);
	if (params.time_range) qs.set("time_range", params.time_range);
	if (params.language && params.language !== "auto") qs.set("language", params.language);
	const key = qs.toString();
	const hit = cache.get(key);
	if (hit && Date.now() - hit.ts < TTL) return { data: hit.data, ms: 0 };
	const t0 = Date.now();
	const data = await fetchJson("/search?" + key);
	if (cache.size > 150) cache.delete(cache.keys().next().value);
	cache.set(key, { data, ts: Date.now() });
	return { data, ms: Date.now() - t0 };
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }
function crumbs(u) {
	try {
		const x = new URL(u);
		const parts = x.pathname.split("/").filter(Boolean).slice(0, 3);
		let out = x.hostname.replace(/^www\./, "");
		for (const p of parts) out += " &rsaquo; " + esc(decodeURIComponent(p).slice(0, 24));
		return out;
	} catch (e) { return esc(u); }
}
function relTime(d) {
	const t = Date.parse(d);
	if (!t) return "";
	const h = Math.floor((Date.now() - t) / 3600000);
	if (h < 1) return "just now";
	if (h < 24) return h + "h ago";
	const dd = Math.floor(h / 24);
	if (dd < 30) return dd + "d ago";
	return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function resultHtml(r, category) {
	if (category === "images") return "";
	const title = esc(r.title || r.url);
	const eng = (r.engines || []).slice(0, 3).map(esc).join(" &middot; ");
	let thumb = "";
	if (category === "videos" && (r.thumbnail || r.img_src)) {
		const durS = String(r.length || "").trim();
		const dur = durS && durS !== "0:00" && Number(durS) !== 0 ? `<span class="dur">${esc(/^\d+$/.test(durS) ? fmtDur(durS) : durS)}</span>` : "";
		thumb = `<span class="vthumb"><img loading="lazy" src="${esc(th(r.thumbnail || r.img_src))}" alt="">${dur}</span>`;
	}
	const when = r.publishedDate ? `<span class="when">${esc(relTime(r.publishedDate))} &middot; </span>` : "";
	return `<div class="res">
		${thumb}
		<div class="rbody">
			<div class="rurl"><img class="fav" loading="lazy" src="${esc(th("https://icons.duckduckgo.com/ip3/" + hostOf(r.url) + ".ico"))}" alt="" onerror="this.style.display='none'">${crumbs(r.url)}</div>
			<a class="rtitle" href="${esc(r.url)}" rel="noopener">${title}</a>
			<div class="rsnip">${when}${esc((r.content || "").slice(0, 220))}</div>
			<div class="reng">${eng}</div>
		</div>
	</div>`;
}
function fmtDur(s) {
	s = Math.round(Number(s) || 0);
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
	return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0");
}

function imageGrid(results) {
	const tiles = results.map((r, i) => {
		const img = r.img_src || "";
		if (!img) return "";
		const thumb = r.thumbnail_src || r.thumbnail || img;
		return `<button class="tile" data-full="${esc(th(img))}" data-title="${esc(r.title || "")}" data-src="${esc(r.url)}" data-res="${esc(r.resolution || "")}" style="animation-delay:${Math.min(i * 24, 400)}ms">
			<img loading="lazy" src="${esc(th(thumb))}" alt="${esc(r.title || "image")}">
			${r.resolution ? `<span class="badge">${esc(r.resolution)}</span>` : ""}
			${r.title ? `<span class="tcap">${esc(r.title)}</span>` : ""}
		</button>`;
	}).join("");
	return `<div class="grid">${tiles}</div>`;
}

function infoboxHtml(ib) {
	if (!ib) return "";
	const img = ib.img_src ? `<img class="ibimg" src="${esc(th(ib.img_src))}" alt="">` : "";
	const attrs = (ib.attributes || []).map((a) => `<div class="ibattr"><span>${esc(a.label)}</span>${esc(a.value)}</div>`).join("");
	const links = (ib.urls || []).slice(0, 4).map((u) => `<a href="${esc(u.url)}" rel="noopener">${esc(u.title)}</a>`).join(" &middot; ");
	return `<aside class="ibox">
		<div class="ibtitle">${esc(ib.infobox || "")}</div>
		${img}
		<div class="ibcontent">${esc((ib.content || "").slice(0, 420))}</div>
		${attrs}
		<div class="iblinks">${links}</div>
	</aside>`;
}

function page(o) {
	const { q, category, pageno, safesearch, time_range, language, data, ms, err } = o;
	const results = (data && data.results) || [];
	const answers = (data && data.answers) || [];
	const ib = data && data.infoboxes && data.infoboxes[0];
	const corrections = (data && data.corrections) || [];

	const tab = (c, label) => {
		const u = new URLSearchParams({ q });
		if (c !== "general") u.set("categories", c);
		if (safesearch !== "1") u.set("safesearch", safesearch);
		if (time_range) u.set("time_range", time_range);
		if (language !== "auto") u.set("language", language);
		return `<a class="tab${c === category ? " on" : ""}" href="/search?${u}">${label}</a>`;
	};
	const tabs = CATS.map((c) => tab(c, c[0].toUpperCase() + c.slice(1))).join("");

	const sel = (name, opts, cur, tip) => {
		const curLabel = (opts.find(([v]) => v === cur) || opts[0])[1];
		return `<div class="fsel" data-name="${name}" data-value="${esc(cur)}" title="${tip}">
			<button type="button" class="fbtn" aria-haspopup="listbox" aria-expanded="false"><span class="flabel">${esc(curLabel)}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
			<div class="fpop" hidden role="listbox">${opts.map(([v, l]) => `<button type="button" class="fopt${v === cur ? " on" : ""}" role="option" data-v="${esc(v)}" aria-selected="${v === cur}">${esc(l)}</button>`).join("")}</div>
		</div>`;
	};
	const filters = `<div class="filters">
		${sel("language", LANGS, language, "result language")}
		${sel("time_range", TIMES, time_range, "only show results from this period")}
		${sel("safesearch", SAFES, safesearch, "mature content filtering")}
	</div>`;

	let body = "";
	if (err) {
		body = `<div class="empty"><div class="ebig">search hiccup</div><div class="esub">the engine didn't answer in time - <a href="" onclick="location.reload();return false">try again</a></div></div>`;
	} else {
		const ansTexts = answers.map((a) => (typeof a === "string" ? a : (a && (a.answer || a.content || a.text)) || "")).filter(Boolean);
	if (ansTexts.length) body += `<div class="answer">${esc(ansTexts[0])}</div>`;
		if (corrections.length && pageno === 1) body += `<div class="corr">did you mean <b>${esc(corrections[0])}</b>?</div>`;
		if (category === "images") {
			body += results.length ? imageGrid(results) : `<div class="empty"><div class="ebig">no images</div><div class="esub">try different words</div></div>`;
		} else {
			const list = results.map((r) => resultHtml(r, category)).join("");
			const main = list || `<div class="empty"><div class="ebig">no results</div><div class="esub">try different words or fewer filters</div></div>`;
			body += ib && pageno === 1 ? `<div class="cols"><div class="main">${main}</div>${infoboxHtml(ib)}</div>` : `<div class="main solo">${main}</div>`;
		}
		const mk = (p, label, cls) => {
			const u = new URLSearchParams({ q });
			if (category !== "general") u.set("categories", category);
			if (safesearch !== "1") u.set("safesearch", safesearch);
			if (time_range) u.set("time_range", time_range);
			if (language !== "auto") u.set("language", language);
			if (p > 1) u.set("pageno", String(p));
			return `<a class="pg ${cls}" href="/search?${u}">${label}</a>`;
		};
		if (results.length) {
			let pgs = "";
			if (pageno > 1) pgs += mk(pageno - 1, "&lsaquo; prev", "prev");
			for (let p = Math.max(1, pageno - 3); p <= pageno + 3; p++) pgs += p === pageno ? `<span class="pg on">${p}</span>` : mk(p, String(p), "");
			if (results.length >= 5) pgs += mk(pageno + 1, "next &rsaquo;", "next");
			body += `<div class="pages">${pgs}</div>`;
		}
	}
	const nres = (data && data.number_of_results) || 0;
	const meta = err ? "" : `<div class="meta">${nres > results.length ? "about " + Number(nres).toLocaleString("en-US") : results.length} results &middot; ${ms ? (ms / 1000).toFixed(2) + "s" : "cached"}</div>`;

	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(q)} - ramjet search</title>
<style>${CSS}</style>
</head><body>
<div id="rj-load" hidden><div class="track"><div class="bar"></div></div></div>
<form class="bar" action="/search" method="get" id="sf">
	<input id="q" name="q" type="text" value="${esc(q)}" placeholder="search" autocomplete="off" spellcheck="false">
	${category !== "general" ? `<input type="hidden" name="categories" value="${esc(category)}">` : ""}
	<button id="go" type="submit" title="search" aria-label="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.8 15.8 21 21"/></svg></button>
</form>
<nav class="tabs">${tabs}</nav>
${filters}
<div id="wrap">${body}</div>
${meta}
<div class="lbox" id="lbox" hidden>
	<button class="lclose" title="close (esc)" aria-label="close">&times;</button>
	<button class="lnav lprev" title="previous" aria-label="previous image">&#8249;</button>
	<button class="lnav lnext" title="next" aria-label="next image">&#8250;</button>
	<img id="limg" alt="">
	<div class="linfo"><span id="ltitle"></span><span id="lres"></span><span id="lcount"></span><a id="lsrc" href="#" rel="noopener">view source</a></div>
</div>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{--acc:#ffa028;--acc2:#c96f04;--bg:#0b0c0e;--card:#14161a;--line:#2c313a;--txt:#e8e9eb;--dim:#8a8f98}
*{margin:0;box-sizing:border-box;scrollbar-width:none}::-webkit-scrollbar{display:none}
html,body{background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
body{max-width:760px;margin:0 auto;padding:18px 16px 60px;animation:fadein .25s ease}
@keyframes fadein{from{opacity:0}to{opacity:1}}
a{color:var(--acc);text-decoration:none}
.bar{display:flex;gap:0;background:var(--card);border:1.5px solid var(--line);border-radius:12px;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.bar:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 22%,transparent)}
#q{flex:1;min-width:0;background:none;border:0;outline:0;color:var(--txt);font-size:16px;padding:12px 14px}
#go{flex:0 0 auto;background:var(--acc);border:0;color:#14100a;padding:0 18px;cursor:pointer;display:flex;align-items:center;transition:filter .12s}
#go:hover{filter:brightness(1.12)} #go:active{transform:scale(.96)}
#go svg{width:20px;height:20px}
.tabs{display:flex;gap:2px;margin:14px 0 0;border-bottom:1px solid var(--line);overflow-x:auto}
.tab{padding:8px 14px;color:var(--dim);font-size:14px;border-bottom:2px solid transparent;transition:color .15s,border-color .2s;white-space:nowrap}
.tab:hover{color:var(--txt)}
.tab.on{color:var(--acc);border-bottom-color:var(--acc)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 20px}
select{appearance:none;-webkit-appearance:none;background:var(--card) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238a8f98' stroke-width='1.5' fill='none'/%3E%3C/svg%3E") no-repeat right 10px center;border:1.5px solid var(--line);border-radius:8px;color:var(--txt);font-size:13.5px;padding:7px 30px 7px 12px;cursor:pointer;transition:border-color .15s}
select:hover,select:focus{border-color:var(--acc);outline:0}
.cols{display:grid;grid-template-columns:1fr 300px;gap:22px;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}.ibox{order:-1}}
.res{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);animation:rise .3s ease backwards}
.res:nth-child(2){animation-delay:.04s}.res:nth-child(3){animation-delay:.08s}.res:nth-child(4){animation-delay:.12s}.res:nth-child(5){animation-delay:.16s}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.rurl{font-size:12.5px;color:var(--dim);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rtitle{font-size:17px;font-weight:500;line-height:1.3;display:inline-block;transition:opacity .12s}
.rtitle:hover{text-decoration:underline}
.rsnip{color:#c3c7cd;font-size:14px;margin-top:3px}
.reng{font-size:11.5px;color:#5c626b;margin-top:4px}
.when{color:var(--dim)}
.vthumb{position:relative;flex:0 0 150px}
.vthumb img{width:150px;height:94px;object-fit:cover;border-radius:8px;display:block}
.dur{position:absolute;right:5px;bottom:5px;background:rgba(0,0,0,.78);color:#fff;font-size:11px;padding:1px 5px;border-radius:4px}
.answer{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:15.5px;line-height:1.55}
.corr{color:var(--dim);font-size:13.5px;margin-bottom:12px}
.ibox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;animation:rise .35s .1s ease backwards}
.ibtitle{font-size:18px;font-weight:600;margin-bottom:10px}
.ibimg{width:100%;border-radius:8px;margin-bottom:10px}
.ibcontent{color:#c3c7cd;font-size:13.5px;margin-bottom:10px}
.ibattr{font-size:12.5px;color:var(--dim);margin-top:4px}.ibattr span{color:#5c626b;margin-right:6px}
.iblinks{font-size:12.5px;margin-top:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}
.tile{position:relative;padding:0;border:0;background:var(--card);border-radius:10px;overflow:hidden;cursor:zoom-in;aspect-ratio:4/3;transition:transform .15s,box-shadow .15s;animation:rise .3s ease backwards}
.tile:hover{transform:scale(1.025);box-shadow:0 4px 18px rgba(0,0,0,.45)}
.tile img{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;right:6px;top:6px;background:rgba(0,0,0,.75);color:#cfd3d8;font-size:11px;padding:1px 6px;border-radius:5px}
.tcap{position:absolute;left:0;right:0;bottom:0;padding:20px 10px 8px;font-size:11.5px;color:#e8e9eb;background:linear-gradient(transparent,rgba(6,7,9,.88));opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile:hover .tcap,.tile:focus-visible .tcap{opacity:1;transform:none}
.lnav{position:absolute;top:50%;transform:translateY(-50%);z-index:101;background:rgba(20,22,26,.72);border:1px solid var(--line);color:var(--txt);width:42px;height:42px;border-radius:50%;font-size:20px;cursor:pointer;transition:background .12s,border-color .12s;line-height:1}
.lnav:hover{background:var(--card);border-color:var(--acc)}
.lprev{left:14px}.lnext{right:14px}
.pages{display:flex;gap:6px;justify-content:center;margin:26px 0 10px}
.pg{min-width:34px;text-align:center;padding:7px 10px;border-radius:8px;color:var(--dim);border:1px solid transparent;transition:all .15s}
a.pg:hover{color:var(--txt);border-color:var(--line);background:var(--card)}
.pg.on{color:var(--acc);font-weight:600}
.pg.prev,.pg.next{color:var(--acc)}
.fsel{position:relative;flex:1 1 170px}
.fbtn{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:9px;color:var(--txt);font:inherit;font-size:13.5px;padding:9px 12px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.fbtn:hover{border-color:#4a5160}
.fsel.open .fbtn{border-color:var(--acc);box-shadow:0 0 0 3px rgba(140,170,255,.14)}
.fbtn svg{color:var(--dim);transition:transform .18s}
.fsel.open .fbtn svg{transform:rotate(180deg)}
.fpop{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:60;background:var(--card);border:1px solid var(--line);border-radius:11px;box-shadow:0 14px 40px rgba(0,0,0,.5);padding:5px;animation:pop .14s ease}
.fopt{display:block;width:100%;text-align:left;background:none;border:0;color:var(--txt);font:inherit;font-size:13.5px;padding:9px 11px;border-radius:7px;cursor:pointer;transition:background .12s,color .12s}
.fopt:hover{background:var(--line)}
.fopt.on{color:var(--acc);font-weight:600}
@keyframes pop{from{opacity:0;transform:translateY(-4px)}}
.fav{width:16px;height:16px;border-radius:4px;vertical-align:-3px;margin-right:7px}
.meta{font-size:12.5px;color:var(--dim);margin:-10px 0 16px}
.meta{color:#5c626b;font-size:12px;text-align:center;margin-top:18px}
.empty{text-align:center;padding:60px 0;color:var(--dim)}
.ebig{font-size:20px;color:var(--txt);margin-bottom:6px}
#rj-load{position:fixed;top:0;left:0;right:0;z-index:99;pointer-events:none}
#rj-load .track{height:3px;background:color-mix(in srgb,var(--acc) 12%,transparent);overflow:hidden}
#rj-load .bar{height:100%;width:34%;background:var(--acc);border-radius:0 3px 3px 0;box-shadow:0 0 10px color-mix(in srgb,var(--acc) 55%,transparent);animation:slide 1.05s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-110%)}55%{transform:translateX(180%)}100%{transform:translateX(340%)}}
body.busy #wrap,body.busy .bar,body.busy .tabs{opacity:.55;transition:opacity .15s}
.lbox{position:fixed;inset:0;z-index:100;background:rgba(6,7,9,.78);backdrop-filter:blur(10px) saturate(1.1);-webkit-backdrop-filter:blur(10px) saturate(1.1);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;animation:fadein .18s ease}
.lbox[hidden]{display:none}
.lbox img{max-width:min(92vw,1100px);max-height:74vh;border-radius:10px;box-shadow:0 12px 60px rgba(0,0,0,.6);opacity:0;transition:opacity .18s ease}
.lbox img.rdy{opacity:1;animation:zoom .2s ease}
.lbox.loading::before{content:"";position:absolute;top:50%;left:50%;width:34px;height:34px;margin:-20px 0 0 -20px;border-radius:50%;border:3px solid color-mix(in srgb,var(--acc) 25%,transparent);border-top-color:var(--acc);animation:spin .7s linear infinite;z-index:100}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes zoom{from{transform:scale(.94);opacity:.4}to{transform:none;opacity:1}}
.linfo{display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:center;color:var(--dim);font-size:13.5px;max-width:90vw}
#ltitle{color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52vw}
#lcount{color:#5c626b;font-variant-numeric:tabular-nums}
.lclose{position:absolute;top:16px;right:20px;background:none;border:0;color:var(--dim);font-size:34px;cursor:pointer;line-height:1;transition:color .12s}
.lclose:hover{color:#fff}
@media(max-width:560px){body{padding:12px 10px 40px}.vthumb{display:none}.filters{margin-bottom:14px}}
`;

const JS = `
(function(){
try{var s=JSON.parse(localStorage.getItem("rj.settings")||"{}");
var T={amber:["#ffa028","#c96f04"],mint:["#34d399","#059669"],sky:["#38bdf8","#0369a1"],violet:["#a78bfa","#6d28d9"],ember:["#f87171","#b91c1c"]};
var t=T[s.theme]||T.amber;if(s.theme==="custom"&&s.customAccent)t=[s.customAccent,s.customAccent];
var r=document.documentElement.style;r.setProperty("--acc",t[0]);r.setProperty("--acc2",t[1]);}catch(e){}
var load=document.getElementById("rj-load");
function busy(){load.hidden=false;document.body.classList.add("busy")}
window.addEventListener("pageshow",function(){load.hidden=true;document.body.classList.remove("busy")});
document.getElementById("sf").addEventListener("submit",busy);
document.querySelectorAll(".tab,.pg").forEach(function(a){a.addEventListener("click",function(e){if(!e.metaKey&&!e.ctrlKey&&!e.shiftKey)busy()})});
window.go=function(){var f=document.getElementById("sf");
var get=function(n){var el=f.querySelector('[name="'+n+'"]')||document.querySelector('.filters [name="'+n+'"]');return el?el.value:""};
var dv=function(n){var el=document.querySelector('.filters [data-name="'+n+'"]');return el?el.dataset.value:""};
var lang=dv("language"),tr=dv("time_range"),ss=dv("safesearch");
var u=new URLSearchParams({q:document.getElementById("q").value});
var cat=f.querySelector('[name="categories"]');if(cat)u.set("categories",cat.value);
if(lang!=="auto")u.set("language",lang);if(tr)u.set("time_range",tr);if(ss!=="1")u.set("safesearch",ss);
busy();location.href="/search?"+u;};
var lbox=document.getElementById("lbox"),limg=document.getElementById("limg"),lt=document.getElementById("ltitle"),lr=document.getElementById("lres"),ls=document.getElementById("lsrc"),lc=document.getElementById("lcount");
limg.addEventListener("load",function(){lbox.classList.remove("loading");limg.classList.add("rdy")});
var tiles=Array.prototype.slice.call(document.querySelectorAll(".tile")),ti=0;
function showTile(i){if(!tiles.length)return;ti=(i+tiles.length)%tiles.length;var t=tiles[ti];
lbox.classList.add("loading");limg.classList.remove("rdy");limg.src=t.dataset.full;lt.textContent=t.dataset.title;lr.textContent=t.dataset.res||"";lc.textContent=(ti+1)+" / "+tiles.length;ls.href=t.dataset.src}
tiles.forEach(function(t,ix){t.addEventListener("click",function(){showTile(ix);lbox.hidden=false})});
document.querySelector(".lprev").addEventListener("click",function(e){e.stopPropagation();showTile(ti-1)});
document.querySelector(".lnext").addEventListener("click",function(e){e.stopPropagation();showTile(ti+1)});
function close(){lbox.hidden=true;limg.src=""}
lbox.addEventListener("click",function(e){if(e.target===lbox)close()});
document.querySelector(".lclose").addEventListener("click",close);
document.addEventListener("keydown",function(e){if(e.key==="Escape")close();if(!lbox.hidden){if(e.key==="ArrowLeft")showTile(ti-1);if(e.key==="ArrowRight")showTile(ti+1)}});
var q0=document.getElementById("q");
document.querySelectorAll(".fsel").forEach(function(f){
var b=f.querySelector(".fbtn");
b.addEventListener("click",function(e){e.stopPropagation();var was=f.classList.contains("open");
document.querySelectorAll(".fsel.open").forEach(function(o){o.classList.remove("open");o.querySelector(".fpop").hidden=true;o.querySelector(".fbtn").setAttribute("aria-expanded","false")});
if(!was){f.classList.add("open");f.querySelector(".fpop").hidden=false;b.setAttribute("aria-expanded","true")}});
f.querySelectorAll(".fopt").forEach(function(o){o.addEventListener("click",function(e){e.stopPropagation();f.dataset.value=o.dataset.v;go()})});
});
document.addEventListener("click",function(){document.querySelectorAll(".fsel.open").forEach(function(o){o.classList.remove("open");o.querySelector(".fpop").hidden=true;o.querySelector(".fbtn").setAttribute("aria-expanded","false")})});
document.addEventListener("keydown",function(e){if(e.key==="/"&&document.activeElement!==q0&&!/INPUT|TEXTAREA/.test((document.activeElement||{}).tagName||"")){e.preventDefault();q0.focus();q0.select()}});
// perceived speed: hovering a tab warms its query into the server cache so the
// click feels instant; page 2 prefetches at idle for the same reason.
var warm=function(u){try{fetch(u,{credentials:"same-origin"}).then(function(r){return r.text()}).catch(function(){})}catch(e){}};
document.querySelectorAll(".tab:not(.on)").forEach(function(a){a.addEventListener("pointerenter",function(){warm(a.href)},{once:true})});
tiles.forEach(function(t){t.addEventListener("pointerenter",function(){var i=new Image();i.src=t.dataset.full},{once:true})});
window.addEventListener("load",function(){var n=document.querySelector(".pg.next");if(!n)return;
var go2=function(){warm(n.href)};
if(window.requestIdleCallback)requestIdleCallback(go2,{timeout:2500});else setTimeout(go2,1600);});
})();
`;

function parseQuery(url) {
	const u = new URL(url, "http://x");
	const p = u.searchParams;
	let category = p.get("categories") || "general";
	if (!CATS.includes(category)) category = "general";
	return {
		q: (p.get("q") || "").trim(),
		category,
		pageno: Math.max(1, parseInt(p.get("pageno") || "1", 10) || 1),
		safesearch: ["0", "1", "2"].includes(p.get("safesearch")) ? p.get("safesearch") : "1",
		time_range: ["day", "week", "month", "year"].includes(p.get("time_range")) ? p.get("time_range") : "",
		language: LANGS.some(([v]) => v === p.get("language")) ? p.get("language") : "auto",
	};
}

async function handle(req, res) {
	const params = parseQuery(req.url);
	res.setHeader("content-type", "text/html; charset=utf-8");
	if (!params.q) {
		res.writeHead(303, { location: "/searx/" });
		res.end();
		return;
	}
	try {
		const { data, ms } = await search(params);
		res.writeHead(200);
		res.end(page({ ...params, data, ms }));
	} catch (e) {
		res.writeHead(200);
		res.end(page({ ...params, data: null, ms: 0, err: true }));
	}
}


// server-side image proxy: hotlinking engine thumbs straight from the browser
// fails (referer blocks, tracker filters), so route them through us.
function th(u) { return "/th?u=" + encodeURIComponent(u); }

function thumb(req, res) {
	let u;
	try { u = new URL(new URL(req.url, "http://localhost").searchParams.get("u") || ""); } catch (e) { res.writeHead(400); return res.end(); }
	if (!/^https?:$/.test(u.protocol)) { res.writeHead(400); return res.end(); }
	getImg(u, res, 0);
}
function getImg(u, res, depth) {
	const mod = u.protocol === "https:" ? https : http;
	const r = mod.get(u, {
		headers: {
			"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
			"Accept": "image/avif,image/webp,image/*,*/*;q=0.8"
		},
		timeout: 9000
	}, (up) => {
		if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && depth < 3) {
			up.resume();
			let nx;
			try { nx = new URL(up.headers.location, u); } catch (e) { res.writeHead(502); return res.end(); }
			return getImg(nx, res, depth + 1);
		}
		const ct = String(up.headers["content-type"] || "");
		const len = Number(up.headers["content-length"] || 0);
		if (up.statusCode !== 200 || !ct.startsWith("image/") || len > 12582912) { res.writeHead(502); up.resume(); return res.end(); }
		res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=86400" });
		up.pipe(res);
	});
	r.on("timeout", () => { r.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
	r.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
}

export { handle, thumb };
