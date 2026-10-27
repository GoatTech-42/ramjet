                                                                            
                                                                               
                                                                                 
                                                                                 
                                                                          
                                                                                     
                                                                                
                                                                                 
use axum::http::StatusCode;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::lite::{json_ord, json_err, OJ};
use super::{fresh_id, io_fail, js_len16, js_number, js_slice16, js_string, js_trim, js_ws_collapse,
            parse_body2, read_store, store_mutex, too_large, write_json, BodyErr, StoreRead};

const MAX_PLAYLISTS: usize = 20;
const MAX_TRACKS: usize = 100;

                                                                   
                                                                               
                                                                                  
fn dursec(v: Option<&Value>) -> f64 {
    let n=js_number(v);
    if n.is_finite() && n>=0.0 && n<9007199254740992.0 { n } else { 0.0 }
}
fn de_dursec<'de,D:serde::Deserializer<'de>>(d:D)->Result<f64,D::Error>{let v=Value::deserialize(d)?;Ok(dursec(Some(&v)))}
fn ser_dursec<S:serde::Serializer>(n:&f64,s:S)->Result<S::Ok,S::Error>{if n.fract()==0.0{s.serialize_u64(*n as u64)}else{s.serialize_f64(*n)}}

#[derive(Serialize, Deserialize, Clone)]
pub struct Track {
    pub key: String,
    pub src: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub dur: String,
    #[serde(rename = "durSec", deserialize_with = "de_dursec", serialize_with = "ser_dursec", default)]
    pub dur_sec: f64,
    pub art: String,
    pub stream: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
}

fn file(data_dir: &std::path::Path) -> std::path::PathBuf { data_dir.join("amp-playlists.json") }

                                                                                        
fn load(f: &std::path::Path, user: &str) -> Result<(Value, Vec<Playlist>), Response> {
    let all = match read_store(f) {
        StoreRead::Missing => serde_json::json!({}),
        StoreRead::Corrupt => return Err(io_fail()),
        StoreRead::Ok(v) => v,
    };
    let list: Vec<Playlist> = match all.get(user) {
        None => vec![],
        Some(v) if !v.is_array() => return Err(io_fail()),                                       
        Some(v) => serde_json::from_value(v.clone()).map_err(|_| io_fail())?,
    };
    Ok((all, list))
}

fn commit(f: &std::path::Path, mut all: Value, user: &str, list: &[Playlist]) -> Result<(), Response> {
    all[user] = serde_json::to_value(list).unwrap();
    write_json(f, &all).map_err(|_| io_fail())
}

                                                                  
fn clean_name(v: &Value) -> String { js_slice16(js_trim(&js_ws_collapse(&js_string(v))), 40).to_string() }                

                                            
fn clean_track(t: &Value) -> Option<Track> {
    if !t.is_object() { return None; }
    let src = js_string(&t["src"]);
    if src != "yt" && src != "sc" && src != "au" { return None; }
    let id = js_string(&t["id"]);
    let ok = match src.as_str() {
        "yt" => id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "sc" => (5..=15).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()),
        _ => (1..=24).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric()),
    };
    if !ok { return None; }
    let title = js_trim(&js_slice16(&js_string(&t["title"]), 200)).to_string();                                        
    if title.is_empty() { return None; }
    let art = js_string(&t["art"]);
    let d = dursec(t.get("durSec"));
    Some(Track {
        key: format!("{src}:{id}"),
        stream: format!("/api/apps/amp/stream?src={src}&id={id}"),
        art: if art.starts_with("/api/apps/amp/art?") { js_slice16(&art, 400) } else { String::new() },
        src, id, title,
        artist: js_slice16(&js_string(&t["artist"]), 200),
        album: js_slice16(&js_string(&t["album"]), 200),
        dur: js_slice16(&js_string(&t["dur"]), 8),
        dur_sec: d,
    })
}

fn find_pl(list: &[Playlist], id: &str) -> Option<usize> { list.iter().position(|p| p.id == id) }

                                                         
fn pl_summary(p: &Playlist) -> String {
    let art = p.tracks.first().map(|t| t.art.clone()).unwrap_or_default();
    format!("{{\"id\":{},\"name\":{},\"count\":{},\"art\":{}}}",
        serde_json::to_string(&p.id).unwrap(), serde_json::to_string(&p.name).unwrap(),
        p.tracks.len(), serde_json::to_string(&art).unwrap())
}

fn gone404() -> Response { json_err(StatusCode::NOT_FOUND, "that playlist is gone") }
fn bad400() -> Response { json_err(StatusCode::BAD_REQUEST, "bad request") }                   

