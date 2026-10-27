                                                                                                                 
                                                                                               
                                                                                                                  
                                                                                                                  
                                                                                                           
                                                                                                                          
use std::collections::{HashMap, HashSet};
use axum::http::StatusCode;
use axum::response::Response;
use crate::lite::{json_err, json_ord, OJ};
use super::jetstream::{load, parse_secs, Hist, Mark, Sub as SubRow};
use super::jetstream_feed::{with_feeds, Ranked, REC_CAP, REC_TTL_MS, SHORTS_TTL_MS};
use super::jetstream_foryou as fy;
use super::jetstream_rank as rk;
use super::jetstream_up::{parse_search, SearchItem, Up};
use super::{io_fail, read_store, StoreRead};

const SHORTS_BATCH: usize = REC_CAP * 2;
const MIN_LEFT: usize = 6;
const SEARCH_TTL: i64 = 3 * 60 * 1000;
static SEARCH_CACHE: std::sync::Mutex<Vec<(String, i64, Vec<SearchItem>)>> = std::sync::Mutex::new(Vec::new());

                                                                                                                     
#[cfg(test)]                                                                                                                
pub static RNG_SCRIPT: std::sync::Mutex<Option<(Vec<f64>, usize)>> = std::sync::Mutex::new(None);
                                                                                                 
                                                                                                       
pub type Clock = std::sync::Arc<dyn Fn() -> i64 + Send + Sync>;

fn seed_rng(clock: i64) -> impl FnMut() -> f64 {
    let mut x = (clock as u64) ^ 0x9E3779B97F4A7C15;
    move || {
        #[cfg(test)]
        if let Ok(mut g) = RNG_SCRIPT.lock() { if let Some((v, i)) = g.as_mut() { let r = v[*i % v.len()]; *i += 1; return r; } }
        x ^= x << 13; x ^= x >> 7; x ^= x << 17; (x >> 11) as f64 / (1u64 << 53) as f64 }
}
                                                                          
async fn yt_search(up: &dyn Up, q: &str, clock: &Clock) -> Option<Vec<SearchItem>> {
    if let Ok(g) = SEARCH_CACHE.lock() { if let Some(h) = g.iter().find(|h| h.0 == q) { if clock() - h.1 < SEARCH_TTL { return Some(h.2.clone()); } } }
    let data = up.innertube(false, "search", serde_json::json!({"query": q})).await.ok()?;
    let items = parse_search(&data, 20);
    if let Ok(mut g) = SEARCH_CACHE.lock() {
        g.retain(|h| h.0 != q); g.push((q.to_string(), clock(), items.clone()));
        if g.len() > 100 { g.remove(0); }
    }
    Some(items)
}

                                                                                                           
                                                                                        
static COLD: std::sync::Mutex<Vec<(String, std::sync::Arc<tokio::sync::Mutex<()>>)>> = std::sync::Mutex::new(Vec::new());
fn cold_lock(kind: &str, user: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let k = format!("{kind}|{user}");
    let mut g = COLD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = g.iter().position(|(n, _)| *n == k) { return g[p].1.clone(); }
    let m = std::sync::Arc::new(tokio::sync::Mutex::new(())); g.push((k, m.clone()));
    if g.len() > 400 { g.remove(0); }
    m
}
pub struct Rows { pub hist: Vec<rk::V>, pub likes: Vec<rk::V>, pub dislikes: Vec<rk::V>, pub subs: Vec<String> }
fn v_of(id: &str, title: &str, channel: &str, duration: &str, secs: Option<f64>, ws: Option<f64>) -> rk::V {
    rk::V { id: id.into(), title: title.into(), channel: channel.into(), channel_id: String::new(), duration: duration.into(), views: String::new(), published: String::new(), desc: String::new(), secs, ws }
}
pub fn load_rows(d: &std::path::Path, user: &str) -> Result<Rows, Response> {
    let h = load::<Hist>(&d.join("jetstream-history.json"), user)?.1;
    let l = load::<Mark>(&d.join("jetstream-likes.json"), user)?.1;
    let x = load::<Mark>(&d.join("jetstream-dislikes.json"), user)?.1;
    let s = load::<SubRow>(&d.join("jetstream-subs.json"), user)?.1;
    let m = |a: &Mark| v_of(&a.id, &a.title, &a.channel, &a.duration, None, None);
    Ok(Rows { hist: h.iter().map(|a| v_of(&a.id, &a.title, &a.channel, &a.duration, a.secs, a.ws)).collect(),
        likes: l.iter().map(m).collect(), dislikes: x.iter().map(m).collect(), subs: s.into_iter().map(|a| a.name).collect() })
}
fn load_dead(d: &std::path::Path) -> Result<HashSet<String>, Response> {
    match read_store(&d.join("jetstream-dead.json")) {
        StoreRead::Missing => Ok(HashSet::new()), StoreRead::Corrupt => Err(io_fail()),
        StoreRead::Ok(v) => Ok(v.get("ids").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()),
    }
}
                                                                                                      
