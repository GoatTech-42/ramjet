                                                                                                            
                                                                                                
                                                                          
use std::collections::{HashMap, HashSet};
use super::jetstream::parse_secs;
use super::{js_round, js_slice16};

pub const SHORT_MAX: f64 = 61.0;
const STOP: &str = "the and for with that this from your you are was were have has had not but all can will its his her she him they them their our out about into over after before between under again once here there when where why how what which who whom been being both each few more most other some such only own same than too very just challenge challenges tiktok viral viralvideo ytshorts shorts short video videos youtube reels fyp foryou trending compilation feat wait till end part";

fn stop() -> &'static HashSet<&'static str> { static S: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new(); S.get_or_init(|| STOP.split(' ').collect()) }
fn bait() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
                                                               
    R.get_or_init(|| regex::Regex::new(r"(?i)tik ?tok|compilation|try not to|you won[^\n\r\x{2028}\x{2029}]?t believe|gone wrong|#shorts|(?-u:\b)fails?(?-u:\b)|top [0-9]+ |(?-u:\b)pranks?(?-u:\b)|(?-u:\b)reacts? to(?-u:\b)|subscribe|part [0-9]+").unwrap())
}

#[derive(Clone, Debug, Default)]
pub struct V {
    pub id: String, pub title: String, pub channel: String, pub channel_id: String,
    pub duration: String, pub views: String, pub published: String, pub desc: String,
    pub secs: Option<f64>, pub ws: Option<f64>,
}

pub fn words(t: &str) -> Vec<String> {
    t.to_lowercase().split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|w| w.len() >= 4 && !stop().contains(w)).map(String::from).collect()
}
fn truthy_num(x: Option<f64>) -> f64 { match x { Some(n) if n != 0.0 && !n.is_nan() => n, _ => 0.0 } }
fn is_short(v: &V) -> bool { match v.secs.or_else(|| parse_secs(&v.duration)) { Some(s) => s <= SHORT_MAX, None => false } }
fn dur_of(v: &V) -> f64 { let a = truthy_num(v.secs); if a != 0.0 { a } else { truthy_num(parse_secs(&v.duration)) } }

pub fn parse_views(t: &str) -> f64 {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let r = R.get_or_init(|| regex::Regex::new(r"([0-9,.]+)\s*([KkMmBb])?").unwrap());
    let Some(m) = r.captures(t) else { return 0.0 };
    let s: String = m[1].chars().filter(|c| *c != ',').collect();
    let n = js_parse_float(&s);
    if !n.is_finite() { return 0.0; }
    let mult = match m.get(2).map(|x| x.as_str().to_lowercase()).as_deref() { Some("k") => 1e3, Some("m") => 1e6, Some("b") => 1e9, _ => 1.0 };
    n * mult
}
                                                                                       
fn js_parse_float(s: &str) -> f64 {
    let b = s.as_bytes(); let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() { i += 1; }
    let int_end = i; let mut frac = 0;
    if i < b.len() && b[i] == b'.' { let mut j = i + 1; while j < b.len() && b[j].is_ascii_digit() { j += 1; } frac = j - i - 1; if int_end > 0 || frac > 0 { i = j; } }
    if int_end == 0 && frac == 0 { return f64::NAN; }
    s[..i].parse::<f64>().unwrap_or(f64::NAN)
}
pub fn parse_ago_days(t: &str) -> Option<f64> {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let r = R.get_or_init(|| regex::Regex::new(r"(?i-u)([0-9]+)\s+(minute|hour|day|week|month|year)s?\s+ago").unwrap());
    let m = r.captures(t)?;
    let n: f64 = m[1].parse().ok()?;
    let per = match m[2].to_ascii_lowercase().as_str() { "minute" => 1.0 / 1440.0, "hour" => 1.0 / 24.0, "day" => 1.0, "week" => 7.0, "month" => 30.0, _ => 365.0 };
    Some(n * per)
}

pub fn outcome(row: &V) -> f64 {
    let dur = dur_of(row);
    let Some(ws) = row.ws else { return 0.15 };
    if dur <= 0.0 { return 0.15; }
    let r = ws / dur;
    if ws < 1.5 || r < 0.15 { return -1.0; }
    if r < 0.4 { return -0.4; }
    if r < 0.7 { return 0.25; }
    if r < 1.0 { return 0.8; }
    1.2
}
pub fn long_outcome(row: &V) -> f64 {
    let dur = dur_of(row);
    if let Some(ws) = row.ws { if dur > 0.0 {
        let ratio = ws / dur;
        if ws < 3.0 || (dur > 20.0 && ratio < 0.15) { return -3.0 / 6.0; }
        if ratio >= 0.7 || ws >= 25.0 { return 1.0; }
        return 0.5 / 6.0;
    } }
    1.0 / 6.0
}

