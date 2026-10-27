                                                                                  
                                                                                       
                                                                                       
                                                                                   
                                                                          
                                                                    
                                                      
                                                                                       
                                                                                        
                                                               
                                                                                        
                                                                                     
                                                                               
                                                                   
                                                                                     
                                   
                                                                                                              
                                                                                                              
                                                                                                            
                                                                                       
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use crate::lite::{json_ord, json_err, OJ};
use super::{io_fail, js_number, js_round, js_slice16, js_string, js_trim, millis,
            parse_body2, read_store, store_mutex, too_large, write_json, BodyErr, StoreRead};

const HIST_CAP: usize = 200;                              
const HIST_TTL: i64 = 3 * 24 * 3600 * 1000;               
const LIKES_CAP: usize = 100;                             
const DIS_CAP: usize = 100;                               
const SUBS_CAP: usize = 100;                              
const BODY_CAP: usize = 65536;
const LOG_CAP: u64 = 262144;                                          

pub const DEFERRED_MSG: &str = "this part isn't ready yet.";
                                                                                     
pub fn deferred(method: &str, sub: &str) -> bool {
    matches!((method, sub),
        ("GET", "/search") | ("GET", "/summary")
        | ("GET", "/subs/new") | ("GET", "/channel") | ("GET", "/channel/info")
        | ("GET", "/channel/playlists") | ("GET", "/playlist") | ("GET", "/avatar")
        | ("GET", "/thumb"))
}

                                                                            
#[derive(Serialize, Deserialize, Clone)]
pub struct Hist {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: String,
    #[serde(serialize_with = "ser_secs", default)]
    pub secs: Option<f64>,
    pub completed: bool,
    pub at: i64,
                                                                                         
                                                                                            
                                                                                   
    #[serde(rename = "wsSeq", default, skip_serializing_if = "Option::is_none", serialize_with = "ser_opt")]
    pub ws_seq: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "ser_opt")]
    pub ws: Option<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
