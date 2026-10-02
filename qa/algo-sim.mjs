// Luke's bar (Tue 5:58 PM): a handful of interactions visibly reshapes the
// next batch. simulate: like 3 minecraft-parkour videos, quick-skip 10
// cooking videos, then the next shorts batch must lean measurably toward
// minecraft/parkour and away from cooking.
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const BASE = "http://127.0.0.1:14224";
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "qa", password: pw }) });
const cookie = login.headers.get("set-cookie").match(/rj2_session=[^;]+/)[0];
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { "content-type": "application/json", cookie } });
  return r.json();
};
// clean slate
await api("/api/apps/jetstream/history/clear", { method: "POST", body: "{}" });
const Y = ["cooking", "recipe", "baking", "pasta", "kitchen"];
const X = ["minecraft", "parkour", "speedrun"];
const tag = (items) => {
  let x = 0, y = 0;
  for (const v of items) {
    const t = (v.title || "").toLowerCase();
    if (X.some((w) => t.includes(w))) x++;
    if (Y.some((w) => t.includes(w))) y++;
  }
  return { x, y, n: items.length };
};
const before = tag((await api("/api/apps/jetstream/shorts?fresh=1")).items || []);
// teach: 3 full-watch + like on minecraft parkour
for (let i = 0; i < 3; i++) {
  const v = { id: ("simX" + i + "aaaaaaaaaa").slice(0, 11), title: "minecraft parkour world record run " + i, channel: "ParkourPro", duration: "0:45" };
  await api("/api/apps/jetstream/history", { method: "POST", body: JSON.stringify({ ...v, watched: 44 }) });
  await api("/api/apps/jetstream/likes/toggle", { method: "POST", body: JSON.stringify(v) });
}
// teach: 10 quick-skips on cooking
for (let i = 0; i < 10; i++) {
  const v = { id: ("simY" + i + "bbbbbbbbbb").slice(0, 11), title: "easy pasta recipe cooking tutorial " + i, channel: "ChefHome", duration: "0:50" };
  await api("/api/apps/jetstream/history", { method: "POST", body: JSON.stringify(v) });
  await api("/api/apps/jetstream/history", { method: "POST", body: JSON.stringify({ ...v, watched: 1 }) });
}
// first pull triggers the re-rank; the second (after it lands) measures it
await api("/api/apps/jetstream/shorts?fresh=1");
await new Promise((r) => setTimeout(r, 15000));
const after = tag((await api("/api/apps/jetstream/shorts?fresh=1")).items || []);
console.log(JSON.stringify({ before, after }));
// clean the sim rows back out
await api("/api/apps/jetstream/history/clear", { method: "POST", body: "{}" });
