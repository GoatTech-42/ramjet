import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "qa", password: PW }) });
const cookie = login.headers.get("set-cookie")?.split(";")[0];
const s = await (await fetch(BASE + "/api/apps/amp/search?q=" + encodeURIComponent("never gonna give you up"), { headers: { cookie } })).json();
const yt = s.results?.youtube || [];
console.log("yt results:", yt.length, "| sc:", s.results?.soundcloud?.length, "| au:", s.results?.audius?.length);
const track = yt[0];
console.log("first yt track:", JSON.stringify({ id: track?.id, title: track?.title, artist: track?.artist }));
const MB = 1048576;
for (const [start, label] of [[0, "block0"], [3 * MB, "block3 (past old 2MB cap)"]]) {
  const r = await fetch(BASE + `/api/apps/amp/stream?src=yt&id=${track.id}`, { headers: { cookie, range: `bytes=${start}-` } });
  const body = await r.arrayBuffer();
  console.log(label, "->", r.status, r.headers.get("content-range"), "bytes:", body.byteLength);
}