#[derive(Clone, Debug)]
pub struct Row { pub v: V, pub w: f64, pub o: f64, pub long: bool }
pub fn training_rows(hist: &[V], likes: &[V], dislikes: &[V]) -> Vec<Row> {
    let mut rows = vec![]; let mut si = 0usize;
    for (gi, v) in hist.iter().enumerate() {
        if is_short(v) {
            let i = si; si += 1;
            let o = outcome(v);
            rows.push(Row { v: v.clone(), w: o * (1.0 / (1.0 + i as f64 / 10.0)) * (if i < 8 { 2.0 } else { 1.0 }), o, long: false });
        } else {
            let o = long_outcome(v);
            rows.push(Row { v: v.clone(), w: o * (1.0 / (1.0 + gi as f64 / 6.0)), o, long: true });
        }
    }
    for (i, v) in likes.iter().enumerate() {
        rows.push(if is_short(v) { Row { v: v.clone(), w: 1.5 / (1.0 + i as f64 / 12.0), o: 1.5, long: false } } else { Row { v: v.clone(), w: 1.0 / (1.0 + i as f64 / 8.0), o: 1.0, long: true } });
    }
    for (i, v) in dislikes.iter().enumerate() { rows.push(Row { v: v.clone(), w: -2.0 / (1.0 + i as f64 / 12.0), o: -1.0, long: !is_short(v) }); }
    rows
}

                                 
#[derive(Clone, Debug, Default)]
pub struct OMap { pub keys: Vec<String>, pub m: HashMap<String, f64> }
impl OMap {
    pub fn get(&self, k: &str) -> Option<f64> { self.m.get(k).copied() }
    pub fn add(&mut self, k: &str, d: f64) { match self.m.get_mut(k) { Some(x) => *x = truthy_num(Some(*x)) + d, None => { self.keys.push(k.to_string()); self.m.insert(k.to_string(), 0.0 + d); } } }
    pub fn entries(&self) -> Vec<(String, f64)> { self.keys.iter().map(|k| (k.clone(), self.m[k])).collect() }
}
#[derive(Clone, Debug)]
pub struct Profile { pub topic: OMap, pub topic_n: OMap, pub chan: OMap, pub chan_n: OMap, pub pref_dur: Option<f64>, pub exposures: usize }
fn uniq(v: Vec<String>) -> Vec<String> { let mut s = HashSet::new(); v.into_iter().filter(|x| s.insert(x.clone())).collect() }
pub struct Sub { pub name: String }
pub fn build_profile(rows: &[Row], subs: &[Sub]) -> Profile {
    let (mut topic, mut topic_n, mut chan, mut chan_n) = (OMap::default(), OMap::default(), OMap::default(), OMap::default());
    let (mut dur_w, mut dur_sum) = (0.0f64, 0.0f64);
    for Row { v, w, o, .. } in rows {
        for t in uniq(words(&v.title)) { topic.add(&t, *w); topic_n.add(&t, 1.0); }
        let c = super::js_trim(&v.channel);
        if !c.is_empty() { chan.add(c, *o); chan_n.add(c, 1.0); }
        if *o > 0.2 && is_short(v) { let d = truthy_num(v.secs.or_else(|| parse_secs(&v.duration))); if d != 0.0 { dur_w += o; dur_sum += o * d; } }
    }
    for s in subs { let c = super::js_trim(&s.name); if !c.is_empty() { chan.add(c, 3.0); chan_n.add(c, 1.0); } }
    Profile { topic, topic_n, chan, chan_n, pref_dur: if dur_w > 1.0 { Some(dur_sum / dur_w) } else { None }, exposures: rows.len() }
}

