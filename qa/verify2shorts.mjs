// Luke's bar (Tue 5:30 PM): play 2 WHOLE shorts consecutively, verifying the
// audio AND video actually change/display for the entire duration of both.
// Per slide: video currentTime reaches the end, decoded frames never stop for
// >2s, on-screen pixels change every 2s window, and the audio element carries
// a live signal (WebAudio RMS) for every 2s window, in sync with the video.
import { chromium, devices } from "playwright";
import { readFileSync } from "fs";
const pw = readFileSync("../data/.qa-password", "utf8").trim();
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const login = await page.request.post("http://127.0.0.1:14224/api/auth/login", { data: { username: "qa", password: pw } });
const token = (login.headers()["set-cookie"] || "").match(/rj2_session=([^;]+)/)?.[1];
await ctx.addCookies([{ name: "rj2_session", value: token, url: "http://127.0.0.1:14224" }]);
await page.goto("http://127.0.0.1:14224/jetstream", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scard", { timeout: 60000 });
await page.tap(".scard");
await page.waitForSelector(".feed .slide video", { timeout: 10000 });

const results = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const videos = () => [...document.querySelectorAll(".feed .slide video")];
  const activeVideo = () => videos().find((x) => x.src && !x.paused) || videos().find((x) => x.src);
  const audioFor = (v) => {
    // the pair element is a DOM-attached <audio> playing the same timeline
    const auds = [...document.querySelectorAll("audio")];
    return auds.find((a) => !a.paused) || auds[auds.length - 1] || null;
  };
  // canvas pixel sampler
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 64;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const px = (v) => {
    try { cx.drawImage(v, 0, 0, 64, 64); const d = cx.getImageData(0, 0, 64, 64).data; let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i]; return s; } catch { return -1; }
  };
  // WebAudio RMS tap
  let actx = null; const taps = new Map();
  const rmsOf = (el) => {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      if (!taps.has(el)) {
        const src = actx.createMediaElementSource(el);
        const an = actx.createAnalyser(); an.fftSize = 256;
        src.connect(an); an.connect(actx.destination);
        taps.set(el, an);
      }
      const an = taps.get(el);
      const buf = new Uint8Array(an.frequencyBinCount);
      an.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      return Math.sqrt(sum / buf.length);
    } catch (e) { return -1; }
  };

  const playSlide = async (slideIdx) => {
    // wait for this slide to be the active one with a src
    let v = null;
    for (let i = 0; i < 60; i++) {
      v = videos().find((x) => parseInt(x.dataset.idx, 10) === slideIdx && x.src);
      if (v) break;
      await sleep(500);
    }
    if (!v) return { slide: slideIdx, fail: "never got a src" };
    // ensure playing
    for (let i = 0; i < 20 && v.paused; i++) { v.play().catch(() => {}); await sleep(500); }
    if (v.paused) return { slide: slideIdx, fail: "would not play" };

    const out = { slide: slideIdx, id: "", dur: 0, maxT: 0, frameGaps: [], pixelDeadWindows: [], audioSilentWindows: [], driftMax: 0, audioKind: "none", waitingEvents: 0, ended: false };
    v.addEventListener("waiting", () => out.waitingEvents++);
    let lastFrames = 0, lastPx = -2, winStart = Date.now(), winFrames0 = 0, winPx0 = -2, winSilent = true, winStartT = 0;
    const t0 = Date.now();
    winFrames0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : -1;
    winPx0 = px(v);
    winStartT = v.currentTime;
    while (Date.now() - t0 < 120000) {
      await sleep(500);
      if (!v.isConnected) return { ...out, fail: "video element removed mid-play" };
      const t = v.currentTime, dur = v.duration || 0;
      out.dur = dur; if (t > out.maxT) out.maxT = t;
      const a = audioFor(v);
      if (a && a !== v) { out.audioKind = "pair"; out.driftMax = Math.max(out.driftMax, Math.abs(a.currentTime - t)); }
      else if (v.muted === false) out.audioKind = "muxed";
      const now = Date.now();
      if (now - winStart >= 2000) {
        const fr = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : -1;
        const gained = fr - winFrames0;
        const tGain = t - winStartT;
        if (gained <= 0 && tGain < 0.2) out.frameGaps.push(Math.round((now - t0) / 1000) + "s");
        const p = px(v);
        if (p === winPx0) out.pixelDeadWindows.push(Math.round((now - t0) / 1000) + "s");
        // audio window verdict
        const rms = a && a !== v ? rmsOf(a) : (out.audioKind === "muxed" ? rmsOf(v) : -1);
        if (rms >= 0 && rms < 0.0004 && winSilent) out.audioSilentWindows.push(Math.round((now - t0) / 1000) + "s");
        winFrames0 = fr; winPx0 = p; winStart = now; winStartT = t;
      }
      if (dur > 0 && t >= dur - 0.35) { out.ended = true; break; }
    }
    return out;
  };

  const swipeTo = async (idx) => {
    const el = document.querySelector(`.slide[data-idx="${idx}"]`);
    if (el) el.scrollIntoView({ block: "start" });
  };

  const r0 = await playSlide(0);
  await swipeTo(1);
  await sleep(800);
  const r1 = await playSlide(1);
  // count live media elements left behind - old-model rule check
  const leftovers = videos().filter((x) => x.src && !x.paused).length;
  const srcHolders = videos().filter((x) => x.src).length;
  return { r0, r1, leftovers, srcHolders };
});
console.log(JSON.stringify(results, null, 1));
await browser.close();