fn read_lenient(f: std::path::PathBuf) -> Option<serde_json::Value> { fy::lenient_json(&std::fs::read_to_string(f).ok()?).ok() }
fn embed_map(d: &std::path::Path) -> HashMap<String, Vec<f64>> { read_lenient(d.join("jetstream-embed.json")).map(|v| fy::load_embed(&v)).unwrap_or_default() }
fn meta_map(d: &std::path::Path) -> fy::MetaMap { read_lenient(d.join("jetstream-meta.json")).map(|v| fy::load_meta(&v)).unwrap_or_default() }
fn ranked_of(v: &rk::V, secs: Option<f64>, score: f64) -> Ranked {
    Ranked { id: v.id.clone(), title: v.title.clone(), channel: v.channel.clone(), channel_id: v.channel_id.clone(), duration: v.duration.clone(), views: v.views.clone(), published: v.published.clone(), desc: v.desc.clone(), secs, score, ws: None }
}

                                                                                                                
pub async fn build_ranked(up: &dyn Up, d: &std::path::Path, user: &str, n: usize, clock: &Clock) -> Result<Vec<Ranked>, Response> {
    let r = load_rows(d, user)?;
    let dead = load_dead(d)?;
    let subs: Vec<fy::SubName> = r.subs.iter().map(|s| fy::SubName(s.clone())).collect();
    let profile = fy::hist_profile(&r.hist, &r.likes, &subs);
    let dis = fy::chan_word_profile(&r.dislikes);
    let (meta, emb) = (meta_map(d), embed_map(d));
    let idf = fy::build_idf(&meta);
    let taste = fy::taste_centroid(&r.hist, &r.likes, &meta, &emb, &idf);
    let seeds = fy::rec_seeds(&profile, n);
    let hist_ids: HashSet<String> = r.hist.iter().chain(&r.likes).chain(&r.dislikes).map(|v| v.id.clone()).collect();
    let mut queries = vec![]; for s in &seeds { queries.push(s.clone()); queries.push(format!("{s} shorts")); }
    let pools = futures::future::join_all(queries.iter().map(|q| yt_search(up, q, clock))).await;
    let mut seen = HashSet::new(); let mut cands: Vec<SearchItem> = vec![];
    for p in pools.into_iter().flatten() { for v in p { if seen.contains(&v.id) || dead.contains(&v.id) { continue; } seen.insert(v.id.clone()); cands.push(v); } }
    let mut rng = seed_rng(clock());
    let mut ranked: Vec<Ranked> = vec![];
    for v in &cands {
        let c = fy::Cand { id: v.id.clone(), title: v.title.clone(), channel: v.channel.clone(), channel_id: v.channel_id.clone(), duration: v.duration.clone(), views: v.views.clone(), published: v.published.clone(), desc: v.desc.clone() };
        let score = fy::score_candidate(&c, &profile, &hist_ids, Some(&dis), Some(&taste), &idf, &emb, &mut rng);
        if score < 0.0 { continue; }
        ranked.push(Ranked { id: v.id.clone(), title: v.title.clone(), channel: v.channel.clone(), channel_id: v.channel_id.clone(), duration: v.duration.clone(), views: v.views.clone(), published: v.published.clone(), desc: v.desc.clone(), secs: parse_secs(&v.duration), score, ws: None });
    }
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));                             
    Ok(diversify(ranked))
}
                                                 
