// reader mode: the box fetches a page, pulls out the article, and serves a
// clean dark reading view (text + images only). no scripts from the source
// page ever reach the browser, and images come through the /searx/img proxy.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { parseDocument } from 'htmlparser2';
import * as DU from 'domutils';
import { safeLookup } from './pfetch.js';
import { esc } from './util.js';

const MAX = 4e6;

function fetchPage(url, hops = 0) {
	return new Promise((resolve, reject) => {
		let t; try { t = new URL(url); } catch { return reject(new Error('bad url')); }
		if (!/^https?:$/.test(t.protocol) || t.username || t.password) return reject(new Error('bad url'));
		const mod = t.protocol === 'https:' ? https : http;
		safeLookup(t.hostname.replace(/^\[|\]$/g, ''), {}, (err) => { if (err) return reject(new Error('that address is blocked')); go(); });
		function go() {
		const r = mod.request(t, { headers: { accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'gzip, br', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' }, lookup: safeLookup, timeout: 12000 }, (rs) => {
			if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location) {
				rs.resume();
				if (hops >= 4) return reject(new Error('too many redirects'));
				return resolve(fetchPage(new URL(rs.headers.location, t).href, hops + 1));
			}
			if (rs.statusCode !== 200) { rs.resume(); return reject(new Error('the site answered ' + rs.statusCode)); }
			if (!/html/i.test(String(rs.headers['content-type'] || ''))) { rs.resume(); return reject(new Error('not a web page')); }
			const enc = String(rs.headers['content-encoding'] || '');
			const src = enc === 'gzip' ? rs.pipe(zlib.createGunzip()) : enc === 'br' ? rs.pipe(zlib.createBrotliDecompress()) : rs;
			const chunks = []; let n = 0;
			src.on('data', (c) => { n += c.length; if (n > MAX) { r.destroy(); reject(new Error('page too large')); } else chunks.push(c); });
			src.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: t.href }));
			src.on('error', reject);
		});
		r.on('timeout', () => r.destroy(new Error('timed out'))); r.on('error', reject); r.end();
		}
	});
}

const DROP = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'noscript', 'svg', 'button', 'select', 'input', 'textarea', 'dialog', 'template', 'canvas', 'video', 'audio', 'object', 'embed']);
const JUNK = /(comment|sidebar|footer|promo|advert|(^|[\s_-])ad([\s_-]|$)|sponsor|share|social|newsletter|subscribe|related|recommend|cookie|popup|modal|breadcrumb|menu|toolbar|byline-extra|navbox|infobox|reflist|mw-editsection|hatnote|metadata|(^|[\s_-])toc([\s_-]|$)|catlinks|printfooter)/i;
const textOf = (n) => DU.textContent(n).replace(/\s+/g, ' ').trim();

function prune(root) {
	for (const el of DU.findAll((e) => DROP.has(e.name) || JUNK.test((e.attribs.class || '') + ' ' + (e.attribs.id || '')) && !/^(html|body|article|main)$/.test(e.name) || e.attribs.hidden != null || e.attribs['aria-hidden'] === 'true', root.children)) DU.removeElement(el);
}

function pickMain(root) {
	const cands = DU.findAll((e) => ['article', 'main', 'div', 'section', 'td', 'body', 'font'].includes(e.name), root.children);
	let best = null, bestScore = 0;
	for (const c of cands) {
		const ps = DU.findAll((e) => e.name === 'p', c.children);
		let score = 0;
		for (const p of ps) { const t = textOf(p); if (t.length > 60) score += Math.min(t.length, 400); }
		for (const k of c.children) if (k.type === 'text') { const t = k.data.replace(/\s+/g, ' ').trim(); if (t.length > 80) score += Math.min(t.length, 1500); }
		const links = textOf({ children: DU.findAll((e) => e.name === 'a', c.children) }).length;
		const all = textOf(c).length || 1;
		score *= 1 - Math.min(0.9, links / all);
		if (c.name === 'article') score *= 1.3;
		if (score > bestScore) { bestScore = score; best = c; }
	}
	return best;
}