pub fn handle(data_dir: &std::path::Path, user: &str, method: &str, sub: &str, query_id: Option<&str>, body: &[u8]) -> Response {
    let f = file(data_dir);
    let _m = store_mutex(&f);
    let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };                                               
    match (method, sub) {
        ("GET", "/playlists") => {
            let (_, list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
                                                    
            json_ord(StatusCode::OK, vec![
                ("ok", OJ::Bool(true)),
                ("playlists", OJ::Arr(list.iter().map(|p| OJ::Raw(pl_summary(p))).collect())),
            ])
        }
        ("POST", "/playlists") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return bad400(), Err(BodyErr::TooLarge) => return too_large() };
            let name = clean_name(&b["name"]);
            if name.is_empty() { return json_err(StatusCode::BAD_REQUEST, "give it a name first"); }
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            if list.len() >= MAX_PLAYLISTS { return json_err(StatusCode::BAD_REQUEST, "twenty playlists is plenty - delete one first"); }
            if list.iter().any(|p| p.name.to_lowercase() == name.to_lowercase()) { return json_err(StatusCode::BAD_REQUEST, "you already have one called that"); }
            let Some(id) = fresh_id(4, |x| list.iter().any(|p| p.id == x)) else { return io_fail() };       
            let pl = Playlist { id: id.clone(), name, tracks: vec![] };
                                                                  
            let leaf = format!("{{\"id\":{},\"name\":{},\"count\":0,\"art\":\"\"}}",
                serde_json::to_string(&pl.id).unwrap(), serde_json::to_string(&pl.name).unwrap());
            list.push(pl);
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("playlist", OJ::Raw(leaf))])
        }
        ("GET", "/playlists/tracks") => {
            let (_, list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let Some(i) = find_pl(&list, query_id.unwrap_or("")) else { return gone404() };
            let pl = &list[i];
                                                               
            json_ord(StatusCode::OK, vec![
                ("ok", OJ::Bool(true)),
                ("playlist", OJ::Raw(format!("{{\"id\":{},\"name\":{},\"tracks\":{}}}",
                    serde_json::to_string(&pl.id).unwrap(), serde_json::to_string(&pl.name).unwrap(),
                    serde_json::to_string(&pl.tracks).unwrap()))),
            ])
        }
        ("POST", "/playlists/add") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return bad400(), Err(BodyErr::TooLarge) => return too_large() };
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let Some(i) = find_pl(&list, &js_string(&b["id"])) else { return gone404() };
            let Some(track) = clean_track(&b["track"]) else { return json_err(StatusCode::BAD_REQUEST, "that song couldn't be saved") };
            if list[i].tracks.iter().any(|t| t.key == track.key) {
                                                         
                return json_ord(StatusCode::OK, vec![
                    ("ok", OJ::Bool(true)), ("already", OJ::Bool(true)), ("count", OJ::U64(list[i].tracks.len() as u64))]);
            }
            if list[i].tracks.len() >= MAX_TRACKS { return json_err(StatusCode::BAD_REQUEST, "this playlist is full (100 songs)"); }
            list[i].tracks.push(track);
            let count = list[i].tracks.len() as u64;
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("already", OJ::Bool(false)), ("count", OJ::U64(count))])
        }
        ("POST", "/playlists/remove") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return bad400(), Err(BodyErr::TooLarge) => return too_large() };
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let Some(i) = find_pl(&list, &js_string(&b["id"])) else { return gone404() };
            let idx = js_number(b.get("index"));
                                                                                         
            if idx.is_nan() || idx.fract() != 0.0 || idx < 0.0 || idx as usize >= list[i].tracks.len() {
                return json_err(StatusCode::BAD_REQUEST, "no song there");
            }
            list[i].tracks.remove(idx as usize);
            let count = list[i].tracks.len() as u64;
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("count", OJ::U64(count))])
        }
        ("POST", "/playlists/move") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return bad400(), Err(BodyErr::TooLarge) => return too_large() };
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let Some(i) = find_pl(&list, &js_string(&b["id"])) else { return gone404() };
            let idx = js_number(b.get("index"));
            let dir = js_number(b.get("dir"));
            let j = idx + if dir < 0.0 { -1.0 } else { 1.0 };                                      
            let n = list[i].tracks.len();
            if idx.is_nan() || idx.fract() != 0.0 || idx < 0.0 || idx as usize >= n || j < 0.0 || j as usize >= n {
                return json_err(StatusCode::BAD_REQUEST, "that song couldn't be moved");
            }
            let t = list[i].tracks.remove(idx as usize);
            list[i].tracks.insert(j as usize, t);
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
            super::ok_true()
        }
        ("POST", "/playlists/rename") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return bad400(), Err(BodyErr::TooLarge) => return too_large() };
            let (all, mut list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let Some(i) = find_pl(&list, &js_string(&b["id"])) else { return gone404() };
            let name = clean_name(&b["name"]);
            if name.is_empty() { return json_err(StatusCode::BAD_REQUEST, "give it a name first"); }
            list[i].name = name;
            if commit(&f, all, user, &list).is_err() { return io_fail(); }
            super::ok_true()
        }
        ("POST", "/playlists/delete") => {
            let b = match parse_body2(body, 65536) { Ok(Some(v)) => v, Ok(None) => return bad400(), Err(BodyErr::TooLarge) => return too_large() };
            let (all, list) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            let id = js_string(&b["id"]);
            let kept: Vec<Playlist> = list.into_iter().filter(|p| p.id != id).collect();
            let before = all[user].as_array().map(|a| a.len()).unwrap_or(0);
            if kept.len() == before { return gone404() }
            if commit(&f, all, user, &kept).is_err() { return io_fail(); }
            super::ok_true()
        }
        ("POST", "/playlists/clear") => {
                                                                                        
                                                                     
            if body.len() > 65536 { return too_large(); }
            let (all, _) = match load(&f, user) { Ok(x) => x, Err(r) => return r };
            if commit(&f, all, user, &[]).is_err() { return io_fail(); }
            super::ok_true()
        }
        _ => json_err(StatusCode::NOT_FOUND, "that didn't work"),
    }
}

                                                                                    
                                                                                     
                                      
                                                                              
                                                                              
                                                                               
                                                                              
                                                                          
                                                                                 
                                                                                
                                                                                
                                                                             
                                                                                
                                                                           
                                                                              
                                                                                  
                                                                                  
                                                                              
                                                                               
                                                                                
                                                                                  
                                                                              

                                                                             
                                                                                    
                                                                                 
                                                                                   
                                                                                   
                                                                                   

                                                       
pub fn stream_validate(bytes_left: i64, src: &str, id: &str) -> Option<Response> {
    if bytes_left <= 0 {
        return Some(crate::lite::json_err(StatusCode::TOO_MANY_REQUESTS, "the streaming limit has been reached."));
    }
    let id = js_trim(id);
    match src {
        "yt" => {
            if !(id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
                return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad id"));
            }
            None                                                         
        }
        "sc" => {
            if !((5..=15).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())) {
                return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad id"));
            }
            None                                            
        }
        "au" => {
            if !((1..=24).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())) {
                return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad id"));
            }
            None                                                  
        }
        _ => Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "that source didn't work")),
    }
}

