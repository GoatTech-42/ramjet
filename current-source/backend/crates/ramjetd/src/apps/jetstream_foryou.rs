                                                                                                        
                                                                                               
                                                                                                                 
use std::collections::{HashMap, HashSet};
use super::jetstream::parse_secs;
use super::jetstream_rank::{parse_ago_days, parse_views, OMap, V};

const STOPWORDS: &str = "the and for with that this from your you are was were have has had not but all can will its his her she him they them their our out about into over after before between under again once here there when where why how what which who whom been being both each few more most other some such only own same than too very just challenge challenges tiktok viral viralvideo ytshorts shorts short video videos youtube reels fyp foryou trending compilation bigbank goon gyatt feat wait till end";
fn stopw() -> &'static HashSet<&'static str> { static S: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new(); S.get_or_init(|| STOPWORDS.split(' ').collect()) }
fn bait() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"(?i)tik ?tok|compilation|try not to|you won[^\n\r\x{2028}\x{2029}]?t believe|gone wrong|#shorts|(?-u:\b)fails?(?-u:\b)|top [0-9]+ |(?-u:\b)pranks?(?-u:\b)|(?-u:\b)reacts? to(?-u:\b)").unwrap())
}

fn split_words(t: &str) -> Vec<String> { t.to_lowercase().split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|w| !w.is_empty()).map(String::from).collect() }
fn nz(x: Option<f64>) -> f64 { match x { Some(n) if n != 0.0 && !n.is_nan() => n, _ => 0.0 } }
fn dur_of(v: &V) -> f64 { let a = nz(v.secs); if a != 0.0 { a } else { nz(parse_secs(&v.duration)) } }
fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) } }
fn jmin(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) } }