pub fn diversify(ranked: Vec<Ranked>) -> Vec<Ranked> {
    let mut per: HashMap<String, usize> = HashMap::new(); let (mut head, mut tail) = (vec![], vec![]);
    for v in ranked { let n = per.entry(v.channel.clone()).or_insert(0); let k = *n; *n += 1; if k < 3 { head.push(v) } else { tail.push(v) } }
    head.extend(tail); head
}

                                                                
pub async fn build_shorts(up: &dyn Up, d: &std::path::Path, user: &str, n: usize, served: &HashSet<String>, clock: &Clock) -> Result<Vec<Ranked>, Response> {
    let r = load_rows(d, user)?;
    let dead = load_dead(d)?;
    let rows = rk::training_rows(&r.hist, &r.likes, &r.dislikes);
    let subs: Vec<rk::Sub> = r.subs.iter().map(|s| rk::Sub { name: s.clone() }).collect();
    let profile = rk::build_profile(&rows, &subs);
    let mut rng = seed_rng(clock());
    let mut seeds = rk::shorts_seeds(&profile, n, &mut rng);
    if seeds.is_empty() { seeds.push("trending shorts".into()); }
    let pools = futures::future::join_all(seeds.iter().map(|q| yt_search(up, q, clock))).await;
    let seen: HashSet<&str> = r.hist.iter().chain(&r.likes).chain(&r.dislikes).map(|v| v.id.as_str()).collect();
    let mut dup = HashSet::new(); let mut cands: Vec<rk::V> = vec![];
    for p in pools.into_iter().flatten() { for v in p {
        if !dup.insert(v.id.clone()) { continue; }
        let secs = parse_secs(&v.duration);
        match secs { Some(s) if s <= 61.0 && !seen.contains(v.id.as_str()) && !dead.contains(&v.id) && !served.contains(&v.id) => {
            cands.push(rk::V { id: v.id, title: v.title, channel: v.channel, channel_id: v.channel_id, duration: v.duration, views: v.views, published: v.published, desc: v.desc, secs, ws: None }) }
            _ => {} }
    } }
    let emb = embed_map(d);
    let embed = |id: &str| emb.get(id).cloned();
    let st = rk::State { hist: &r.hist, likes: &r.likes, dislikes: &r.dislikes, subs: &subs, dead: &dead, served };
    let o = rk::Opts { embed: Some(&embed), limit: SHORTS_BATCH, ..Default::default() };
    Ok(rk::rank_shorts(&cands, &st, &o, &mut rng).into_iter().map(|(v, s)| { let sc = v.secs; ranked_of(&v, sc, s) }).collect())
}

                                                                                                 
pub async fn ranked_recs(up: &dyn Up, d: &std::path::Path, user: &str, fresh: bool, clock: &Clock) -> Result<(Vec<Ranked>, bool), Response> {
    let (have, stale, n, flying) = with_feeds(|f| { let h = f.rec_entry(user); (h.ranked.clone(), clock() - h.at >= REC_TTL_MS, h.n, h.inflight) });
    if !fresh && !stale && !have.is_empty() { return Ok((have, false)); }
    if !have.is_empty() {
        return Ok((have, !flying));
    }
    let lk = cold_lock("rec", user); let _g = lk.lock().await;
    let again = with_feeds(|f| f.rec_entry(user).ranked.clone());
    if !again.is_empty() { return Ok((again, false)); }                                      
    with_feeds(|f| f.rec_entry(user).n += 1);
    let r = build_ranked(up, d, user, (n + 1) as usize, clock).await?;
    with_feeds(|f| { let h = f.rec_entry(user); h.ranked = r.clone(); h.at = clock(); });
    Ok((r, false))
}
pub async fn background_rec(up: &dyn Up, d: &std::path::Path, user: &str, clock: &Clock) {
                                                                                         
    let Some((gen, n)) = with_feeds(|f| f.rec_claim(user)) else { return };
    let r = build_ranked(up, d, user, n, clock).await;
                                                                                                        
    with_feeds(|f| f.rec_commit(user, gen, r.ok(), clock()));
}

                                                                                          
pub async fn shorts_get(up: &dyn Up, d: &std::path::Path, user: &str, fresh: bool, limit: usize, clock: &Clock) -> Result<(Vec<Ranked>, bool), Response> {
    let left = |f: &mut super::jetstream_feed::Feeds| { let h = f.shorts_entry(user); h.ranked.iter().filter(|v| !h.served.contains(&v.id)).cloned().collect::<Vec<_>>() };
    if with_feeds(|f| left(f).len()) < MIN_LEFT {
        let lk = cold_lock("shorts", user); let _g = lk.lock().await;
        let have = with_feeds(|f| left(f)); if have.len() >= MIN_LEFT { return Ok((have.into_iter().take(limit).collect(), false)); }        
        let mut err = None; let mut out = vec![];
        for _ in 0..2 {
            let (gen, n, served) = with_feeds(|f| { let h = f.shorts_entry(user); h.n += 1; (h.gen, h.n as usize, h.served.iter().cloned().collect::<HashSet<_>>()) });
            match build_shorts(up, d, user, n, &served, clock).await {
                Err(e) => { err = Some(e); break; }
                Ok(r) => with_feeds(|f| { let h = f.shorts_entry(user); if h.gen == gen && !r.is_empty() { h.ranked = r; h.at = clock(); } }),
            }
            out = with_feeds(|f| left(f)).into_iter().take(limit).collect();
            if !out.is_empty() { break; }
        }
        if out.is_empty() { if let Some(e) = err { return Err(e); } }
        return Ok((out, false));
    }
    let (bg, out) = with_feeds(|f| {
        let l: Vec<_> = left(f).into_iter().take(limit).collect();
        let h = f.shorts_entry(user);
        let want = (fresh || h.at == 0 || clock() - h.at >= SHORTS_TTL_MS) && h.inflight != Some(h.gen);
        (want, l)
    });
    Ok((out, bg))
}
pub async fn background_shorts(up: &dyn Up, d: &std::path::Path, user: &str, clock: &Clock) {
    let Some((gen, n, served)) = with_feeds(|f| { let h = f.shorts_entry(user); if h.inflight == Some(h.gen) { return None; } h.inflight = Some(h.gen); h.n += 1; Some((h.gen, h.n as usize, h.served.iter().cloned().collect::<HashSet<_>>())) }) else { return };
    let r = build_shorts(up, d, user, n, &served, clock).await;
    with_feeds(|f| { if f.shorts_peek(user).is_some() { let h = f.shorts_entry(user); if let Ok(r) = r { if h.gen == gen && !r.is_empty() { h.ranked = r; h.at = clock(); } } if h.inflight == Some(gen) { h.inflight = None; } } });
}