const ALLOW = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'br', 'hr', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'a', 'sup', 'sub']);
function render(n, base, out, st) {
	if (n.type === 'text') { out.push(esc(n.data)); return; }
	if (n.type !== 'tag') return;
	const nm = n.name;
	if (nm === 'picture') { const im = DU.findOne((e) => e.name === 'img', n.children); if (im) render(im, base, out, st); return; }
	if (nm === 'img') {
		let s = n.attribs.src || n.attribs['data-src'] || (n.attribs.srcset || '').split(',')[0].trim().split(/\s+/)[0];
		if (!s || /^data:/.test(s) || st.imgs >= 40) return;
		let abs; try { abs = new URL(s, base).href; } catch { return; }
		if (!/^https?:/.test(abs)) return;
		const w = parseInt(n.attribs.width || '0', 10), h = parseInt(n.attribs.height || '0', 10);
		if ((w && w < 80) || (h && h < 60)) return;
		st.imgs++; out.push('<img loading="lazy" alt="' + esc(n.attribs.alt || '') + '" src="/searx/img?u=' + encodeURIComponent(abs) + '">'); return;
	}
	if (!ALLOW.has(nm)) { for (const c of n.children || []) render(c, base, out, st); return; }
	if (nm === 'a') {
		let abs = ''; try { abs = new URL(n.attribs.href || '', base).href; } catch {}
		if (!/^https?:/.test(abs)) { for (const c of n.children || []) render(c, base, out, st); return; }
		out.push('<a href="' + esc(abs) + '">'); for (const c of n.children || []) render(c, base, out, st); out.push('</a>'); return;
	}
	if (nm === 'br' || nm === 'hr') { out.push('<' + nm + '>'); return; }
	out.push('<' + nm + '>'); for (const c of n.children || []) render(c, base, out, st); out.push('</' + nm + '>');
}

const CSS = ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0b0c;color:#e8e8ea;font:18px/1.7 Georgia,"Iowan Old Style",serif}main{max-width:680px;margin:0 auto;padding:28px 20px 80px}.src{font:13px system-ui;color:#8a8a90;margin-bottom:6px;word-break:break-all}h1.t{font:700 30px/1.25 system-ui,sans-serif;margin:0 0 22px;letter-spacing:-.01em}h1,h2,h3,h4{font-family:system-ui,sans-serif;line-height:1.3;margin:1.6em 0 .5em}a{color:#d9f24b}img{max-width:100%;height:auto;border-radius:10px;display:block;margin:18px auto}blockquote{border-left:3px solid #d9f24b;margin:1.2em 0;padding:.1em 0 .1em 16px;color:#c4c4c8}pre{background:#141416;padding:14px;border-radius:10px;overflow:auto;font-size:14px}code{font-size:.9em}table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid #2a2a2e;padding:6px 10px}figcaption{font:13px system-ui;color:#8a8a90;text-align:center}.bar{position:sticky;top:0;background:#0b0b0cdd;backdrop-filter:blur(8px);padding:10px 20px;font:14px system-ui;display:flex;gap:14px;border-bottom:1px solid #1d1d20}.bar a{text-decoration:none}.err{padding:60px 24px;text-align:center;font:16px system-ui;color:#aaa}';
const GO = '<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(/^https?:\\/\\//i.test(h)&&window.parent!==window){e.preventDefault();parent.postMessage({rjBrowseGo:h},"*")}},true);</' + 'script>';
const shell = (title, body) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + CSS + '</style></head><body>' + body + GO + '</body></html>';

export async function readerPage(target) {
	let page;
	try { page = await fetchPage(target); } catch (e) { return shell('Reader', '<div class="err">Reader couldn\'t open this page: ' + esc(e.message) + '.<br><br><a href="' + esc(target) + '">Open the full page</a></div>'); }
	const root = parseDocument(page.html);
	const title = (() => { const h = DU.findOne((e) => e.name === 'title', root.children); const og = DU.findOne((e) => e.name === 'meta' && e.attribs.property === 'og:title', root.children); return textOf(og ? { children: [{ type: 'text', data: og.attribs.content || '' }] } : (h || { children: [] })) || new URL(page.url).hostname; })();
	prune(root);
	const main = pickMain(root);
	if (!main || textOf(main).length < 300) return shell('Reader', '<div class="err">This page doesn\'t look like an article, so reader mode has nothing to show.<br><br><a href="' + esc(page.url) + '">Open the full page</a></div>');
	for (const h of DU.findAll((e) => e.name === 'h1', main.children).slice(0, 1)) if (textOf(h).slice(0, 30) === title.slice(0, 30)) DU.removeElement(h);
	const out = []; render({ type: 'tag', name: 'div', children: main.children }, page.url, out, { imgs: 0 });
	const host = new URL(page.url).hostname.replace(/^www\./, '');
	return shell(title, '<div class="bar"><a href="' + esc(page.url) + '">&larr; full page</a></div><main><div class="src">' + esc(host) + '</div><h1 class="t">' + esc(title) + '</h1>' + out.join('') + '</main>');
}