pub struct Profile { pub chan: OMap, pub words: OMap }
fn fold(p: &mut Profile, channel: &str, title: &str, w: f64) {
    if w == 0.0 { return; }
    let c = super::js_trim(channel);
    if !c.is_empty() { p.chan.add(c, w * 0.4); }
    for word in split_words(title) { if word.len() < 4 || stopw().contains(word.as_str()) { continue; } p.words.add(&word, w); }
}
pub struct SubName(pub String);
pub fn hist_profile(hist: &[V], likes: &[V], subs: &[SubName]) -> Profile {
    let mut p = Profile { chan: OMap::default(), words: OMap::default() };
    for (i, v) in hist.iter().enumerate() {
        let rec = 1.0 / (1.0 + i as f64 / 6.0);
        let dur = dur_of(v);
        if let (Some(ws), true) = (v.ws, dur > 0.0) {
            let ratio = ws / dur;
            let w = if ws < 3.0 || (dur > 20.0 && ratio < 0.15) { -3.0 * rec } else if ratio >= 0.7 || ws >= 25.0 { 6.0 * rec } else { 0.5 * rec };
            fold(&mut p, &v.channel, &v.title, w); continue;
        }
        fold(&mut p, &v.channel, &v.title, rec);
    }
    for (i, v) in likes.iter().enumerate() { fold(&mut p, &v.channel, &v.title, 6.0 / (1.0 + i as f64 / 8.0)); }
    for s in subs { fold(&mut p, &s.0, "", 10.0); }
    p
}
pub fn chan_word_profile(list: &[V]) -> Profile {
    let mut p = Profile { chan: OMap::default(), words: OMap::default() };
    for v in list {
        let c = super::js_trim(&v.channel);
        if !c.is_empty() { p.chan.add(c, 1.0); }
        for w in split_words(&v.title) { if w.len() < 4 || stopw().contains(w.as_str()) { continue; } p.words.add(&w, 1.0); }
    }
    p
}
fn top(m: &OMap, thr: f64, n: usize) -> Vec<String> {
    let mut e: Vec<(String, f64)> = m.entries().into_iter().filter(|(_, w)| *w > thr).collect();
    e.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    e.into_iter().take(n).map(|x| x.0).collect()
}
pub fn rec_seeds(p: &Profile, n: usize) -> Vec<String> {
    let chans = top(&p.chan, 0.5, 5); let kws = top(&p.words, 0.5, 5);
    let mut all: Vec<String> = vec![];
    for i in 0..5 {
        if let Some(c) = chans.get(i) { all.push(c.clone()); }
        if kws.len() == 1 && i == 0 { all.push(kws[0].clone()); }
        else if kws.len() > 1 && i == 0 { all.push(kws.join(" ")); }
        else if let Some(k) = kws.get(i) { all.push(k.clone()); }
    }
    all.push("trending now".into()); all.push("viral clips".into());
    if all.len() <= 4 { return all; }
    (0..4).map(|i| all[(n + i) % all.len()].clone()).collect()
}

                               
#[derive(Clone, Debug, Default)]
pub struct Meta { pub t: String, pub tags: Vec<String>, pub desc: String, pub cat: String }
pub type MetaMap = HashMap<String, Meta>;
fn tok(t: &str) -> Vec<String> { split_words(t).into_iter().filter(|w| w.len() >= 3 && !stopw().contains(w.as_str())).collect() }
fn doc_terms(title: &str, tags: &[String], desc: &str, cat: &str) -> Vec<(String, f64)> {
    let mut keys: Vec<String> = vec![]; let mut tf: HashMap<String, f64> = HashMap::new();
    let mut add = |words: Vec<String>, w: f64| for t in words { match tf.get_mut(&t) { Some(x) => *x += w, None => { keys.push(t.clone()); tf.insert(t, w); } } };
    add(tok(title), 3.0);
    add(tags.iter().flat_map(|t| tok(t)).collect(), 2.0);
    add(tok(cat), 2.0);
    add(tok(&super::js_slice16(desc, 600)), 1.0);
    keys.into_iter().map(|k| { let v = tf[&k]; (k, v) }).collect()
}
pub struct Idf { m: HashMap<String, f64>, n: f64 }
pub fn build_idf(meta: &MetaMap) -> Idf {
    let mut df: HashMap<String, f64> = HashMap::new();
    for d in meta.values() { for (t, _) in doc_terms(&d.t, &d.tags, &d.desc, "") { *df.entry(t).or_insert(0.0) += 1.0; } }
    let n = (meta.len() as f64).max(50.0);
    Idf { m: df.into_iter().map(|(t, c)| (t, (1.0 + n / c).ln())).collect(), n }
}
pub type Vecm = Vec<(String, f64)>;                                     
pub fn doc_vec(idf: &Idf, title: &str, tags: &[String], desc: &str, cat: &str) -> Vecm {
    let tf = doc_terms(title, tags, desc, cat);
    let fresh = (1.0 + idf.n).ln();
    let mut v: Vecm = vec![]; let mut norm = 0.0;
    for (t, f) in tf { let w = (1.0 + f.ln()) * idf.m.get(&t).copied().filter(|x| *x != 0.0).unwrap_or(fresh); norm += w * w; v.push((t, w)); }
    let norm = norm.sqrt(); let norm = if norm == 0.0 || norm.is_nan() { 1.0 } else { norm };
    v.into_iter().map(|(t, w)| (t, w / norm)).collect()
}
pub fn cosine(a: &Vecm, b: &HashMap<String, f64>) -> f64 { let mut s = 0.0; for (t, w) in a { if let Some(u) = b.get(t) { if *u != 0.0 { s += w * u; } } } s }

