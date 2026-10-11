// Outcome (ws) update for a history entry. Clients send CUMULATIVE watch seconds
// plus a monotonically increasing seq (ms clock). A report with an older seq than
// the one stored is a late/reordered delivery and is ignored, so an old 18s beacon
// can't overwrite a newer 20s post. Reports with no seq (older clients) keep the
// previous last-write-wins behaviour.
export function applyWs(hit, ws, seq) {
  const s = typeof seq === 'number' && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : null;
  if (s != null) {
    if (typeof hit.wsSeq === 'number' && s < hit.wsSeq) return false;
    hit.wsSeq = s;
  }
  hit.ws = ws;
  return true;
}