pub type Emb<'a> = &'a dyn Fn(&str) -> Option<Vec<f64>>;
fn cos(a: &[f64], b: &[f64]) -> f64 { let mut s = 0.0; for i in 0..a.len() { s += a[i] * b.get(i).copied().unwrap_or(f64::NAN); } s }
pub fn short_centroid(rows: &[Row], embed: Option<Emb>) -> Option<Vec<f64>> {
    let embed = embed?;
    let mut acc: Option<Vec<f64>> = None; let mut str_ = 0.0;
    for Row { v, w, .. } in rows {
        let Some(e) = embed(&v.id) else { continue };
        let a = acc.get_or_insert_with(|| vec![0.0; e.len()]);
        let k = if *w > 0.0 { *w } else { *w * 0.5 };
        for d in 0..e.len() { if d < a.len() { a[d] += k * e[d]; } }
        if *w > 0.0 { str_ += w; }
    }
    let acc = acc?;
    if str_ < 1.5 { return None; }
    let mut n = 0.0; for x in &acc { n += x * x; }
    let n = n.sqrt(); let n = if n == 0.0 || n.is_nan() { 1.0 } else { n };
    Some(acc.iter().map(|x| x / n).collect())
}

fn desc_sort(mut v: Vec<(String, f64)>) -> Vec<(String, f64)> { v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)); v }
pub fn shorts_seeds(p: &Profile, n: usize, rng: &mut dyn FnMut() -> f64) -> Vec<String> {
    let pos = desc_sort(p.topic.entries().into_iter().filter(|(_, w)| *w > 0.4).collect());
    let chans: Vec<String> = desc_sort(p.chan.entries().into_iter().filter(|(_, w)| *w > 0.8).collect()).into_iter().map(|x| x.0).collect();
    let mut out: Vec<String> = vec![];
    for i in 0..2 { if let Some(c) = chans.get((n + i) % chans.len().max(1)) { out.push(format!("{c} shorts")); } }
    let head: Vec<&String> = pos.iter().take(6).map(|x| &x.0).collect();
    if !head.is_empty() { out.push(format!("{} shorts", head[n % head.len()])); }
    if head.len() > 1 { out.push(format!("{} {} shorts", head[0], head[1 + (n % (head.len() - 1))])); }
    let tail: Vec<&String> = pos.iter().skip(6).take(24).map(|x| &x.0).collect();
    if !tail.is_empty() { out.push(format!("{} shorts", tail[(rng() * tail.len() as f64).floor() as usize])); }
    let gen = ["funny shorts", "satisfying shorts", "skill shorts", "animals shorts", "cooking shorts", "science shorts", "gaming shorts", "music shorts"];
    out.push(gen[(n + (rng() * 8.0).floor() as usize) % 8].to_string());
    uniq(out).into_iter().take(6).collect()
}

fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) } }
fn jmin(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) } }
pub struct Scored { pub total: f64, pub novel: bool }
pub fn score_short(v: &V, p: &Profile, taste: Option<&[f64]>, embed: Option<Emb>, rng: &mut dyn FnMut() -> f64, explore: bool) -> Scored {
    let (mut tw, mut seen_words) = (0.0f64, 0usize);
    for t in uniq(words(&format!("{} {}", v.title, js_slice16(&v.desc, 160)))) {
        if let Some(w) = p.topic.get(&t) { tw += w / (1.0 + p.topic_n.get(&t).unwrap_or(0.0)).sqrt(); seen_words += 1; }
    }
    let f_topic = 60.0 * (tw / 3.0).tanh();
    let mut f_embed = 0.0;
    if let (Some(t), Some(em)) = (taste, embed) { if let Some(e) = em(&v.id) { f_embed = jmax(-60.0, jmin(90.0, (cos(&e, t) - 0.08) * 330.0)); } }
    let c = super::js_trim(&v.channel);
    let cn = p.chan_n.get(c).unwrap_or(0.0);
    let f_chan = if cn != 0.0 { 28.0 * (truthy_num(p.chan.get(c)) / (cn + 2.0)) } else { 0.0 };
    let d = v.secs;
    let mut f_dur = match (p.pref_dur, d) { (Some(pd), Some(dv)) if pd != 0.0 && dv != 0.0 => -14.0 * jmin(1.0, (dv - pd).abs() / jmax(15.0, pd)), _ => 0.0 };
    if let Some(dv) = d { if dv < 6.0 { f_dur -= 10.0; } }
    let age = parse_ago_days(&v.published);
    let f_fresh = match age { None => 0.0, Some(a) => if a <= 1.0 { 12.0 } else if a <= 7.0 { 8.0 } else if a <= 30.0 { 3.0 } else if a > 365.0 { -4.0 } else { 0.0 } };
    let vw = parse_views(&v.views);
    let f_pop = if vw > 0.0 { jmin(14.0, vw.log10() * 2.0) } else { 0.0 };
    let f_vel = match age { Some(a) if vw > 0.0 => jmin(8.0, (1.0 + vw / jmax(a, 0.5)).log10() * 1.6), _ => 0.0 };
    let f_bait = if bait().is_match(&v.title) && f_topic <= 0.0 { -30.0 } else { 0.0 };
    let f_explore = if explore && seen_words == 0 { 10.0 } else { 0.0 };
    let f_jitter = if explore { rng() * 4.0 } else { 0.0 };
    let mut total = f_topic;
    for x in [f_embed, f_chan, f_dur, f_fresh, f_pop, f_vel, f_bait, f_explore, f_jitter] { total += x; }
    Scored { total, novel: seen_words == 0 && !(cn > 0.0) }
}