pub struct Taste { pub vec: HashMap<String, f64>, pub strength: f64, pub evec: Option<Vec<f64>>, pub estrength: f64 }
pub fn taste_centroid(hist: &[V], likes: &[V], meta: &MetaMap, emb: &HashMap<String, Vec<f64>>, idf: &Idf) -> Taste {
    let mut eacc = vec![0.0f64; 384]; let mut estrength = 0.0;
    let mut keys: Vec<String> = vec![]; let mut acc: HashMap<String, f64> = HashMap::new();
    let mut strength = 0.0;
    let mut add_emb = |id: &str, w: f64, eacc: &mut Vec<f64>, estrength: &mut f64| {
        let Some(e) = emb.get(id) else { return };
        for d in 0..384 { eacc[d] += w * e.get(d).copied().unwrap_or(f64::NAN); }
        if w > 0.0 { *estrength += w; }
    };
    let fields = |v: &V| -> Vecm { match meta.get(&v.id) { Some(m) => doc_vec(idf, &m.t, &m.tags, &m.desc, &m.cat), None => doc_vec(idf, &v.title, &[], "", "") } };
    let mut add_vec = |vec: Vecm, w: f64, keys: &mut Vec<String>, acc: &mut HashMap<String, f64>| for (t, x) in vec { match acc.get_mut(&t) { Some(a) => *a = nz(Some(*a)) + w * x, None => { keys.push(t.clone()); acc.insert(t, 0.0 + w * x); } } };
    for (i, v) in hist.iter().enumerate() {
        let rec = 1.0 / (1.0 + i as f64 / 6.0);
        let dur = dur_of(v);
        let w = if let (Some(ws), true) = (v.ws, dur > 0.0) {
            let ratio = ws / dur;
            if ws < 3.0 || (dur > 20.0 && ratio < 0.15) { -3.0 * rec } else if ratio >= 0.7 || ws >= 25.0 { 6.0 * rec } else { 0.5 * rec }
        } else { rec };
        if w == 0.0 { continue; }
        add_vec(fields(v), w, &mut keys, &mut acc); add_emb(&v.id, w, &mut eacc, &mut estrength);
        if w > 0.0 { strength += w; }
    }
    for (i, v) in likes.iter().enumerate() {
        let w = 6.0 / (1.0 + i as f64 / 8.0);
        add_vec(fields(v), w, &mut keys, &mut acc); add_emb(&v.id, w, &mut eacc, &mut estrength);
        strength += w;
    }
    let mut norm = 0.0; for k in &keys { let x = acc[k]; norm += x * x; }
    let norm = norm.sqrt(); let norm = if norm == 0.0 || norm.is_nan() { 1.0 } else { norm };
    for k in &keys { let x = acc[k]; acc.insert(k.clone(), x / norm); }
    let evec = if estrength > 0.0 {
        let mut en = 0.0; for x in &eacc { en += x * x; }
        let en = en.sqrt(); let en = if en == 0.0 || en.is_nan() { 1.0 } else { en };
        Some(eacc.iter().map(|x| x / en).collect())
    } else { None };
    Taste { vec: acc, strength, evec, estrength }
}
fn cos_arr(a: &[f64], b: &[f64]) -> f64 { let mut s = 0.0; for i in 0..a.len() { s += a[i] * b.get(i).copied().unwrap_or(f64::NAN); } s }