fn unb64(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s))
        .ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
}

pub fn art_validate(src: &str, id: &str, u: &str) -> Option<Response> {
    match src {
        "yt" => {
            let id = js_trim(id);
            if !(id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
                return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad id"));
            }
            None                                                                                     
        }
        "sc" => {
            let d = unb64(u);
            let ok = url::Url::parse(&d).map(|p| p.scheme() == "https"
                && p.host_str().map(|h| h == "sndcdn.com" || h.ends_with(".sndcdn.com")).unwrap_or(false)
                && p.username().is_empty() && p.password().is_none()).unwrap_or(false);
            if !ok { return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad url")); }
            None                      
        }
        "au" => {
                                                                                    
                                                                                 
                                                               
                                                                                   
                                                                                 
                                                                                
                                                                                   
            let d = unb64(u);
                                                                
            static AU_PATH: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(||
                regex::Regex::new(r"(?i)^/content/[A-Za-z0-9]{20,64}/[0-9]{2,4}x[0-9]{2,4}\.(jpg|jpeg|png|webp)$").unwrap());
            let ok = url::Url::parse(&d).map(|p| {
                p.scheme() == "https" && p.username().is_empty() && p.password().is_none() && AU_PATH.is_match(p.path())
            }).unwrap_or(false);
            if !ok { return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "bad url")); }
            None                      
        }
        _ => Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "that source didn't work")),
    }
}

                                                                                      
                                                                               
                                                                           
                                                                                 
                                                                             
                                                                                     
pub fn search_validate(q: &str) -> Option<Response> {
    let q = js_trim(q);                           
    if q.is_empty() { return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "search for something first")); }
    if js_len16(q) > 120 { return Some(crate::lite::json_err(StatusCode::BAD_REQUEST, "keep searches under 120 characters")); }
    None
}
#[cfg(test)]mod dursec_target_tests{
 use super::*;use serde_json::json;
 #[test]fn identical_load_and_accept(){for(v,want)in [(json!(12),12.0),(json!(45.7),45.7),(json!(9007199254740991u64),9007199254740991.0),(json!(9007199254740992u64),0.0),(json!(1e30),0.0),(json!(-1),0.0),(json!("12"),12.0)]{
  let mut row=json!({"src":"yt","id":"abcdefghijk","title":"t","durSec":v});let t=clean_track(&row).unwrap();assert_eq!(t.dur_sec,want);row=serde_json::to_value(t).unwrap();let text=serde_json::to_string(&row).unwrap();if want.fract()==0.0{assert!(!text.contains(&format!("\"durSec\":{want}.0")))}let loaded:Track=serde_json::from_value(row).unwrap();assert_eq!(loaded.dur_sec,want)
 }}
}
