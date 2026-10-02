import { readFileSync } from "fs";
const PW = readFileSync("/home/luke/goattech/ramjet-rebuild/data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "qa", password: PW }) });
const cookie = login.headers.get("set-cookie")?.split(";")[0];
const w = await (await fetch(BASE + "/api/apps/jetstream/watch?id=aqz-KE-bpKQ", { headers: { cookie } })).json();
console.log("watch:", JSON.stringify({ quality: w.quality, hd: w.hd?.quality }));
for (const [label, path] of [["fallback", "/api/apps/jetstream/stream?id=aqz-KE-bpKQ"], ["hd-video", "/api/apps/jetstream/vsrc?id=aqz-KE-bpKQ&kind=video"], ["hd-audio", "/api/apps/jetstream/vsrc?id=aqz-KE-bpKQ&kind=audio"]]) {
  const r = await fetch(BASE + path, { headers: { cookie, range: "bytes=0-15" } });
  const buf = Buffer.from(await r.arrayBuffer());
  console.log(label, r.status, r.headers.get("content-type"), r.headers.get("content-range"), "magic:", buf.slice(4, 8).toString());
}