pub struct Cand { pub id: String, pub title: String, pub channel: String, pub channel_id: String, pub duration: String, pub views: String, pub published: String, pub desc: String }
pub fn score_candidate(v: &Cand, p: &Profile, hist_ids: &HashSet<String>, dis: Option<&Profile>, taste: Option<&Taste>, idf: &Idf, emb: &HashMap<String, Vec<f64>>, rng: &mut dyn FnMut() -> f64) -> f64 {
    if hist_ids.contains(&v.id) { return -1.0; }
    let mut s = 0.0;
    let ev = taste.and_then(|t| t.evec.as_ref().and_then(|_| emb.get(&v.id)));
    if let (Some(ev), Some(t)) = (ev, taste.filter(|t| t.estrength > 2.0)) {
        let c = cos_arr(ev, t.evec.as_ref().unwrap());
        s += jmax(-100.0, jmin(200.0, (c - 0.08) * 450.0));
    } else if let Some(t) = taste { if t.strength > 3.0 {
        let c = cosine(&doc_vec(idf, &v.title, &[], &v.desc, ""), &t.vec);
        s += jmax(-100.0, jmin(180.0, c * 400.0));
    } }
    let title_words = split_words(&v.title);
    let mut wsum = 0.0;
    for w in &title_words { if w.len() >= 4 { if let Some(x) = p.words.get(w) { wsum += x; } } }
    s += jmax(-80.0, jmin(140.0, wsum * 12.0));
    if wsum <= 0.0 && bait().is_match(&v.title) { s -= 45.0; }
    let cw = nz(p.chan.get(&v.channel));
    s += jmax(-20.0, jmin(24.0, cw * 4.0));
    if let Some(d) = dis {
        if let Some(c) = d.chan.get(&v.channel) { s -= 40.0 + c * 5.0; }
        let mut o = 0usize; for w in &title_words { if w.len() >= 4 && d.words.get(w).is_some() { o += 1; } }
        s -= (o.min(5) as f64) * 6.0;
    }
    let vw = parse_views(&v.views);
    if vw > 0.0 { s += jmin(10.0, vw.log10()); }
    if let Some(a) = parse_ago_days(&v.published) { s += if a <= 1.0 { 8.0 } else if a <= 7.0 { 5.0 } else if a <= 30.0 { 2.0 } else { 0.0 }; }
    s + rng() * 6.0
}

                                                               
                                                                                                               
                                                                                                             
pub fn lenient_json(text: &str) -> Result<serde_json::Value, String> {
    let b = text.as_bytes(); let mut out = String::with_capacity(text.len()); let mut i = 0; let mut in_str = false;
    let hex4 = |at: usize| -> Option<u32> { if at + 6 <= b.len() && b[at] == b'\\' && b[at + 1] == b'u' { u32::from_str_radix(std::str::from_utf8(&b[at + 2..at + 6]).ok()?, 16).ok() } else { None } };
    while i < b.len() {
        let c = b[i];
        if !in_str { if c == b'"' { in_str = true; } let ch = text[i..].chars().next().unwrap(); out.push(ch); i += ch.len_utf8(); continue; }
        if c == b'"' { in_str = false; out.push('"'); i += 1; continue; }
        if c == b'\\' {
            if let Some(u) = hex4(i) {
                if (0xD800..0xDC00).contains(&u) {
                    if hex4(i + 6).map_or(false, |l| (0xDC00..0xE000).contains(&l)) { out.push_str(&text[i..i + 12]); i += 12; } else { out.push_str("\\uFFFD"); i += 6; }
                    continue;
                }
                if (0xDC00..0xE000).contains(&u) { out.push_str("\\uFFFD"); i += 6; continue; }
                out.push_str(&text[i..i + 6]); i += 6; continue;
            }
                                                                                                             
            out.push('\\'); i += 1; if i < b.len() { let ch = text[i..].chars().next().unwrap(); out.push(ch); i += ch.len_utf8(); }
            continue;
        }
        let ch = text[i..].chars().next().unwrap(); out.push(ch); i += ch.len_utf8();
    }
    serde_json::from_str(&out).map_err(|_| "bad json".to_string())
}
fn js_str(v: Option<&serde_json::Value>, cap: usize) -> String { v.and_then(|x| x.as_str()).map(|s| super::js_slice16(s, cap)).unwrap_or_default() }
pub fn load_meta(v: &serde_json::Value) -> MetaMap {
    let mut m = MetaMap::new();
    if let Some(o) = v.as_object() { for (id, d) in o {
        let tags = d.get("tags").and_then(|t| t.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        m.insert(id.clone(), Meta { t: js_str(d.get("t"), usize::MAX), tags, desc: js_str(d.get("desc"), usize::MAX), cat: js_str(d.get("cat"), usize::MAX) });
    } }
    m
}
                                                                                         
pub fn load_embed(v: &serde_json::Value) -> HashMap<String, Vec<f64>> {
    let mut m = HashMap::new();
    if let Some(o) = v.as_object() { for (id, e) in o { if let Some(a) = e.get("v").and_then(|x| x.as_array()) { m.insert(id.clone(), a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()); } } }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    fn close(a: f64, b: f64) -> bool { a == b || (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1e-12) }
    fn jf(x: &Value) -> f64 { x.as_f64().unwrap_or(f64::NAN) }
    fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }
    fn v_of(x: &Value) -> V { V { id: s(x, "id"), title: s(x, "title"), channel: s(x, "channel"), channel_id: s(x, "channelId"), duration: s(x, "duration"), views: s(x, "views"), published: s(x, "published"), desc: s(x, "desc"), secs: x.get("secs").and_then(|n| n.as_f64()), ws: x.get("ws").and_then(|n| n.as_f64()) } }
    fn vs(x: &Value) -> Vec<V> { x.as_array().unwrap().iter().map(v_of).collect() }
    fn omap_eq(m: &OMap, want: &Value, what: &str) {
        let w = want.as_array().unwrap(); assert_eq!(m.keys.len(), w.len(), "{what} len");
        for (k, p) in m.keys.iter().zip(w) { assert_eq!(k, p[0].as_str().unwrap(), "{what} key order"); assert!(close(m.m[k], jf(&p[1])), "{what} {k}"); }
    }

    #[test]
    fn lenient_loader_handles_lone_surrogates_without_touching_valid_pairs() {
        let raw = r#"{"a":{"t":"x \ud800 y","u":"pair \ud83d\ude00 ok","l":"lone low \udc00 z","e":"esc \\ud800 literal"}}"#;
        assert!(serde_json::from_str::<Value>(raw).is_err());                                 
        let v = lenient_json(raw).unwrap();
        assert_eq!(v["a"]["t"], "x \u{FFFD} y"); assert_eq!(v["a"]["u"], "pair \u{1F600} ok");
        assert_eq!(v["a"]["l"], "lone low \u{FFFD} z"); assert_eq!(v["a"]["e"], "esc \\ud800 literal");
    }

                                                                                                          
                                                                                                             
                                                                                                
    #[test]
    fn for_you_scoring_matches_real_r32_differential() {
        let meta = load_meta(&lenient_json(include_str!("jetstream_foryou_meta.json")).unwrap());
        let emb = load_embed(&lenient_json(include_str!("jetstream_foryou_embed.json")).unwrap());
        assert!(!emb.contains_key("f0000000139") && meta.len() == 90);
        let idf = build_idf(&meta);
                                                                              
                                                                                                
        let gp = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/apps/jetstream_foryou_golden.json");
        let Ok(text) = std::fs::read_to_string(&gp) else { eprintln!("SKIP for_you_scoring_matches_real_r32_differential: {} not delivered yet", gp.display()); return; };
        let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
        let (mut e_branch, mut t_branch) = (0, 0);
        for (ci, c) in cases.iter().enumerate() {
            let (hist, likes, dislikes) = (vs(&c["hist"]), vs(&c["likes"]), vs(&c["dislikes"]));
            let subs: Vec<SubName> = c["subs"].as_array().unwrap().iter().map(|x| SubName(s(x, "name"))).collect();
            let rv: Vec<f64> = c["rv"].as_array().unwrap().iter().map(jf).collect();
            let e = &c["exp"];
            let p = hist_profile(&hist, &likes, &subs);
            omap_eq(&p.chan, &e["profile"]["chan"], "chan"); omap_eq(&p.words, &e["profile"]["words"], "words");
            let dis = chan_word_profile(&dislikes);
            omap_eq(&dis.chan, &e["dis"]["chan"], "dis.chan"); omap_eq(&dis.words, &e["dis"]["words"], "dis.words");
            for (k, n) in [0usize, 1, 2, 3, 6].iter().enumerate() {
                let want: Vec<&str> = e["seeds"][k].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
                assert_eq!(rec_seeds(&p, *n), want, "case {ci} seeds {n}");
            }
            let t = taste_centroid(&hist, &likes, &meta, &emb, &idf);
            let wt = &e["taste"];
            assert!(close(t.strength, jf(&wt["strength"])) && close(t.estrength, jf(&wt["estrength"])), "case {ci} strengths");
            assert_eq!(t.vec.len(), wt["vec"].as_array().unwrap().len(), "case {ci} taste vec len");
            for p in wt["vec"].as_array().unwrap() { assert!(close(t.vec[p[0].as_str().unwrap()], jf(&p[1])), "case {ci} taste term {}", p[0]); }
            match (&t.evec, wt["evec"].as_array()) { (Some(a), Some(b)) => for (x, y) in a.iter().zip(b) { assert!(close(*x, jf(y)), "case {ci} evec"); }, (None, None) => {}, _ => panic!("evec presence") }
            if t.estrength > 2.0 { e_branch += 1 } else if t.strength > 3.0 { t_branch += 1 }
            let hist_ids: HashSet<String> = hist.iter().chain(&likes).chain(&dislikes).map(|v| v.id.clone()).collect();
            let mut i = 0; let mut rng = || { let v = rv[i % rv.len()]; i += 1; v };
            for (k, cv) in vs(&c["cands"]).iter().enumerate() {
                let cand = Cand { id: cv.id.clone(), title: cv.title.clone(), channel: cv.channel.clone(), channel_id: String::new(), duration: cv.duration.clone(), views: cv.views.clone(), published: cv.published.clone(), desc: cv.desc.clone() };
                let got = score_candidate(&cand, &p, &hist_ids, Some(&dis), Some(&t), &idf, &emb, &mut rng);
                assert!(close(got, jf(&e["scores"][k])), "case {ci} cand {k}: {got} vs {}", e["scores"][k]);
            }
        }
        assert!(e_branch > 20 && t_branch >= 2, "branch coverage e={e_branch} t={t_branch}");
    }
}