fn jacc(a: &HashSet<String>, b: &HashSet<String>) -> f64 { let i = a.iter().filter(|x| b.contains(*x)).count(); let u = a.len() + b.len() - i; if u != 0 { i as f64 / u as f64 } else { 0.0 } }

pub struct State<'a> { pub hist: &'a [V], pub likes: &'a [V], pub dislikes: &'a [V], pub subs: &'a [Sub], pub dead: &'a HashSet<String>, pub served: &'a HashSet<String> }
pub struct Opts<'a> { pub embed: Option<Emb<'a>>, pub limit: usize, pub explore_frac: f64, pub per_chan: usize, pub lambda: f64 }
impl<'a> Default for Opts<'a> { fn default() -> Self { Opts { embed: None, limit: 14, explore_frac: 0.2, per_chan: 2, lambda: 28.0 } } }

#[derive(Clone)]
struct Cand { idx: usize, v: V, s: f64, novel: bool, set: HashSet<String>, e: Option<Vec<f64>> }
pub fn rank_shorts(cands: &[V], st: &State, o: &Opts, rng: &mut dyn FnMut() -> f64) -> Vec<(V, f64)> {
    let explore = o.explore_frac > 0.0;
    let rows = training_rows(st.hist, st.likes, st.dislikes);
    let p = build_profile(&rows, st.subs);
    let taste = short_centroid(&rows, o.embed);
    let seen: HashSet<&str> = st.hist.iter().chain(st.likes).chain(st.dislikes).map(|v| v.id.as_str()).collect();
    let mut pool: Vec<Cand> = vec![]; let mut dup: HashSet<String> = HashSet::new();
    for v in cands {
        if v.id.is_empty() || dup.contains(&v.id) || seen.contains(v.id.as_str()) || st.dead.contains(&v.id) || st.served.contains(&v.id) { continue; }
        let Some(secs) = v.secs.or_else(|| parse_secs(&v.duration)) else { continue };
        if secs > SHORT_MAX { continue; }
        dup.insert(v.id.clone());
        let mut w = v.clone(); w.secs = Some(secs);
        let sc = score_short(&w, &p, taste.as_deref(), o.embed, rng, explore);
        if sc.total < -25.0 { continue; }
        let set: HashSet<String> = words(&w.title).into_iter().collect();
        let e = o.embed.and_then(|f| f(&w.id));
        let idx = pool.len();
        pool.push(Cand { idx, v: w, s: sc.total, novel: sc.novel, set, e });
    }
    pool.sort_by(|a, b| b.s.partial_cmp(&a.s).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Cand> = vec![]; let mut chan_count: HashMap<String, usize> = HashMap::new();
    let n_explore = if o.explore_frac <= 0.0 { 0 } else if p.exposures < 8 { (o.limit as f64 * jmax(0.4, o.explore_frac)).ceil() as usize } else { js_round(o.limit as f64 * o.explore_frac) as usize };
    let exploit_n = o.limit.saturating_sub(n_explore);
    let sim_to = |x: &Cand, y: &Cand| match (&x.e, &y.e) { (Some(a), Some(b)) => jmax(0.0, cos(a, b)), _ => jacc(&x.set, &y.set) };
    macro_rules! take { ($c:expr) => {{ let c: Cand = $c; *chan_count.entry(c.v.channel.clone()).or_insert(0) += 1; if let Some(p) = pool.iter().position(|x| x.idx == c.idx) { pool.remove(p); } out.push(c); }} }
    while out.len() < exploit_n && !pool.is_empty() {
        let mut best: Option<Cand> = None; let mut bs = f64::NEG_INFINITY;
        for c in &pool {
            if chan_count.get(&c.v.channel).copied().unwrap_or(0) >= o.per_chan { continue; }
            let mut red = 0.0; for x in &out { red = jmax(red, sim_to(c, x)); }
            let sc = c.s - o.lambda * red * 3.0;
            if sc > bs { bs = sc; best = Some(c.clone()); }
        }
        let Some(b) = best else { break };
        take!(b);
    }
    let mut novel: Vec<Cand> = if !explore { vec![] } else {
        let mut n: Vec<Cand> = pool.iter().filter(|c| c.novel && c.s > -5.0).cloned().collect();
        n.sort_by(|a, b| b.s.partial_cmp(&a.s).unwrap_or(std::cmp::Ordering::Equal)); n.truncate(12); n };
    while out.len() < o.limit && !novel.is_empty() {
        let i = (rng() * novel.len() as f64).floor() as usize;
        let c = novel.remove(i);
        if chan_count.get(&c.v.channel).copied().unwrap_or(0) >= o.per_chan { continue; }
        take!(c);
    }
    for c in pool.clone() { if out.len() >= o.limit { break; } if chan_count.get(&c.v.channel).copied().unwrap_or(0) < o.per_chan { take!(c); } }
    let seq = out.clone();
    let explored: Vec<Cand> = if explore { seq.iter().filter(|c| c.novel).cloned().collect() } else { vec![] };
    let mut core: std::collections::VecDeque<Cand> = if explore { seq.iter().filter(|c| !c.novel).cloned().collect() } else { seq.iter().cloned().collect() };
    let mut fin: Vec<Cand> = vec![]; let mut ei = 0;
    for i in 0..seq.len() {
        if (i == 2 || i == 6 || i == 10) && ei < explored.len() { fin.push(explored[ei].clone()); ei += 1; }
        else if let Some(c) = core.pop_front() { fin.push(c); }
        else if ei < explored.len() { fin.push(explored[ei].clone()); ei += 1; }
    }
    while ei < explored.len() { fin.push(explored[ei].clone()); ei += 1; }
    for i in 1..fin.len() {
        if !fin[i].v.channel.is_empty() && fin[i].v.channel == fin[i - 1].v.channel {
            let prev = fin[i - 1].v.channel.clone();
            if let Some(j) = fin.iter().enumerate().position(|(k, c)| k > i && c.v.channel != prev) { if j > 0 { fin.swap(i, j); } }
        }
    }
    fin.into_iter().map(|c| (c.v, c.s)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }
    fn v_of(x: &Value) -> V {
        V { id: s(x, "id"), title: s(x, "title"), channel: s(x, "channel"), channel_id: s(x, "channelId"), duration: s(x, "duration"), views: s(x, "views"),
            published: s(x, "published"), desc: s(x, "desc"), secs: x.get("secs").and_then(|n| n.as_f64()), ws: x.get("ws").and_then(|n| n.as_f64()) }                                                             
    }
    fn vs(x: &Value) -> Vec<V> { x.as_array().unwrap().iter().map(v_of).collect() }
    fn close(a: f64, b: f64) -> bool { a == b || (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1e-12) }
    fn jf(x: &Value) -> f64 { x.as_f64().unwrap_or(f64::NAN) }
    fn script(rv: &[f64]) -> impl FnMut() -> f64 + '_ { let mut i = 0; move || { let v = rv[i % rv.len()]; i += 1; v } }
    fn omap_eq(m: &OMap, want: &Value, what: &str) {
        let w = want.as_array().unwrap();
        assert_eq!(m.keys.len(), w.len(), "{what} len");
        for (k, p) in m.keys.iter().zip(w) { assert_eq!(k, p[0].as_str().unwrap(), "{what} key order"); assert!(close(m.m[k], jf(&p[1])), "{what} {k}: {} vs {}", m.m[k], p[1]); }
    }

                                                                                                     
                                                                                                      
                                                                                        
    #[test]
    fn shorts_rank_matches_real_r32_differential() {
                                                                              
                                                                                       
        let gp = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/apps/jetstream_rank_golden.json");
        let Ok(text) = std::fs::read_to_string(&gp) else { eprintln!("SKIP shorts_rank_matches_real_r32_differential: {} not delivered yet", gp.display()); return; };
        let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
        let mut ranked_total = 0;
        for (ci, c) in cases.iter().enumerate() {
            let (hist, likes, dislikes, cands) = (vs(&c["hist"]), vs(&c["likes"]), vs(&c["dislikes"]), vs(&c["cands"]));
            let subs: Vec<Sub> = c["subs"].as_array().unwrap().iter().map(|x| Sub { name: s(x, "name") }).collect();
            let dead: HashSet<String> = c["dead"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            let served: HashSet<String> = c["served"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            let rv: Vec<f64> = c["rv"].as_array().unwrap().iter().map(jf).collect();
            let emb: Option<HashMap<String, Vec<f64>>> = c["emb"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_array().unwrap().iter().map(jf).collect())).collect());
            let embf = |id: &str| emb.as_ref().and_then(|m| m.get(id).cloned());
            let embed: Option<Emb> = if emb.is_some() { Some(&embf) } else { None };
            let e = &c["exp"];
            let rows = training_rows(&hist, &likes, &dislikes);
            let wr = e["rows"].as_array().unwrap();
            assert_eq!(rows.len(), wr.len(), "case {ci} rows");
            for (r, w) in rows.iter().zip(wr) { assert_eq!(r.v.id, w["id"].as_str().unwrap()); assert!(close(r.w, jf(&w["w"])) && close(r.o, jf(&w["o"])) && r.long == w["long"].as_bool().unwrap(), "case {ci} row {}", r.v.id); }
            let p = build_profile(&rows, &subs);
            let wp = &e["profile"];
            omap_eq(&p.topic, &wp["topic"], "topic"); omap_eq(&p.topic_n, &wp["topicN"], "topicN"); omap_eq(&p.chan, &wp["chan"], "chan"); omap_eq(&p.chan_n, &wp["chanN"], "chanN");
            assert_eq!(p.exposures as i64, wp["exposures"].as_i64().unwrap());
            match (&p.pref_dur, wp["prefDur"].as_f64()) { (Some(a), Some(b)) => assert!(close(*a, b), "case {ci} prefDur"), (None, None) => {}, (a, b) => panic!("case {ci} prefDur {a:?} vs {b:?}") }
            let cen = short_centroid(&rows, embed);
            match (&cen, e["centroid"].as_array()) {
                (Some(a), Some(b)) => { assert_eq!(a.len(), b.len()); for (x, y) in a.iter().zip(b) { assert!(close(*x, jf(y)), "case {ci} centroid"); } }
                (None, None) => {}, _ => panic!("case {ci} centroid presence"),
            }
            for (k, n) in [0usize, 1, 2, 5].iter().enumerate() {
                let mut r = script(&rv);
                let got = shorts_seeds(&p, *n, &mut r);
                let want: Vec<&str> = e["seeds"][k].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
                assert_eq!(got, want, "case {ci} seeds n={n}");
            }
            for (k, v) in cands.iter().take(6).enumerate() {
                let mut w = v.clone(); w.secs = v.secs.or_else(|| parse_secs(&v.duration));
                let mut r = script(&rv);
                let sc = score_short(&w, &p, cen.as_deref(), embed, &mut r, true);
                let next = r();
                let ws = &e["scores"][k];
                assert!(close(sc.total, jf(&ws["total"])), "case {ci} score {k}: {} vs {}", sc.total, ws["total"]);
                assert_eq!(sc.novel, ws["novel"].as_bool().unwrap(), "case {ci} novel {k}");
                assert!(close(next, jf(&ws["next"])), "case {ci} rng draw count after scoreShort {k}");                           
            }
            let st = State { hist: &hist, likes: &likes, dislikes: &dislikes, subs: &subs, dead: &dead, served: &served };
            let o = Opts { embed, limit: c["opts"]["limit"].as_u64().unwrap() as usize, explore_frac: jf(&c["opts"]["exploreFrac"]), per_chan: c["opts"]["perChan"].as_u64().unwrap() as usize, lambda: 28.0 };
            let mut r = script(&rv);
            let got = rank_shorts(&cands, &st, &o, &mut r);
            let want = e["rank"].as_array().unwrap();
            assert_eq!(got.iter().map(|x| x.0.id.as_str()).collect::<Vec<_>>(), want.iter().map(|x| x["id"].as_str().unwrap()).collect::<Vec<_>>(), "case {ci} rank order");
            for ((_, sc), w) in got.iter().zip(want) { assert!(close(*sc, jf(&w["score"])), "case {ci} rank score"); }
            ranked_total += got.len();
        }
        assert!(ranked_total > 250);
    }

                                                                                                        
                                                                                                
    #[test]
    fn qa_shorts_rank_goldens() {
                                                                                             
                                                                                            
        let gp = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/apps/jetstream_rank_qa_golden.json");
        let Ok(text) = std::fs::read_to_string(&gp) else { eprintln!("SKIP qa_shorts_rank_goldens: {} not delivered yet", gp.display()); return; };
        let g: Value = serde_json::from_str(&text).unwrap();
        let rngv: Vec<f64> = g["rngScript"].as_array().unwrap().iter().map(jf).collect();
        let vv = |n: i32, f: &dyn Fn(&mut V)| { let mut v = V { id: format!("s{:010}", n), title: format!("t{n}"), duration: "0:30".into(), ..Default::default() }; f(&mut v); v };
        let hist = vec![
            vv(1, &|v| { v.title = "Funny cats jumping".into(); v.channel = "CatCo".into(); v.ws = Some(30.0); v.secs = Some(30.0); }),
            vv(2, &|v| { v.title = "Long cooking tutorial".into(); v.channel = "Chef".into(); v.secs = Some(900.0); v.duration = "15:00".into(); v.ws = Some(700.0); }),
            vv(3, &|v| { v.title = "Skipped prank video".into(); v.channel = "Prank".into(); v.ws = Some(1.0); }),
            vv(4, &|v| { v.title = "Funny dogs".into(); v.channel = "CatCo".into(); v.ws = Some(20.0); }),
            vv(5, &|v| { v.title = "No telemetry short".into(); v.channel = "X".into(); })];
        let likes = vec![vv(6, &|v| { v.title = "Liked science short".into(); v.channel = "Sci".into(); }), vv(7, &|v| { v.title = "Liked long".into(); v.secs = Some(700.0); v.duration = "11:40".into(); v.channel = "Chef".into(); })];
        let dislikes = vec![vv(8, &|v| { v.title = "Disliked prank clip".into(); v.channel = "Prank".into(); })];
        let subs = vec![Sub { name: "CatCo".into() }, Sub { name: "  ".into() }];
        let rows = training_rows(&hist, &likes, &dislikes);
        let p = build_profile(&rows, &subs);
        let cs = vec![
            vv(20, &|v| { v.title = "Funny cats again".into(); v.channel = "CatCo".into(); v.published = "2 hours ago".into(); v.views = "1.2M views".into(); v.secs = Some(25.0); }),
            vv(21, &|v| { v.title = "Tiktok compilation fails".into(); v.channel = "Meh".into(); v.published = "3 years ago".into(); v.views = "900 views".into(); v.secs = Some(40.0); }),
            vv(22, &|v| { v.title = "Quantum bridges explained".into(); v.channel = "New".into(); v.published = "5 days ago".into(); v.views = "12K views".into(); v.secs = Some(55.0); }),
            vv(23, &|v| { v.title = "tiny".into(); v.channel = "New".into(); v.secs = Some(4.0); }),
            vv(24, &|v| { v.title = "Prank gone wrong".into(); v.channel = "Prank".into(); v.secs = Some(30.0); v.published = "1 day ago".into(); v.views = "5M views".into(); })];
        let mut cands = cs.clone();
        cands.push(vv(30, &|v| { v.title = "Dup of cat".into(); v.channel = "CatCo".into(); v.secs = Some(20.0); v.duration = "0:20".into(); }));
        cands.push(vv(1, &|v| { v.title = "already in hist".into(); v.channel = "CatCo".into(); v.secs = Some(20.0); }));
        cands.push(vv(31, &|v| { v.title = "long one".into(); v.duration = "5:00".into(); }));
        cands.push(vv(32, &|v| { v.title = "no dur".into(); v.duration = "".into(); }));
        cands.push(V { title: "no id".into(), ..Default::default() });
        cands.push(vv(20, &|v| { v.title = "dup id".into(); }));
        let dead: HashSet<String> = ["s0000000022".to_string()].into(); let none = HashSet::new();
        let many: Vec<V> = (0..40).map(|i| vv(100 + i, &|v| { v.title = format!("word{}ish topic{}x clip", i % 7, i % 5); v.channel = format!("C{}", i % 4); v.secs = Some((10 + i % 50) as f64); v.published = format!("{} days ago", 1 + i % 9); v.views = format!("{}K views", (i + 1) * 37); })).collect();
        let mut seeds_n = 0; let mut scores = 0; let mut ranks = 0; let mut prim = 0;
        for c in g["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap(); let inp = &c["input"]; let ex = &c["expect"];
            match name {
                "parseSecs" => { let t = inp.as_str().unwrap(); let r = parse_secs(t); match ex.as_f64() { Some(x) => assert_eq!(r, Some(x), "parseSecs {t:?}"), None => assert_eq!(r, None, "parseSecs {t:?}") } prim += 1; }
                "parseViews" => { assert!(close(parse_views(inp.as_str().unwrap()), jf(ex)), "parseViews {inp}"); prim += 1; }
                "parseAgoDays" => { let r = parse_ago_days(inp.as_str().unwrap()); match ex.as_f64() { Some(x) => assert!(close(r.unwrap(), x), "ago {inp}"), None => assert!(r.is_none(), "ago {inp}") } prim += 1; }
                "words" => { let w: Vec<String> = ex.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect(); assert_eq!(words(inp.as_str().unwrap()), w, "words {inp}"); prim += 1; }
                "outcome" | "longOutcome" => {
                    let mut v = V { secs: inp.get("secs").and_then(|x| x.as_f64()), ws: inp.get("ws").and_then(|x| x.as_f64()), duration: s(inp, "duration"), ..Default::default() };
                    if inp.get("secs").is_none() { v.secs = None; }
                    let r = if name == "outcome" { outcome(&v) } else { long_outcome(&v) };
                    assert!(close(r, jf(ex)), "{name} {inp}: {r} vs {ex}"); prim += 1;
                }
                "trainingRows" => { let w = ex.as_array().unwrap(); assert_eq!(rows.len(), w.len()); for (r, x) in rows.iter().zip(w) { assert_eq!(r.v.id, x["id"].as_str().unwrap()); assert!(close(r.w, jf(&x["w"])) && close(r.o, jf(&x["o"])) && r.long == x["long"].as_bool().unwrap(), "row {}", r.v.id); } prim += 1; }
                "buildProfile" => { omap_eq(&p.topic, &ex["topic"], "topic"); omap_eq(&p.topic_n, &ex["topicN"], "topicN"); omap_eq(&p.chan, &ex["chan"], "chan"); omap_eq(&p.chan_n, &ex["chanN"], "chanN"); assert_eq!(p.exposures as i64, ex["exposures"].as_i64().unwrap()); match (p.pref_dur, ex["prefDur"].as_f64()) { (Some(a), Some(b)) => assert!(close(a, b)), (None, None) => {}, _ => panic!("prefDur") } prim += 1; }
                "shortsSeeds" => { let mut r = script(&rngv); let got = shorts_seeds(&p, inp["n"].as_u64().unwrap() as usize, &mut r); let w: Vec<&str> = ex.as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect(); assert_eq!(got, w, "seeds {inp}"); seeds_n += 1; }
                n if n.starts_with("scoreShort") => {
                    let id = inp["id"].as_str().unwrap(); let v = cs.iter().find(|x| x.id == id).unwrap();
                    let explore = n.contains("explore=true"); let mut r05 = || 0.5;
                    let sc = score_short(v, &p, None, None, &mut r05, explore);
                    assert!(close(sc.total, jf(&ex["total"])), "{n} {id}: {} vs {}", sc.total, ex["total"]); assert_eq!(sc.novel, ex["novel"].as_bool().unwrap(), "{n} novel"); scores += 1;
                }
                n if n.starts_with("rankShorts") => {
                    let (cs_, st_hist, o): (&Vec<V>, bool, Opts) = if n.contains("40 cands") { (&many, false, Opts { limit: 14, explore_frac: if n.contains("exploit") { 0.0 } else { 0.2 }, ..Default::default() }) }
                        else if n.contains("query") { (&cands, true, Opts { limit: 5, explore_frac: 0.0, ..Default::default() }) } else { (&cands, true, Opts { limit: 5, ..Default::default() }) };
                    let empty: Vec<V> = vec![]; let nos: Vec<Sub> = vec![];
                    let st = if st_hist { State { hist: &hist, likes: &likes, dislikes: &dislikes, subs: &subs, dead: &dead, served: &none } } else { State { hist: &empty, likes: &empty, dislikes: &empty, subs: &nos, dead: &none, served: &none } };
                    let mut r = script(&rngv);
                    let got = rank_shorts(cs_, &st, &o, &mut r);
                    let w = ex.as_array().unwrap();
                    assert_eq!(got.iter().map(|x| x.0.id.as_str()).collect::<Vec<_>>(), w.iter().map(|x| x["id"].as_str().unwrap()).collect::<Vec<_>>(), "{n} order");
                    for ((_, sc), x) in got.iter().zip(w) { assert!(close(*sc, jf(&x["score"])), "{n} score"); } ranks += 1;
                }
                other => panic!("unhandled QA case {other}"),
            }
        }
        assert_eq!((prim, seeds_n, scores, ranks), (68, 4, 7, 4));
    }
}