fn item(v: &Ranked, with_pub: bool) -> OJ {
    let mut o = vec![("id", OJ::Str(v.id.clone())), ("title", OJ::Str(v.title.clone())), ("channel", OJ::Str(v.channel.clone())), ("channelId", OJ::Str(v.channel_id.clone())),
        ("duration", OJ::Str(v.duration.clone())), ("views", OJ::Str(v.views.clone()))];
    if with_pub { o.push(("published", OJ::Str(v.published.clone()))); }
    o.push(("desc", OJ::Str(v.desc.clone())));
    OJ::Obj(o.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
fn e502() -> Response { json_ord(StatusCode::BAD_GATEWAY, vec![("ok", OJ::Bool(false)), ("error", OJ::Str("could not build your feed - try again".into()))]) }

                                                                     
pub async fn for_you(up: &dyn Up, d: &std::path::Path, user: &str, offset: &str, clock: &Clock) -> (Response, bool) {
    let (ranked, bg) = match ranked_recs(up, d, user, false, clock).await { Ok(x) => x, Err(r) => return (if r.status() == StatusCode::INTERNAL_SERVER_ERROR { r } else { e502() }, false) };
    let off = { let t = super::js_trim(offset); let digits: String = t.trim_start_matches(['+', '-']).chars().take_while(|c| c.is_ascii_digit()).collect(); if t.starts_with('-') { 0 } else { digits.parse::<usize>().unwrap_or(0) } };
    let long: Vec<&Ranked> = ranked.iter().filter(|v| v.secs.map_or(true, |s| s > 61.0)).collect();
    let items: Vec<OJ> = long.iter().skip(off).take(REC_CAP).map(|v| item(v, false)).collect();                                         
    let more = off + items.len() < long.len();
    (json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Arr(items)), ("more", OJ::Bool(more))]), bg)
}
pub async fn shorts(up: &dyn Up, d: &std::path::Path, user: &str, q: &str, fresh: bool, clock: &Clock) -> (Response, bool) {
    let q = super::js_trim(q).to_string();
    let (list, bg) = if !q.is_empty() {
        let pools = futures::future::join_all([q.clone(), format!("{q} shorts")].iter().map(|x| async move { up.innertube(false, "search", serde_json::json!({"query": x})).await.ok().map(|dd| parse_search(&dd, 20)) })).await;
        let mut done = HashSet::new(); let mut pool = vec![];
        for p in pools.into_iter().flatten() { for v in p { if done.insert(v.id.clone()) { let secs = parse_secs(&v.duration);
            pool.push(rk::V { id: v.id, title: v.title, channel: v.channel, channel_id: v.channel_id, duration: v.duration, views: v.views, published: v.published, desc: v.desc, secs, ws: None }); } } }
        let r = match load_rows(d, user) { Ok(r) => r, Err(e) => return (e, false) };
        let dead = match load_dead(d) { Ok(x) => x, Err(e) => return (e, false) };
        let subs: Vec<rk::Sub> = r.subs.iter().map(|s| rk::Sub { name: s.clone() }).collect();
        let emb = embed_map(d); let embed = |id: &str| emb.get(id).cloned();
        let none = HashSet::new();                                            
        let st = rk::State { hist: &r.hist, likes: &r.likes, dislikes: &r.dislikes, subs: &subs, dead: &dead, served: &none };
        let o = rk::Opts { embed: Some(&embed), limit: 24, explore_frac: 0.0, per_chan: 4, ..Default::default() };
        let mut rng = seed_rng(clock());
        (rk::rank_shorts(&pool, &st, &o, &mut rng).into_iter().map(|(v, s)| { let sc = v.secs; ranked_of(&v, sc, s) }).collect::<Vec<_>>(), false)
    } else {
        match shorts_get(up, d, user, fresh, REC_CAP, clock).await { Ok(x) => x, Err(r) => return (if r.status() == StatusCode::INTERNAL_SERVER_ERROR { r } else { e502() }, false) }
    };
    let cap = if q.is_empty() { REC_CAP } else { 24 };
    let shorts: Vec<Ranked> = list.into_iter().filter(|v| v.secs.map_or(false, |s| s <= 61.0)).take(cap).collect();
    let ids: Vec<String> = shorts.iter().map(|v| v.id.clone()).collect();
    with_feeds(|f| f.shorts_serve(user, &ids));
    (json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Arr(shorts.iter().map(|v| item(v, true)).collect()))]), bg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::jetstream_up::Jv;
    use futures::future::BoxFuture;
    struct M { ok: bool }
    fn vr(id: &str, title: &str, ch: &str, dur: &str) -> serde_json::Value {
        serde_json::json!({"videoRenderer": {"videoId": id, "title": {"runs":[{"text": title}]}, "lengthText": {"simpleText": dur},
            "ownerText": {"runs":[{"text": ch, "navigationEndpoint": {"browseEndpoint": {"browseId": format!("UC{ch}")}}}]},
            "viewCountText": {"simpleText": "1.2K views"}, "publishedTimeText": {"simpleText": "2 days ago"}}})
    }
    impl Up for M {
        fn innertube<'a>(&'a self, _w: bool, _e: &'a str, _b: serde_json::Value) -> BoxFuture<'a, Result<Jv, String>> {
            Box::pin(async move {
                if !self.ok { return Err("down".into()); }
                let mut l = vec![];
                for i in 0..8 { l.push(vr(&format!("lng{i:08}"), &format!("long guitar lesson {i}"), &format!("c{}", i % 2), "10:05")); }
                for i in 0..12 { l.push(vr(&format!("sht{i:08}"), &format!("funny cat clip {i}"), &format!("s{}", i % 6), "0:30")); }
                let s = serde_json::json!({"contents": l}).to_string();
                Ok(serde_json::from_str::<Jv>(&s).unwrap())
            })
        }
        fn ytdlp<'a>(&'a self, _u: &'a str, _e: Option<u32>) -> BoxFuture<'a, Result<Jv, String>> { Box::pin(async { Err("n/a".into()) }) }
        fn fetch<'a>(&'a self, _u: &'a str, _m: usize) -> BoxFuture<'a, Result<(u16, Vec<u8>, String), String>> { Box::pin(async { Err("n/a".into()) }) }
    }
    fn body(r: Response) -> (u16, serde_json::Value) {
        let (p, b) = r.into_parts();
        let bytes = futures::executor::block_on(axum::body::to_bytes(b, 1 << 20)).unwrap();
        (p.status.as_u16(), serde_json::from_slice(&bytes).unwrap())
    }
    static T: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test]
    fn feed_routes_with_mocked_upstream() {
        let _t = T.lock().unwrap_or_else(|e| e.into_inner());
        let d = std::env::temp_dir().join(format!("jsfeed-{}", std::process::id())); std::fs::create_dir_all(&d).unwrap();
        let clk: Clock = std::sync::Arc::new(|| 1_760_000_000_000i64);
        let rt = |f: std::pin::Pin<Box<dyn std::future::Future<Output = (Response, bool)> + '_>>| body(futures::executor::block_on(f).0);
                                                                                                                
        let (c, j) = rt(Box::pin(for_you(&M { ok: false }, &d, "fy1", "0", &clk)));
        assert_eq!((c, j["items"].as_array().unwrap().len(), j["more"].clone()), (200, 0, false.into()));
        let (c, j) = rt(Box::pin(shorts(&M { ok: false }, &d, "fy1", "", false, &clk))); assert_eq!((c, j["items"].as_array().unwrap().len()), (200, 0));
                                                                                                
        let (c, j) = rt(Box::pin(for_you(&M { ok: true }, &d, "fy1", "0", &clk)));
        assert_eq!(c, 200);
        let it = j["items"].as_array().unwrap(); assert_eq!(it.len(), 8); assert_eq!(j["more"], false);
        assert!(it.iter().all(|v| v["id"].as_str().unwrap().starts_with("lng") && v.get("score").is_none() && v.get("secs").is_none()));
        assert_eq!(it[0].as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["channel","channelId","desc","duration","id","title","views"]);                                                                                               
                        
        let (_, j) = rt(Box::pin(for_you(&M { ok: true }, &d, "fy1", "6", &clk))); assert_eq!(j["items"].as_array().unwrap().len(), 2);
        let (_, j) = rt(Box::pin(for_you(&M { ok: true }, &d, "fy1", "-3", &clk))); assert_eq!(j["items"].as_array().unwrap().len(), 8);
                                                                              
        let (c, j) = rt(Box::pin(shorts(&M { ok: true }, &d, "fy1", "", false, &clk)));
        assert_eq!(c, 200);
        let a: Vec<String> = j["items"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        assert!(!a.is_empty() && a.iter().all(|i| i.starts_with("sht")));
        let (_, j) = rt(Box::pin(shorts(&M { ok: true }, &d, "fy1", "", true, &clk)));
        let b: Vec<String> = j["items"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        assert!(b.iter().all(|i| !a.contains(i)), "served must not repeat: {a:?} {b:?}");
                                          
        let (_, j) = rt(Box::pin(shorts(&M { ok: true }, &d, "fy1", "cats", false, &clk))); assert!(j["items"].as_array().unwrap().len() <= 24 && !j["items"].as_array().unwrap().is_empty());
                                                                  
        std::fs::write(d.join("jetstream-dead.json"), r#"{"ids":["lng00000000","lng00000001"]}"#).unwrap();
        super::super::jetstream_feed::on_clear_all("fy2");
        let (_, j) = rt(Box::pin(for_you(&M { ok: true }, &d, "fy2", "0", &clk)));
        assert!(j["items"].as_array().unwrap().iter().all(|v| v["id"] != "lng00000000" && v["id"] != "lng00000001"));
        std::fs::write(d.join("jetstream-dead.json"), "{oops").unwrap();
        super::super::jetstream_feed::on_clear_all("fy3");
        let (c, _) = rt(Box::pin(for_you(&M { ok: true }, &d, "fy3", "0", &clk))); assert_eq!(c, 500);
                                                                       
        let mk = |i: usize, ch: &str| Ranked { id: format!("{i}"), channel: ch.into(), ..Default::default() };
        let out = diversify(vec![mk(0,"a"), mk(1,"a"), mk(2,"a"), mk(3,"a"), mk(4,"b")]);
        assert_eq!(out.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["0","1","2","4","3"]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn routes_match_real_r32_route_oracle() {
        let _t = T.lock().unwrap_or_else(|e| e.into_inner());
        SEARCH_CACHE.lock().unwrap().clear(); *super::super::jetstream_feed::FEEDS.lock().unwrap() = None;                                                        
        let g: serde_json::Value = serde_json::from_str(include_str!("jetstream_route_golden.json")).unwrap();
        struct RM(HashMap<String, String>);
        impl Up for RM {
            fn innertube<'a>(&'a self, _w: bool, _e: &'a str, b: serde_json::Value) -> BoxFuture<'a, Result<Jv, String>> {
                Box::pin(async move {
                    let q = b["query"].as_str().unwrap_or("");
                    if q.contains("FAIL") { return Err("down".into()); }
                    Ok(serde_json::from_str::<Jv>(self.0.get(q).unwrap_or_else(|| panic!("unrecorded query {q:?}"))).unwrap())
                })
            }
            fn ytdlp<'a>(&'a self, _u: &'a str, _e: Option<u32>) -> BoxFuture<'a, Result<Jv, String>> { Box::pin(async { Err("n/a".into()) }) }
            fn fetch<'a>(&'a self, _u: &'a str, _m: usize) -> BoxFuture<'a, Result<(u16, Vec<u8>, String), String>> { Box::pin(async { Err("n/a".into()) }) }
        }
                                                                                   
        static CALL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("jsroute-{}-{}", std::process::id(), CALL.fetch_add(1, std::sync::atomic::Ordering::Relaxed))); std::fs::remove_dir_all(&d).ok(); std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("jetstream-dead.json"), g["dead"].to_string()).unwrap();
        for (f, k) in [("history", "hist"), ("likes", "likes"), ("dislikes", "dislikes"), ("subs", "subs")] {
            let mut m = serde_json::Map::new();
            for (u, x) in g["users"].as_object().unwrap() { m.insert(u.clone(), x[k].clone()); }
            std::fs::write(d.join(format!("jetstream-{f}.json")), serde_json::Value::Object(m).to_string()).unwrap();
        }
        let up = RM(g["searches"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.to_string())).collect());
        *RNG_SCRIPT.lock().unwrap() = Some((g["rv"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect(), 0));
        let clk: Clock = std::sync::Arc::new(|| 1_760_000_000_000i64);
        let raw = |r: Response| { let (p, b) = r.into_parts(); (p.status.as_u16(), String::from_utf8(futures::executor::block_on(axum::body::to_bytes(b, 1 << 22)).unwrap().to_vec()).unwrap()) };
        let mut bad = vec![];
        for st in g["steps"].as_array().unwrap() {
            let (user, sub) = (st["user"].as_str().unwrap(), st["sub"].as_str().unwrap());
            let (path, qs) = sub.split_once('?').unwrap_or((sub, ""));
            let qv = |k: &str| qs.split('&').find_map(|p| p.strip_prefix(&format!("{k}="))).map(|v| v.replace("%20", " ")).unwrap_or_default();
            let (r, _) = if path == "/for-you" { futures::executor::block_on(for_you(&up, &d, user, &qv("offset"), &clk)) }
                         else { futures::executor::block_on(shorts(&up, &d, user, &qv("q"), qv("fresh") == "1", &clk)) };
            let (c, b) = raw(r);
            if c as u64 != st["status"].as_u64().unwrap() || b != st["body"].as_str().unwrap() { bad.push(format!("{user}{sub}: {c} {b}\n   want {}", st["body"])); }
        }
        let used = RNG_SCRIPT.lock().unwrap().as_ref().unwrap().1;
        *RNG_SCRIPT.lock().unwrap() = None;
        std::fs::remove_dir_all(&d).ok();
        assert!(bad.is_empty(), "rng used {used}; mismatches:\n{}", bad.join("\n"));
    }
}
