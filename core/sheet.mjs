// Contact-sheet renderer: dark rounded cards, frosted-glass number chip and length pill (blurred backdrop), clean title text.
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import nodePath from 'node:path';

const F = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TW = 296, TH = 167, CH = 227, M = 14, G = 12;
// anti-aliased rounded-rect alpha for a WxH box with corner radius R (R = h/2 gives a pill/circle)
const ra = (w, h, r, tl = true) => `a='255*clip(${r}+0.5-hypot(max(abs(X-${w / 2}+0.5)-${w / 2 - r},0),max(abs(Y-${h / 2}+0.5)-${h / 2 - r},0)),0,1)'`;
const rnd = (w, h, r) => `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':${ra(w, h, r)}`;
const esc = (s) => s.replace(/[^\p{L}\p{N} .,!?&'()\-:|#%+]/gu, ' ').replace(/\s+/g, ' ').trim();
function wrap(t) {
  if (t.length <= 29) return [t, ''];
  let cut = t.lastIndexOf(' ', 29); if (cut < 14) cut = 29;
  let l2 = t.slice(cut).trim(); if (l2.length > 29) l2 = l2.slice(0, 27).trimEnd() + '...';
  return [t.slice(0, cut).trim(), l2];
}
export async function renderSheet(dir, items, idx) {
  const cols = 2, rows = Math.ceil(idx.length / cols);
  const W = M * 2 + TW * cols + G * (cols - 1), H = M * 2 + CH * rows + G * (rows - 1);
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x0d0e12:s=${W}x${H}`];
  const parts = []; let last = '0:v';
  for (const [k, i] of idx.entries()) {
    const it = items[i];
    args.push('-i', nodePath.join(dir, 't' + i + '.jpg'));
    const inp = k + 1;
    const f = (n, txt) => writeFile(nodePath.join(dir, n + i + '.txt'), txt);
    const [l1, l2] = wrap(esc(String(it.title || '')));
    await f('n', String(i + 1)); await f('a', l1); await f('b', l2);
    const dur = /^[0-9:]{3,9}$/.test(String(it.duration || '')) ? String(it.duration) : '';
    if (dur) await f('d', dur);
    const dt = (file, font, size, x, y, col) => `drawtext=fontfile=${font}:textfile=${nodePath.join(dir, file + i + '.txt')}:fontsize=${size}:fontcolor=${col}:x=${x}:y=${y}`;
    const pw = dur ? 18 + Math.round(dur.length * 13.2) : 0, ph = 30, px = TW - pw - 10, py = TH - ph - 10;
    let c = `[${inp}:v]scale=${TW}:${TH}:force_original_aspect_ratio=increase,crop=${TW}:${TH},setsar=1,format=yuv420p,split=${dur ? 3 : 2}[b${k}][t${k}]${dur ? `[u${k}]` : ''};`;
    // frosted number chip
    c += `[b${k}]crop=44:44:10:10,gblur=sigma=10,eq=brightness=-0.32:contrast=0.85:saturation=1.1,${rnd(44, 44, 22)}[gc${k}];`;
    c += `[t${k}][gc${k}]overlay=10:10,${dt('n', F, 24, '10+(44-text_w)/2', '10+(44-text_h)/2-1', 'white')}`;
    if (dur) {
      c += `[m${k}];[u${k}]crop=${pw}:${ph}:${px}:${py},gblur=sigma=10,eq=brightness=-0.38:contrast=0.85:saturation=1.1,${rnd(pw, ph, 15)}[gd${k}];`;
      c += `[m${k}][gd${k}]overlay=${px}:${py},${dt('d', F, 18, `${px}+(${pw}-text_w)/2`, `${py}+(${ph}-text_h)/2-1`, 'white')}`;
    }
    c += `,pad=${TW}:${CH}:0:0:color=0x1b1c23,${dt('a', FR, 16, 12, TH + 11, '0xf4f4f7')},${dt('b', FR, 16, 12, TH + 33, '0x9a9ba6')},${rnd(TW, CH, 16)}[card${k}]`;
    parts.push(c);
    const x = M + (k % cols) * (TW + G), y = M + Math.floor(k / cols) * (CH + G);
    parts.push(`[${last}][card${k}]overlay=${x}:${y}:format=auto[o${k}]`); last = `o${k}`;
  }
  args.push('-filter_complex', parts.join(';'), '-map', `[${last}]`, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', nodePath.join(dir, 'out.jpg'));
  await new Promise((resolve, reject) => { const ff = spawn('nice', ['-n', '10', 'ffmpeg', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); let e = ''; ff.stderr.on('data', (d) => { e += d; }); const to = setTimeout(() => ff.kill('SIGKILL'), 25000); ff.on('close', (cd) => { clearTimeout(to); cd ? reject(new Error('ffmpeg ' + e.slice(0, 300))) : resolve(); }); });
  return readFile(nodePath.join(dir, 'out.jpg'));
}
