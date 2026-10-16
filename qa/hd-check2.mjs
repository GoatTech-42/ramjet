import { readFileSync } from "fs";
const PW = readFileSync((process.env.RJ_QA_PASSWORD_FILE || (() => { throw Error('Set RJ_QA_PASSWORD_FILE to an isolated QA password file'); })()), "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const login = await fetch(BASE + "/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "qa", password: PW }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
const r = await fetch(BASE + "/api/apps/jetstream/watch?id=aqz-KE-bpKQ", { headers: { cookie } });
const j = await r.json();
console.log("watch:", r.status, JSON.stringify({ quality: j.quality, hd: j.hd ? j.hd.quality : null, error: j.error || null }));