fn ser_opt<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v { None => s.serialize_none(), Some(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => s.serialize_i64(*n as i64), Some(n) => s.serialize_f64(*n) }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Mark {                                   
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: String,
    pub at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Sub {
    pub id: String,
    pub name: String,
    pub ts: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn path(d: &std::path::Path, n: &str) -> std::path::PathBuf { d.join(n) }

                                                                                      
pub(super) fn load<T: for<'a> Deserialize<'a>>(f: &std::path::Path, user: &str) -> Result<(Value, Vec<T>), Response> {
    let all = match read_store(f) {
        StoreRead::Missing => serde_json::json!({}),
        StoreRead::Corrupt => return Err(io_fail()),
        StoreRead::Ok(v) => v,
    };
    let list: Vec<T> = match all.get(user) {
        None => vec![],
        Some(v) if !v.is_array() => return Err(io_fail()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|_| io_fail())?,
    };
    Ok((all, list))
}
fn commit<T: Serialize>(f: &std::path::Path, mut all: Value, user: &str, list: &[T]) -> Result<(), Response> {
    all[user] = serde_json::to_value(list).map_err(|_| io_fail())?;
    write_json(f, &all).map_err(|_| io_fail())
}

                                                      
fn ser_secs<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v { None => s.serialize_none(), Some(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => s.serialize_i64(*n as i64), Some(n) => s.serialize_f64(*n) }
}

                                                       
pub fn parse_secs(t: &str) -> Option<f64> {
    let s = js_trim(t);
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 { return None; }
    let mut acc = 0f64;
    for p in &parts {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) { return None; }
        acc = acc * 60.0 + p.parse::<f64>().ok()?;
    }
    Some(acc)
}

                                                                              
pub fn user_hist_ids(d: &std::path::Path, user: &str) -> Result<std::collections::HashSet<String>, Response> {
    let f = path(d, "jetstream-history.json");
    let m = store_mutex(&f); let _g = m.lock().map_err(|_| io_fail())?;
    Ok(load::<Hist>(&f, user)?.1.into_iter().map(|h| h.id).collect())
}
pub fn user_subs(d: &std::path::Path, user: &str) -> Result<Vec<Sub>, Response> {
    let f = path(d, "jetstream-subs.json");
    let m = store_mutex(&f); let _g = m.lock().map_err(|_| io_fail())?;
    Ok(load::<Sub>(&f, user)?.1)
}

                       
pub fn shelf(list: &[Hist], now: i64) -> Vec<Hist> {
    list.iter().filter(|v| {
        if v.completed { return false; }
        let secs = v.secs.or_else(|| parse_secs(&v.duration));
        if let Some(s) = secs { if s <= 61.0 { return false; } }
        if v.at != 0 && now - v.at > HIST_TTL { return false; }
        true
    }).cloned().collect()
}

pub fn vid_ok(id: &str) -> bool { id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') }

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false, Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(), _ => true,
    }
}
                                                       
fn s(b: &Value, k: &str) -> String { js_string(&b[k]) }

fn ints(v: &Value) -> i64 {                         
    let n = js_number(Some(v));
    if !n.is_finite() { return 0; }
    (n.trunc().rem_euclid(4294967296.0) as u32) as i32 as i64
}

                                                                                   
fn guarded(body: &[u8]) -> Result<Value, Response> {
    match parse_body2(body, BODY_CAP) {
        Err(BodyErr::TooLarge) => Err(too_large()),
        Ok(None) => Ok(serde_json::json!({})),
        Ok(Some(Value::Null)) => Err(io_fail()),
        Ok(Some(v)) => Ok(v),
    }
}

fn ok_with(extra: Vec<(&str, OJ)>) -> Response {
    let mut v = vec![("ok", OJ::Bool(true))];
    v.extend(extra);
    json_ord(StatusCode::OK, v)
}
fn rows_json<T: Serialize>(rows: &[T]) -> OJ { OJ::Raw(serde_json::to_string(rows).unwrap_or_else(|_| "[]".into())) }

                                                                             
                                                                                        
                                                                                    
const QUICK_CAP: usize = 20;
const PLAY_CAP: usize = 50;

#[derive(Serialize, Deserialize, Clone)]
pub struct PlayRow {                                                                  
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: String,
    pub at: i64,                          
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct QuickRow {                                                          
    pub id: String,
    pub title: String,
    pub kind: String,                             
    pub at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn fmt_dur(secs: f64) -> String {
    if !secs.is_finite() || secs <= 0.0 { return String::new(); }
    let n = js_round(secs).max(0.0) as u64;
    format!("{}:{:02}", n / 60, n % 60)
}

                                                                                 
                                                                                     
                                                                                         
pub fn record_play(d: &std::path::Path, user: &str, id: &str, title: &str, channel: &str, secs: f64) {
    record_play_at(d, user, id, title, channel, secs, millis());
}
pub fn record_play_at(d: &std::path::Path, user: &str, id: &str, title: &str, channel: &str, secs: f64, now: i64) {
    let pf = path(d, "jetstream-playback.json");
    let m = store_mutex(&pf);
    let Ok(_g) = m.lock() else { return };
    let Ok((all, list)) = load::<PlayRow>(&pf, user) else { return };
    let mut list: Vec<PlayRow> = list.into_iter().filter(|r| r.id != id).collect();
    list.insert(0, PlayRow { id: id.into(), title: title.into(), channel: channel.into(), duration: fmt_dur(secs), at: now, extra: Map::new() });
    list.truncate(PLAY_CAP);
    commit(&pf, all, user, &list).ok();
}

pub fn handle(data_dir: &std::path::Path, user: &str, method: &str, sub: &str, body: &[u8]) -> Response {
    handle_clock(data_dir, user, method, sub, body, &millis)
}

pub fn handle_at(d: &std::path::Path, user: &str, method: &str, sub: &str, body: &[u8], now: i64) -> Response {
    handle_clock(d, user, method, sub, body, &|| now)
}

                                                                                           
                                                                                             
pub fn handle_clock(d: &std::path::Path, user: &str, method: &str, sub: &str, body: &[u8], clock: &dyn Fn() -> i64) -> Response {
    let hf = path(d, "jetstream-history.json");
    let lf = path(d, "jetstream-likes.json");
    let df = path(d, "jetstream-dislikes.json");
    let sf = path(d, "jetstream-subs.json");
    let stf = path(d, "jetstream-settings.json");
    if deferred(method, sub) { return json_err(StatusCode::NOT_IMPLEMENTED, DEFERRED_MSG); }
                                                                                                       
    macro_rules! lock { ($m:ident, $g:ident, $f:expr) => {
        let $m = store_mutex($f);
        let $g = match $m.lock() { Ok(g) => g, Err(_) => return io_fail() };
    } }
    match (method, sub) {
        ("GET", "/history") => {
            lock!(m1, g1, &hf);
            let (_, list) = match load::<Hist>(&hf, user) { Ok(x) => x, Err(r) => return r };
            let items: Vec<Hist> = shelf(&list, clock()).into_iter().take(10).collect();
            drop(g1);
            ok_with(vec![("items", rows_json(&items))])
        }
        ("POST", "/history/delete") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let id = s(&b, "id");
            lock!(m1, g1, &hf);
            let (all, list) = match load::<Hist>(&hf, user) { Ok(x) => x, Err(r) => return r };
            let kept: Vec<Hist> = list.into_iter().filter(|v| v.id != id).collect();
            if let Err(r) = commit(&hf, all, user, &kept) { return r; }
            drop(g1);
            super::ok_true()
        }
        ("POST", "/history") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let id = s(&b, "id");
            if !vid_ok(&id) { return json_err(StatusCode::BAD_REQUEST, "bad video id"); }
            let title = js_trim(&js_slice16(&s(&b, "title"), 200)).to_string();
            if title.is_empty() { return json_err(StatusCode::BAD_REQUEST, "need a title"); }
            lock!(m0, g0, &stf);                                                                       
            let paused = match read_store(&stf) {
                StoreRead::Missing => false, StoreRead::Corrupt => return io_fail(),
                StoreRead::Ok(v) => v.get(user).map(|u| truthy(&u["paused"])).unwrap_or(false),
            };
            drop(g0);
            if paused { return ok_with(vec![("paused", OJ::Bool(true))]); }
            let dur = js_slice16(&s(&b, "duration"), 8);
            let ws: Option<f64> = match &b["watched"] {
                Value::Number(n) => n.as_f64().filter(|x| x.is_finite()).map(|x| js_round(x).max(0.0)),
                _ => None,
            };
            lock!(m1, g1, &hf);
            let (all, list) = match load::<Hist>(&hf, user) { Ok(x) => x, Err(r) => return r };
            if let Some(w) = ws {
                                                                                              
                                                                        
                if list.iter().any(|v| v.id == id) {
                    let mut list = list;
                    let hit = list.iter_mut().find(|v| v.id == id).unwrap();
                    if !apply_ws(hit, w, &b["seq"]) {
                        drop(g1);
                        return ok_with(vec![("stale", OJ::Bool(true))]);
                    }
                    if let Err(r) = commit(&hf, all, user, &list) { return r; }
                    drop(g1);
                    super::jetstream_feed::on_outcome(user);        
                    return super::ok_true();
                }
            }
            let item = Hist { id: id.clone(), title, channel: js_slice16(&s(&b, "channel"), 200),
                secs: parse_secs(&dur), duration: dur, completed: false, at: clock(), ws_seq: None, ws: None, extra: Map::new() };
            let mut item = item;
            if let Some(w) = ws { apply_ws(&mut item, w, &b["seq"]); }                                  
            let mut mine: Vec<Hist> = list.into_iter().filter(|v| v.id != id).collect();
            mine.insert(0, item);
            mine.truncate(HIST_CAP);
            if let Err(r) = commit(&hf, all, user, &mine) { return r; }
            drop(g1);
            super::ok_true()
        }
        ("POST", "/history/complete") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let id = s(&b, "id");
            lock!(m1, g1, &hf);
            let (all, mut list) = match load::<Hist>(&hf, user) { Ok(x) => x, Err(r) => return r };
            if let Some(h) = list.iter_mut().find(|v| v.id == id) {
                h.completed = true;
                if let Err(r) = commit(&hf, all, user, &list) { return r; }
            }
            drop(g1);
            super::ok_true()
        }
        ("GET", "/settings") => {
            lock!(m1, g1, &hf);
            lock!(m5, g5, &stf);
            let (_, list) = match load::<Hist>(&hf, user) { Ok(x) => x, Err(r) => return r };
            let paused = match read_store(&stf) {
                StoreRead::Missing => false, StoreRead::Corrupt => return io_fail(),
                StoreRead::Ok(v) => v.get(user).map(|u| truthy(&u["paused"])).unwrap_or(false),
            };
            drop(g5); drop(g1);
            ok_with(vec![("paused", OJ::Bool(paused)), ("count", OJ::U64(list.len() as u64))])
        }
        ("POST", "/settings") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let paused = truthy(&b["paused"]);
            lock!(m5, g5, &stf);
            let mut all = match read_store(&stf) {
                StoreRead::Missing => serde_json::json!({}), StoreRead::Corrupt => return io_fail(),
                StoreRead::Ok(v) => v,
            };
            all[user] = serde_json::json!({"paused": paused});
            if write_json(&stf, &all).is_err() { return io_fail(); }
            drop(g5);
            ok_with(vec![("paused", OJ::Bool(paused))])
        }
        ("POST", "/history/clear-watch") => {
            if body.len() > BODY_CAP { return too_large(); }
            lock!(m1, g1, &hf);
            let (all, _) = match load::<Hist>(&hf, user) { Ok(x) => x, Err(r) => return r };
            if let Err(r) = commit::<Hist>(&hf, all, user, &[]) { return r; }
            drop(g1);
            super::jetstream_feed::on_taste_change(user);        
            super::ok_true()
        }
        ("POST", "/history/clear") => {
            if body.len() > BODY_CAP { return too_large(); }
            lock!(m1, g1, &hf); lock!(m2, g2, &lf); lock!(m3, g3, &df); lock!(m4, g4, &sf);
                                                                                              
            let a = match load::<Hist>(&hf, user) { Ok(x) => x.0, Err(r) => return r };
            let b = match load::<Mark>(&lf, user) { Ok(x) => x.0, Err(r) => return r };
            let c = match load::<Mark>(&df, user) { Ok(x) => x.0, Err(r) => return r };
            let e = match load::<Sub>(&sf, user) { Ok(x) => x.0, Err(r) => return r };
            if let Err(r) = commit::<Hist>(&hf, a, user, &[]) { return r; }
            if let Err(r) = commit::<Mark>(&lf, b, user, &[]) { return r; }
            if let Err(r) = commit::<Mark>(&df, c, user, &[]) { return r; }
            if let Err(r) = commit::<Sub>(&sf, e, user, &[]) { return r; }
            drop((g4, g3, g2, g1));
            super::jetstream_feed::on_clear_all(user);        
            super::ok_true()
        }
        ("GET", "/likes") | ("GET", "/dislikes") => {
            let f = if sub == "/likes" { &lf } else { &df };
            lock!(m, g, f);
            let (_, list) = match load::<Mark>(f, user) { Ok(x) => x, Err(r) => return r };
            drop(g);
            let ids: Vec<OJ> = list.iter().map(|v| OJ::Str(v.id.clone())).collect();
            ok_with(vec![("ids", OJ::Arr(ids))])
        }
        ("POST", "/likes/toggle") | ("POST", "/dislikes/toggle") => {
            let like = sub == "/likes/toggle";
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let id = s(&b, "id");
            if !vid_ok(&id) { return json_err(StatusCode::BAD_REQUEST, "bad id"); }
            let (f, cap) = if like { (&lf, LIKES_CAP) } else { (&df, DIS_CAP) };
            lock!(m, g, f);
            let (all, mut mine) = match load::<Mark>(f, user) { Ok(x) => x, Err(r) => return r };
            let on = if let Some(at) = mine.iter().position(|v| v.id == id) { mine.remove(at); false } else {
                mine.insert(0, Mark { id, title: s(&b, "title"), channel: s(&b, "channel"), duration: s(&b, "duration"), at: clock(), extra: Map::new() });
                mine.truncate(cap);
                true
            };
            if let Err(r) = commit(f, all, user, &mine) { return r; }
            drop(g);
            super::jetstream_feed::on_taste_change(user);        
            ok_with(vec![(if like { "liked" } else { "disliked" }, OJ::Bool(on))])
        }
        ("GET", "/subs") => {
            lock!(m, g, &sf);
            let (_, list) = match load::<Sub>(&sf, user) { Ok(x) => x, Err(r) => return r };
            drop(g);
            ok_with(vec![("subs", rows_json(&list))])
        }
        ("POST", "/subs/toggle") => {
                                                                                                    
                                                                                              
                                                                  
            let b = if body.is_empty() { serde_json::json!({}) } else { match parse_body2(body, BODY_CAP) {
                Err(BodyErr::TooLarge) => return too_large(),
                Ok(Some(Value::Null)) => return io_fail(),
                Ok(Some(v)) => v,
                Ok(None) => return json_err(StatusCode::BAD_REQUEST, "bad request"),        
            } };
            let id = js_trim(&s(&b, "id")).to_string();
            let name = js_slice16(js_trim(&s(&b, "name")), 200);
            if id.is_empty() || name.is_empty() { return json_err(StatusCode::BAD_REQUEST, "missing channel"); }
            lock!(m, g, &sf);
            let (all, mut mine) = match load::<Sub>(&sf, user) { Ok(x) => x, Err(r) => return r };
            let on = if let Some(at) = mine.iter().position(|v| v.id == id) { mine.remove(at); false } else {
                mine.insert(0, Sub { id, name, ts: clock(), extra: Map::new() });
                mine.truncate(SUBS_CAP);
                true
            };
            if let Err(r) = commit(&sf, all, user, &mine) { return r; }
            drop(g);
            super::jetstream_feed::on_taste_change(user);        
            ok_with(vec![("subbed", OJ::Bool(on))])
        }
        ("POST", "/clientlog") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let line = format!("{{\"ts\":{},\"user\":{},\"kind\":{},\"id\":{},\"vw\":{},\"vh\":{},\"hd\":{},\"why\":{},\"ua\":{}}}",
                js(&iso(clock())), js(user), js(&js_slice16(&s(&b, "kind"), 24)), js(&js_slice16(&s(&b, "id"), 16)),
                ints(&b["vw"]), ints(&b["vh"]), truthy(&b["hd"]),
                js(&js_slice16(&s(&b, "why"), 40)), js(&js_slice16(&s(&b, "ua"), 120)));
            let lg = path(d, "jetstream-clientlog.jsonl");
            let m = store_mutex(&lg);
            if let Ok(_g) = m.lock() { let _ = append_log(&lg, &line); }                               
            super::ok_true()
        }
        ("GET", "/home") => {
            let qf = path(d, "jetstream-quick.json");
            let pf = path(d, "jetstream-playback.json");
            lock!(m1, g1, &qf);
            let (_, quick) = match load::<QuickRow>(&qf, user) { Ok(x) => x, Err(r) => return r };
            drop(g1);
            lock!(m2, g2, &pf);
            let (_, plays) = match load::<PlayRow>(&pf, user) { Ok(x) => x, Err(r) => return r };
            drop(g2);
            let recent: Vec<PlayRow> = plays.into_iter().take(10).collect();
                                                                                              
                                                                                        
                                                                                            
                                                                                      
            let Some(ticket)=crate::auth_api::wisp::thumb_ticket(d,user)else{return io_fail()};
            ok_with(vec![("quick", rows_json(&quick)), ("recent", rows_json(&recent)), ("thumbTicket", OJ::Str(ticket))])
        }
        ("POST", "/quick") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let id = s(&b, "id");
            if !vid_ok(&id) { return json_err(StatusCode::BAD_REQUEST, "bad video id"); }
            let title = js_trim(&js_slice16(&s(&b, "title"), 200)).to_string();
            if title.is_empty() { return json_err(StatusCode::BAD_REQUEST, "need a title"); }
            let kind = { let raw = s(&b, "kind"); let k = js_trim(&raw); if k.is_empty() { "video".to_string() } else { k.to_string() } };
            if kind != "video" { return json_err(StatusCode::BAD_REQUEST, "bad request"); }                                     
            let qf = path(d, "jetstream-quick.json");
            lock!(m1, g1, &qf);
            let (all, list) = match load::<QuickRow>(&qf, user) { Ok(x) => x, Err(r) => return r };
            let mut list: Vec<QuickRow> = list.into_iter().filter(|r| r.id != id).collect();
            list.insert(0, QuickRow { id, title, kind, at: clock(), extra: Map::new() });
            list.truncate(QUICK_CAP);
            if let Err(r) = commit(&qf, all, user, &list) { return r; }
            drop(g1);
            super::ok_true()
        }
        ("POST", "/quick/delete") => {
            let b = match guarded(body) { Ok(b) => b, Err(r) => return r };
            let id = s(&b, "id");                                       
            let qf = path(d, "jetstream-quick.json");
            lock!(m1, g1, &qf);
            let (all, list) = match load::<QuickRow>(&qf, user) { Ok(x) => x, Err(r) => return r };
            let kept: Vec<QuickRow> = list.into_iter().filter(|r| r.id != id).collect();
            if let Err(r) = commit(&qf, all, user, &kept) { return r; }
            drop(g1);
            super::ok_true()
        }
        _ => json_err(StatusCode::NOT_FOUND, "unknown jetstream call"),
    }
}

                                                                                           
                                                                                      
