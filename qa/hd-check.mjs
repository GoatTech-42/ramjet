import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const login = await fetch(BASE + "/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "qa", password: PW }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
console.log("login:", login.status, cookie ? "cookie-ok" : "NO COOKIE");
const srch = await (await fetch(BASE + "/api/apps/jetstream/search?q=" + encodeURIComponent("big buck bunny"), { headers: { cookie } })).json();
const first = srch.results?.[0] || srch.videos?.[0] || (Array.isArray(srch) ? srch[0] : null);
console.log("first result:", first?.id, JSON.stringify(first?.title || first));
const r = await fetch(BASE + "/api/apps/jetstream/resolve?id=" + first.id, { headers: { cookie } });
const j = await r.json();
console.log("resolve:", r.status, JSON.stringify({ quality: j.quality, hd: j.hd ? { quality: j.hd.quality } : null, hasStream: !!j.stream }));
