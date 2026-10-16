// shared accept-encoding negotiation + async per-entry compression.
// compression used to run synchronously inside the request that first asked
// for an encoding - multi-MB engine files stalled the event loop for every
// other user on the box. now it runs on zlib's worker threads, and an entry
// being compressed holds one Promise that every concurrent request shares.
import { brotliCompress as brC, gzip as gzC, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';
const brotliCompress = promisify(brC);
const gzip = promisify(gzC);

// q=0 means NOT acceptable: br;q=0 must fall through to gzip or identity.
// br wins over gzip when both are allowed.
export function negotiateEncoding(ae) {
  ae = String(ae || '');
  const q = (name) => {
    const m = new RegExp('(?:^|,)\\s*' + name.replaceAll('*', '\\*') + '\\s*(?:;\\s*q\\s*=\\s*([01](?:\\.\\d+)?))?', 'i').exec(ae);
    return m ? (m[1] === undefined ? 1 : Number(m[1])) : -1;
  };
  if (q('br') > 0) return 'br';
  if (q('gzip') > 0) return 'gzip';
  // wildcard accepts anything not explicitly listed: offer our best allowed
  if (q('*') > 0) {
    if (q('br') < 0) return 'br';
    if (q('gzip') < 0) return 'gzip';
  }
  return '';
}

// entry shape: { raw: Buffer, br: null|Promise<Buffer>|Buffer, gz: same }.
// null = not started, Promise = in flight (share it), Buffer = done.
// a failed compression resets the slot to null so the next request retries.
export function compressed(e, enc) {
  if (enc !== 'br' && enc !== 'gzip') return Promise.reject(new Error('unknown content-encoding: ' + enc));
  const k = enc === 'br' ? 'br' : 'gz';
  if (Buffer.isBuffer(e[k])) return Promise.resolve(e[k]);
  if (!e[k]) {
    const p = (enc === 'br'
      ? brotliCompress(e.raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 6, [zc.BROTLI_PARAM_SIZE_HINT]: e.raw.length } })
      : gzip(e.raw, { level: 9 }));
    e[k] = new Promise((resolve, reject) => {
      p.then((b) => { e[k] = b; resolve(b); }, (err) => { e[k] = null; reject(err); });
    });
  }
  return e[k];
}