pub fn apply_ws(row: &mut Hist, ws: f64, seq: &Value) -> bool {
    let s: Option<f64> = match seq { Value::Number(n) => n.as_f64().filter(|x| x.is_finite() && *x > 0.0).map(|x| x.floor()), _ => None };
    if let Some(s) = s {
        if let Some(cur) = row.ws_seq { if s < cur { return false; } }
        row.ws_seq = Some(s);
    }
    row.ws = Some(ws);
    true
}

fn js(x: &str) -> String { serde_json::to_string(x).unwrap() }

                                                
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (h, mi, sec, msr) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
                                       
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let mm = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if mm <= 2 { y + 1 } else { y };
    format!("{yy:04}-{mm:02}-{dd:02}T{h:02}:{mi:02}:{sec:02}.{msr:03}Z")
}

                                                                         
fn append_log(lg: &std::path::Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Ok(md) = std::fs::metadata(lg) {
        if md.len() > LOG_CAP {
            let txt = std::fs::read_to_string(lg).unwrap_or_default();
            let lines: Vec<&str> = txt.split('\n').collect();
            let keep = if lines.len() > 500 { &lines[lines.len() - 500..] } else { &lines[..] };
            std::fs::write(lg, keep.join("\n"))?;
        }
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(lg)?;
    f.write_all(format!("{line}\n").as_bytes())
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rjjs-{}", super::super::hex_id(6).unwrap()));
        std::fs::create_dir_all(&d).unwrap(); d
    }
    fn call(d: &std::path::Path, u: &str, m: &str, s: &str, b: &str, now: i64) -> (u16, String) {
        let r = handle_at(d, u, m, s, b.as_bytes(), now);
        let st = r.status().as_u16();
        let bytes = futures::executor::block_on(axum::body::to_bytes(r.into_body(), 1 << 24)).unwrap();
        (st, String::from_utf8(bytes.to_vec()).unwrap())
    }
    fn rd(d: &std::path::Path, f: &str) -> Value { serde_json::from_str(&std::fs::read_to_string(d.join(f)).unwrap()).unwrap() }
    const ID1: &str = "abcdefghijk";

    #[test]
    fn secs_and_iso() {
        assert_eq!(parse_secs("1:02"), Some(62.0));
        assert_eq!(parse_secs("1:02:03"), Some(3723.0));
        assert_eq!(parse_secs("12"), None);
        assert_eq!(parse_secs("1:x"), None);
        assert_eq!(parse_secs("1:2:3:4"), None);
        assert_eq!(parse_secs(""), None);
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_781_000_000_123), "2026-06-09T10:13:20.123Z");                                                                     
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(ints(&json!(-1.9)), -1);
        assert_eq!(ints(&json!(4294967297.0)), 1);
        assert_eq!(ints(&json!("12")), 12);
        assert_eq!(ints(&json!("x")), 0);
    }

    #[test]
    fn history_flow() {
        let d = dir(); let n = 1_000_000_000_000i64;
        assert_eq!(call(&d, "luke", "POST", "/history", r#"{"id":"short","title":"t"}"#, n), (400, r#"{"ok":false,"error":"bad video id"}"#.into()));
        assert_eq!(call(&d, "luke", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"   "}}"#), n), (400, r#"{"ok":false,"error":"need a title"}"#.into()));
                                                       
        assert_eq!(call(&d, "luke", "POST", "/history", "{nope", n).0, 400);
        assert_eq!(call(&d, "luke", "POST", "/history", "null", n), (500, r#"{"ok":false,"error":"something broke on our side"}"#.into()));
        assert!(!d.join("jetstream-history.json").exists());
        let (s1, b1) = call(&d, "luke", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"  Hello  ","channel":"Ch","duration":"10:00"}}"#), n);
        assert_eq!((s1, b1.as_str()), (200, r#"{"ok":true}"#));
        let v = rd(&d, "jetstream-history.json");
        assert_eq!(v["luke"][0]["title"], "Hello");
        assert_eq!(v["luke"][0]["secs"], 600.0);
        assert_eq!(v["luke"][0]["completed"], false);
        assert_eq!(v["luke"][0]["at"], n);
                                                                                   
        call(&d, "luke", "POST", "/history", r#"{"id":"shortvideo1","title":"s","duration":"0:30"}"#, n);
        call(&d, "luke", "POST", "/history", r#"{"id":"doneVideo01","title":"d","duration":"9:00"}"#, n);
        call(&d, "luke", "POST", "/history/complete", r#"{"id":"doneVideo01"}"#, n);
        call(&d, "luke", "POST", "/history", r#"{"id":"nodurVideo1","title":"nodur"}"#, n);                        
        let (_, g) = call(&d, "luke", "GET", "/history", "", n + 1000);
        let g: Value = serde_json::from_str(&g).unwrap();
        let ids: Vec<&str> = g["items"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["nodurVideo1", ID1]);
        assert_eq!(rd(&d, "jetstream-history.json")["luke"].as_array().unwrap().len(), 4);
                                     
        let (_, g) = call(&d, "luke", "GET", "/history", "", n + HIST_TTL + 1);
        assert_eq!(serde_json::from_str::<Value>(&g).unwrap()["items"].as_array().unwrap().len(), 0);
                                                   
        call(&d, "luke", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"again"}}"#), n + 5);
        let v = rd(&d, "jetstream-history.json");
        assert_eq!(v["luke"][0]["id"], ID1); assert_eq!(v["luke"].as_array().unwrap().len(), 4);
                 
        assert_eq!(call(&d, "luke", "POST", "/history/delete", &format!(r#"{{"id":"{ID1}"}}"#), n).1, r#"{"ok":true}"#);
        assert_eq!(rd(&d, "jetstream-history.json")["luke"].as_array().unwrap().len(), 3);
                                    
        call(&d, "bob", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"b"}}"#), n);
        call(&d, "luke", "POST", "/history/clear-watch", "", n);
        let v = rd(&d, "jetstream-history.json");
        assert_eq!(v["luke"].as_array().unwrap().len(), 0); assert_eq!(v["bob"].as_array().unwrap().len(), 1);
                                                            
        call(&d, "luke", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"{}","channel":"{}","duration":"123456789"}}"#, "t".repeat(300), "c".repeat(300)), n);
        let v = rd(&d, "jetstream-history.json");
        assert_eq!(v["luke"][0]["title"].as_str().unwrap().len(), 200);
        assert_eq!(v["luke"][0]["channel"].as_str().unwrap().len(), 200);
        assert_eq!(v["luke"][0]["duration"], "12345678");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn history_cap_and_ws_outcome() {
        let d = dir();
        for i in 0..205 {
            let id = format!("vid{i:08}");
            assert_eq!(call(&d, "u", "POST", "/history", &format!(r#"{{"id":"{id}","title":"t"}}"#), 5 + i).0, 200);
        }
        let v = rd(&d, "jetstream-history.json");
        assert_eq!(v["u"].as_array().unwrap().len(), 200);
        assert_eq!(v["u"][0]["id"], "vid00000204");
                                                                             
        assert_eq!(call(&d, "u", "POST", "/history", r#"{"id":"vid00000100","title":"t","watched":12.5,"seq":100}"#, 9999).1, r#"{"ok":true}"#);
        let v = rd(&d, "jetstream-history.json");
        let row = v["u"].as_array().unwrap().iter().find(|r| r["id"] == "vid00000100").unwrap().clone();
        assert_eq!((row["ws"].clone(), row["wsSeq"].clone(), row["at"].clone()), (json!(13), json!(100), json!(105)));
        assert_eq!(v["u"][0]["id"], "vid00000204");
                                                            
        let b0 = std::fs::read(d.join("jetstream-history.json")).unwrap();
        assert_eq!(call(&d, "u", "POST", "/history", r#"{"id":"vid00000100","title":"t","watched":3,"seq":99}"#, 9999).1, r#"{"ok":true,"stale":true}"#);
        assert_eq!(std::fs::read(d.join("jetstream-history.json")).unwrap(), b0);
                                                                                          
        call(&d, "u", "POST", "/history", r#"{"id":"vid00000100","title":"t","watched":-5,"seq":100}"#, 9999);
        assert_eq!(rd(&d, "jetstream-history.json")["u"].as_array().unwrap().iter().find(|r| r["id"] == "vid00000100").unwrap()["ws"], 0);
        call(&d, "u", "POST", "/history", r#"{"id":"vid00000100","title":"t","watched":40}"#, 9999);
        assert_eq!(rd(&d, "jetstream-history.json")["u"].as_array().unwrap().iter().find(|r| r["id"] == "vid00000100").unwrap()["ws"], 40);
                                                                                         
        call(&d, "u", "POST", "/history", r#"{"id":"newvideo001","title":"n","watched":7,"seq":0}"#, 9999);
        let v = rd(&d, "jetstream-history.json");
        assert_eq!((v["u"][0]["id"].clone(), v["u"][0]["ws"].clone(), v["u"][0].get("wsSeq").cloned()), (json!("newvideo001"), json!(7), None));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn settings_pause_and_clear_all() {
        let d = dir(); let n = 77;
        assert_eq!(call(&d, "u", "GET", "/settings", "", n).1, r#"{"ok":true,"paused":false,"count":0}"#);
        assert_eq!(call(&d, "u", "POST", "/settings", r#"{"paused":"yes"}"#, n).1, r#"{"ok":true,"paused":true}"#);
        assert_eq!(rd(&d, "jetstream-settings.json"), json!({"u":{"paused":true}}));
                                                        
        assert_eq!(call(&d, "u", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"t"}}"#), n).1, r#"{"ok":true,"paused":true}"#);
        assert!(!d.join("jetstream-history.json").exists());
        call(&d, "u", "POST", "/settings", r#"{"paused":0}"#, n);
        call(&d, "u", "POST", "/history", &format!(r#"{{"id":"{ID1}","title":"t"}}"#), n);
        assert_eq!(call(&d, "u", "GET", "/settings", "", n).1, r#"{"ok":true,"paused":false,"count":1}"#);
        call(&d, "u", "POST", "/likes/toggle", &format!(r#"{{"id":"{ID1}"}}"#), n);
        call(&d, "u", "POST", "/dislikes/toggle", r#"{"id":"zzzzzzzzzzz"}"#, n);
        call(&d, "u", "POST", "/subs/toggle", r#"{"id":"UC1","name":"N"}"#, n);
        call(&d, "o", "POST", "/subs/toggle", r#"{"id":"UC1","name":"N"}"#, n);
        assert_eq!(call(&d, "u", "POST", "/history/clear", "", n).1, r#"{"ok":true}"#);
        for f in ["jetstream-history.json", "jetstream-likes.json", "jetstream-dislikes.json", "jetstream-subs.json"] {
            assert_eq!(rd(&d, f)["u"], json!([]), "{f}");
        }
        assert_eq!(rd(&d, "jetstream-subs.json")["o"].as_array().unwrap().len(), 1);
        assert_eq!(rd(&d, "jetstream-settings.json")["u"]["paused"], false);                              
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn likes_dislikes_subs() {
        let d = dir(); let n = 42;
        assert_eq!(call(&d, "u", "POST", "/likes/toggle", r#"{"id":"bad"}"#, n), (400, r#"{"ok":false,"error":"bad id"}"#.into()));
        assert_eq!(call(&d, "u", "POST", "/likes/toggle", &format!(r#"{{"id":"{ID1}","title":"T","channel":"C","duration":"1:00"}}"#), n).1, r#"{"ok":true,"liked":true}"#);
        assert_eq!(call(&d, "u", "GET", "/likes", "", n).1, format!(r#"{{"ok":true,"ids":["{ID1}"]}}"#));
        assert_eq!(rd(&d, "jetstream-likes.json")["u"][0], json!({"id":ID1,"title":"T","channel":"C","duration":"1:00","at":42}));
        assert_eq!(call(&d, "u", "POST", "/likes/toggle", &format!(r#"{{"id":"{ID1}"}}"#), n).1, r#"{"ok":true,"liked":false}"#);
        assert_eq!(call(&d, "u", "GET", "/likes", "", n).1, r#"{"ok":true,"ids":[]}"#);
                                
        for i in 0..105 { call(&d, "u", "POST", "/likes/toggle", &format!(r#"{{"id":"lk{i:09}"}}"#), n); }
        let l = rd(&d, "jetstream-likes.json");
        assert_eq!(l["u"].as_array().unwrap().len(), 100); assert_eq!(l["u"][0]["id"], "lk000000104");
        assert_eq!(call(&d, "u", "POST", "/dislikes/toggle", &format!(r#"{{"id":"{ID1}"}}"#), n).1, r#"{"ok":true,"disliked":true}"#);
        assert_eq!(call(&d, "u", "GET", "/dislikes", "", n).1, format!(r#"{{"ok":true,"ids":["{ID1}"]}}"#));
               
        assert_eq!(call(&d, "u", "POST", "/subs/toggle", r#"{"id":"UC1"}"#, n), (400, r#"{"ok":false,"error":"missing channel"}"#.into()));
        assert_eq!(call(&d, "u", "POST", "/subs/toggle", "{bad", n), (400, r#"{"ok":false,"error":"bad request"}"#.into()));
        assert_eq!(call(&d, "u", "POST", "/subs/toggle", r#"{"id":" UC1 ","name":" Chan "}"#, n).1, r#"{"ok":true,"subbed":true}"#);
        assert_eq!(call(&d, "u", "GET", "/subs", "", n).1, r#"{"ok":true,"subs":[{"id":"UC1","name":"Chan","ts":42}]}"#);
        assert_eq!(call(&d, "u", "POST", "/subs/toggle", r#"{"id":"UC1","name":"x"}"#, n).1, r#"{"ok":true,"subbed":false}"#);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn corrupt_stores_refuse_and_413() {
        let d = dir();
        for (f, m, s, b) in [
            ("jetstream-history.json", "POST", "/history", format!(r#"{{"id":"{ID1}","title":"t"}}"#)),
            ("jetstream-history.json", "GET", "/history", String::new()),
            ("jetstream-likes.json", "POST", "/likes/toggle", format!(r#"{{"id":"{ID1}"}}"#)),
            ("jetstream-dislikes.json", "GET", "/dislikes", String::new()),
            ("jetstream-subs.json", "POST", "/subs/toggle", r#"{"id":"a","name":"b"}"#.into()),
            ("jetstream-settings.json", "POST", "/settings", r#"{"paused":true}"#.into()),
        ] {
            for bad in [&b"[\"not"[..], b"[1,2]", b"null"] {
                std::fs::write(d.join(f), bad).unwrap();
                let r = call(&d, "u", m, s, &b, 1);
                assert_eq!(r, (500, r#"{"ok":false,"error":"something broke on our side"}"#.into()), "{f} {s}");
                assert_eq!(std::fs::read(d.join(f)).unwrap(), bad, "{f} bytes changed");
            }
            std::fs::remove_file(d.join(f)).unwrap();
        }
                                              
        std::fs::write(d.join("jetstream-subs.json"), br#"{"u":"x"}"#).unwrap();
        assert_eq!(call(&d, "u", "GET", "/subs", "", 1).0, 500);
                                                               
        std::fs::write(d.join("jetstream-history.json"), br#"{"u":[]}"#).unwrap();
        std::fs::write(d.join("jetstream-likes.json"), br#"{"u":[{"id":"abcdefghijk","title":"","channel":"","duration":"","at":1}]}"#).unwrap();
        std::fs::write(d.join("jetstream-dislikes.json"), b"{{").unwrap();
        let h0 = std::fs::read(d.join("jetstream-likes.json")).unwrap();
        assert_eq!(call(&d, "u", "POST", "/history/clear", "", 1).0, 500);
        assert_eq!(std::fs::read(d.join("jetstream-likes.json")).unwrap(), h0);
                                           
        let big = "x".repeat(70000);
        assert_eq!(call(&d, "u", "POST", "/history/delete", &big, 1), (413, r#"{"ok":false,"error":"that's too big - try a smaller one"}"#.into()));
        assert_eq!(call(&d, "u", "POST", "/history/clear", &big, 1).0, 413);
        assert_eq!(call(&d, "u", "POST", "/subs/toggle", &big, 1).0, 413);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn extra_fields_survive_rewrite() {
                                                                                          
        let d = dir();
        std::fs::write(d.join("jetstream-history.json"), br#"{"u":[{"id":"abcdefghijk","title":"t","channel":"c","duration":"9:00","secs":540,"completed":false,"at":5,"ws":120,"wsSeq":3}]}"#).unwrap();
        call(&d, "u", "POST", "/history/complete", r#"{"id":"abcdefghijk"}"#, 6);
        let v = rd(&d, "jetstream-history.json");
        assert_eq!(v["u"][0]["ws"], 120); assert_eq!(v["u"][0]["wsSeq"], 3); assert_eq!(v["u"][0]["completed"], true);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn clientlog_line_and_rotation() {
        let d = dir();
        assert_eq!(call(&d, "u", "POST", "/clientlog", r#"{"kind":"slide-hd","id":"abcdefghijk","vw":1080.9,"vh":"1920","hd":1,"why":"w","ua":"UA","path":"relay"}"#, 1_781_000_000_123).1, r#"{"ok":true}"#);
        let line = std::fs::read_to_string(d.join("jetstream-clientlog.jsonl")).unwrap();
        assert_eq!(line, "{\"ts\":\"2026-06-09T10:13:20.123Z\",\"user\":\"u\",\"kind\":\"slide-hd\",\"id\":\"abcdefghijk\",\"vw\":1080,\"vh\":1920,\"hd\":true,\"why\":\"w\",\"ua\":\"UA\"}\n");
                          
        call(&d, "u", "POST", "/clientlog", &format!(r#"{{"kind":"{}","id":"{}","why":"{}","ua":"{}"}}"#, "k".repeat(50), "i".repeat(50), "w".repeat(90), "a".repeat(300)), 5);
        let last: Value = serde_json::from_str(std::fs::read_to_string(d.join("jetstream-clientlog.jsonl")).unwrap().lines().last().unwrap()).unwrap();
        assert_eq!((last["kind"].as_str().unwrap().len(), last["id"].as_str().unwrap().len(), last["why"].as_str().unwrap().len(), last["ua"].as_str().unwrap().len()), (24, 16, 40, 120));
                                                                     
        let fat = "x\n".repeat(150_000);
        std::fs::write(d.join("jetstream-clientlog.jsonl"), fat).unwrap();
        call(&d, "u", "POST", "/clientlog", "{}", 9);
        let n = std::fs::read_to_string(d.join("jetstream-clientlog.jsonl")).unwrap().lines().count();
        assert_eq!(n, 500);                                                                        
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn deferred_and_unknown() {
        let d = dir();
        for s in ["/search", "/summary", "/subs/new", "/channel", "/channel/info", "/channel/playlists", "/playlist", "/avatar", "/thumb"] {
            assert_eq!(call(&d, "u", "GET", s, "", 1), (501, r#"{"ok":false,"error":"this part isn't ready yet."}"#.into()), "{s}");
        }
                                                                                                
        assert_eq!(call(&d, "u", "GET", "/watch", "", 1).0, 404);
        assert_eq!(call(&d, "u", "GET", "/nope", "", 1), (404, r#"{"ok":false,"error":"unknown jetstream call"}"#.into()));
        assert_eq!(call(&d, "u", "POST", "/likes", "", 1).0, 404);                                      
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn concurrent_toggles_lose_nothing() {
        let d = dir();
        let mut hs = vec![];
        for t in 0..4 {
            let d = d.clone();
            hs.push(std::thread::spawn(move || for i in 0..10 {
                let r = handle_at(&d, "u", "POST", "/likes/toggle", format!(r#"{{"id":"t{t}i{i:08}"}}"#).as_bytes(), 1);
                assert_eq!(r.status(), StatusCode::OK);
            }));
        }
        for h in hs { h.join().unwrap(); }
        assert_eq!(rd(&d, "jetstream-likes.json")["u"].as_array().unwrap().len(), 40);
        std::fs::remove_dir_all(&d).ok();
    }

                                                                                      
                                                                                        
                                                                                       
                                                                                         
                                                                                         
                                                                           
    #[test]
    fn oracle_parity_with_real_r32() {
        fn norm(v: &Value) -> Value {                                          
            match v {
                Value::Number(n) => json!(n.as_f64().unwrap()),
                Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
                Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
                x => x.clone(),
            }
        }
        let gold: Vec<Value> = serde_json::from_str(include_str!("jetstream_golden.json")).unwrap();
        let d = dir();
        let files = ["jetstream-history.json", "jetstream-likes.json", "jetstream-dislikes.json", "jetstream-subs.json", "jetstream-settings.json"];
        assert!(gold.len() > 400);
        for (i, g) in gold.iter().enumerate() {
            let st = &g["step"];
            let (code, body) = call(&d, st["user"].as_str().unwrap(), st["method"].as_str().unwrap(), st["sub"].as_str().unwrap(), st["body"].as_str().unwrap(), st["now"].as_i64().unwrap());
            let ctx = format!("step {i}: {} {} body={}", st["method"], st["sub"], st["body"]);
            assert_eq!(code as i64, g["status"].as_i64().unwrap(), "{ctx}");
            assert_eq!(body, g["body"].as_str().unwrap(), "{ctx}");
            if g["stores"].is_null() { continue; }                                                                           
            for f in files {
                let want = g["stores"].get(f);
                let got = std::fs::read_to_string(d.join(f)).ok().map(|s| serde_json::from_str::<Value>(&s).unwrap());
                assert_eq!(got.as_ref().map(norm), want.map(norm), "{ctx} store {f}");
            }
            if st["sub"] == "/clientlog" && !g["lastlog"].as_str().unwrap().is_empty() {
                let log = std::fs::read_to_string(d.join("jetstream-clientlog.jsonl")).unwrap();
                let mut got: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
                let mut want: Value = serde_json::from_str(g["lastlog"].as_str().unwrap()).unwrap();
                got.as_object_mut().unwrap().remove("ts"); want.as_object_mut().unwrap().remove("ts");                
                assert_eq!(got, want, "{ctx}");
            }
        }
        std::fs::remove_dir_all(&d).ok();
    }

                                                                                                
                                                                                       
    #[test]
    fn qa_goldens_local_routes() {
        let gold: Vec<Value> = serde_json::from_str(include_str!("jetstream_qa_golden.json")).unwrap();
        let d = dir();
        let tick = std::cell::Cell::new(1_760_000_000_000i64);
        let clock = || { let n = tick.get(); tick.set(n + 1); n };
        let mut ran = 0;
        for g in &gold {
            let (m, s) = (g["method"].as_str().unwrap(), g["path"].as_str().unwrap());
            if s == "/subs/new" { continue; }                                                   
            let body = g.get("body").and_then(|b| b.as_str()).unwrap_or("");
                                                                                             
            let v = |n: i32| format!("{n:v>11}");
            if g["name"].as_str().unwrap().starts_with("likes cap 100") {
                for i in 0..105 { handle_clock(&d, "cap", "POST", "/likes/toggle", format!(r#"{{"id":"{}"}}"#, v(100 + i)).as_bytes(), &clock); }
            }
            if g["name"].as_str().unwrap().starts_with("history shelf slice 10") {
                for i in 0..205 { handle_clock(&d, "cap", "POST", "/history", format!(r#"{{"id":"{}","title":"h{i}","duration":"10:00"}}"#, v(1000 + i)).as_bytes(), &clock); }
            }
            let r = handle_clock(&d, g["user"].as_str().unwrap(), m, s, body.as_bytes(), &clock);
            let st = r.status().as_u16();
            let bytes = futures::executor::block_on(axum::body::to_bytes(r.into_body(), 1 << 24)).unwrap();
            let ctx = format!("{} {} {} {}", g["name"], m, s, body);
            assert_eq!(st as i64, g["expect"]["status"].as_i64().unwrap(), "{ctx}");
            let got = String::from_utf8(bytes.to_vec()).unwrap();
            if let Some(want) = g["expect"]["body"].as_str() { assert_eq!(got, want, "{ctx}"); }
            else {                                                  
                use sha2::{Digest, Sha256};
                let h: String = Sha256::digest(got.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(got.len() as i64, g["expect"]["bodyLen"].as_i64().unwrap(), "{ctx}");
                assert!(got.starts_with(g["expect"]["head"].as_str().unwrap()), "{ctx}");
                assert_eq!(h, g["expect"]["bodySha256"].as_str().unwrap(), "{ctx}");
            }
            ran += 1;
        }
        assert!(ran >= 45, "ran {ran}");
        std::fs::remove_dir_all(&d).ok();
    }

    const ID2: &str = "bcdefghijkl";

    #[test]fn home_ticket_failure_is_io_fail(){let d=dir();std::fs::create_dir(d.join("thumb-ticket-key")).unwrap();assert_eq!(call(&d,"bootstrap-fixture","GET","/home","",1),(500,"{\"ok\":false,\"error\":\"something broke on our side\"}".into()));}
    #[test]
    fn home_quick_and_recent() {
        let d = dir(); let now = 1_700_000_000_000i64;
                      
        let (st, body) = call(&d, "u", "GET", "/home", "", now);
        assert_eq!(st, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["quick"].as_array().unwrap().len(), 0);
        assert_eq!(v["recent"].as_array().unwrap().len(), 0);
        assert!(v["thumbTicket"].is_string());
                                       
        assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": ID1, "title": "First"}).to_string(), now).0, 200);
        assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": ID2, "title": "Second"}).to_string(), now + 1).0, 200);
        assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": ID1, "title": "First"}).to_string(), now + 2).0, 200);
        let (_, body) = call(&d, "u", "GET", "/home", "", now + 3);
        let v: Value = serde_json::from_str(&body).unwrap();
        let q = v["quick"].as_array().unwrap();
        assert_eq!(q.len(), 2);
        assert_eq!(q[0]["id"], ID1);                            
        assert_eq!(q[0]["kind"], "video");
        assert_eq!(q[0]["at"], now + 2);
        assert_eq!(q[1]["id"], ID2);
                     
        assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": "short", "title": "x"}).to_string(), now).0, 400);
        assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": ID1, "title": "  "}).to_string(), now).0, 400);
        assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": ID1, "title": "x", "kind": "channel"}).to_string(), now).0, 400);
                 
        assert_eq!(call(&d, "u", "POST", "/quick/delete", &json!({"id": ID1}).to_string(), now).0, 200);
        let (_, body) = call(&d, "u", "GET", "/home", "", now + 4);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["quick"].as_array().unwrap().len(), 1);
                                                
        record_play_at(&d, "u", ID1, "Video One", "Chan", 125.0, now + 10);
        record_play_at(&d, "u", ID2, "Video Two", "Chan", 0.0, now + 11);
        record_play_at(&d, "u", ID1, "Video One", "Chan", 125.0, now + 12);                  
        let (_, body) = call(&d, "u", "GET", "/home", "", now + 13);
        let v: Value = serde_json::from_str(&body).unwrap();
        let r = v["recent"].as_array().unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["id"], ID1);
        assert_eq!(r[0]["duration"], "2:05");
        assert_eq!(r[0]["at"], now + 12);
        assert_eq!(r[1]["id"], ID2);
        assert_eq!(r[1]["duration"], "");                                   
                                     
        let (_, body) = call(&d, "v", "GET", "/home", "", now + 14);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["quick"].as_array().unwrap().len(), 0);
        assert_eq!(v["recent"].as_array().unwrap().len(), 0);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn home_quick_cap() {
        let d = dir(); let now = 1_700_000_000_000i64;
        for i in 0..25 {
            let vid = format!("vid{i:08}");                            
            assert_eq!(call(&d, "u", "POST", "/quick", &json!({"id": vid, "title": format!("t{i}")}).to_string(), now + i as i64).0, 200);
        }
        let (_, body) = call(&d, "u", "GET", "/home", "", now + 100);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["quick"].as_array().unwrap().len(), super::QUICK_CAP);
        std::fs::remove_dir_all(&d).ok();
    }
}
