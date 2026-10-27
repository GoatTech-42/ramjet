                                                                                              
                                                                           
                                                                             
                                                                            
                                                                
                                                                      
                                                                      
                                                                              
                           
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use crate::apps;
use crate::lite::{json_ord, json_err, OJ};
use crate::searx_fetch::enc_component;

                                                                             
pub const META_HOST: &str = "https://v3-cinemeta.strem.io";
pub const SUGGEST_HOST: &str = "https://v2.sg.media-imdb.com";
pub const POSTER_HOSTS: [&str; 2] = ["images.metahub.space", "m.media-amazon.com"];

const CATALOG_TTL: Duration = Duration::from_secs(6 * 3600);                   
const SEARCH_TTL: Duration = Duration::from_secs(3600);                       
const IMG_TTL: Duration = Duration::from_secs(6 * 3600);
const JSON_CAP: usize = 4 * 1024 * 1024;
const IMG_CAP: usize = 8 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

                                                                             
                        
const FALLBACK_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"300\" height=\"450\" viewBox=\"0 0 300 450\"><rect width=\"300\" height=\"450\" fill=\"#0a0a0a\"/><rect x=\"8\" width=\"16\" height=\"450\" fill=\"#1f1f1f\"/><rect x=\"276\" width=\"16\" height=\"450\" fill=\"#1f1f1f\"/><g fill=\"#0a0a0a\"><rect x=\"12\" y=\"20\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"20\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"56\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"56\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"92\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"92\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"128\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"128\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"164\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"164\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"200\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"200\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"236\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"236\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"272\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"272\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"308\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"308\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"344\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"344\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"380\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"380\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"12\" y=\"416\" width=\"8\" height=\"12\" rx=\"2\"/><rect x=\"280\" y=\"416\" width=\"8\" height=\"12\" rx=\"2\"/></g><rect x=\"40\" y=\"20\" width=\"220\" height=\"410\" fill=\"none\" stroke=\"#1f1f1f\" stroke-width=\"2\"/><text x=\"150\" y=\"220\" fill=\"#4d4d4d\" font-family=\"monospace\" font-size=\"30\" text-anchor=\"middle\" letter-spacing=\"6\">flick</text><text x=\"150\" y=\"246\" fill=\"#333333\" font-family=\"monospace\" font-size=\"12\" text-anchor=\"middle\">no poster</text></svg>";

pub fn valid_type(t: &str) -> bool { matches!(t, "movie" | "series") }
pub fn valid_id(id: &str) -> bool {
    id.len() >= 9 && id.len() <= 10 && id.starts_with("tt") && id[2..].bytes().all(|b| b.is_ascii_digit())
}

                                                                                   
struct JsonCache { map: HashMap<String, (Instant, Duration, Value)> }
fn json_cache() -> &'static Mutex<JsonCache> {
    static C: OnceLock<Mutex<JsonCache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(JsonCache { map: HashMap::new() }))
}
fn cache_get(key: &str) -> Option<Value> {
    let c = json_cache().lock().ok()?;
    let (at, ttl, v) = c.map.get(key)?;
    if at.elapsed() < *ttl { Some(v.clone()) } else { None }
}
fn cache_put(key: String, ttl: Duration, v: Value) {
    if let Ok(mut c) = json_cache().lock() {
        if c.map.len() >= 512 {
            c.map.retain(|_, (at, t, _)| at.elapsed() < *t);
            if c.map.len() >= 512 { c.map.clear(); }
        }
        c.map.insert(key, (Instant::now(), ttl, v));
    }
}

struct ImgEntry { at: Instant, ct: String, bytes: Vec<u8> }
fn img_cache() -> &'static Mutex<HashMap<String, ImgEntry>> {
    static C: OnceLock<Mutex<HashMap<String, ImgEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn upstream_fail() -> Response { json_err(StatusCode::BAD_GATEWAY, "that source is having a moment - try again soon") }

async fn fetch_json(st: &crate::AppState, url: &str) -> Result<Value, Response> {
    let eg = st.egress().map_err(|_| upstream_fail())?;
    let resp = eg.get(url).timeout(FETCH_TIMEOUT).send().await.map_err(|_| upstream_fail())?;
    if !resp.status().is_success() { return Err(upstream_fail()); }
    if resp.content_length().map(|n| n as usize > JSON_CAP).unwrap_or(false) { return Err(upstream_fail()); }
    let mut resp=resp;let mut bytes=Vec::new();while let Some(c)=resp.chunk().await.map_err(|_|upstream_fail())?{if bytes.len().saturating_add(c.len())>JSON_CAP{return Err(upstream_fail())}bytes.extend_from_slice(&c)}
    serde_json::from_slice(&bytes).map_err(|_| upstream_fail())
}

                                            
fn norm_meta_item(m: &Value, ty: &str) -> Option<Value> {
    let id = m.get("id").and_then(|x| x.as_str())?;
    if !valid_id(id) { return None; }
    let name = m.get("name").and_then(|x| x.as_str()).unwrap_or("");
    if name.is_empty() { return None; }
    Some(json!({
        "id": id, "type": ty, "name": name,
        "poster": m["poster"].as_str().unwrap_or(""),
        "year": m["year"].as_str().or_else(|| m["releaseInfo"].as_str()).unwrap_or(""),
    }))
}

fn norm_meta(m: &Value, ty: &str) -> Option<Value> {
    let id = m.get("id").and_then(|x| x.as_str())?;
    if !valid_id(id) { return None; }
    let name = m.get("name").and_then(|x| x.as_str()).unwrap_or("");
    if name.is_empty() { return None; }
    let mut o = json!({
        "id": id, "type": ty, "name": name,
        "poster": m["poster"].as_str().unwrap_or(""),
        "year": m["year"].as_str().or_else(|| m["releaseInfo"].as_str()).unwrap_or(""),
        "description": m["description"].as_str().unwrap_or(""),
        "runtime": m["runtime"].as_str().unwrap_or(""),
        "rating": m["imdbRating"].as_str().unwrap_or(""),
        "genres": m["genres"].as_array().cloned().unwrap_or_default(),
    });
    if ty == "series" {
        let vids: Vec<Value> = m["videos"].as_array().map(|a| a.iter().filter_map(|e| {
            let s = e["season"].as_i64()?;
            let ep = e["episode"].as_i64()?;
            Some(json!({
                "id": e["id"].as_str().unwrap_or(""),
                "season": s, "episode": ep,
                "title": e["title"].as_str().unwrap_or(""),
                "released": e["released"].as_str().unwrap_or(""),
            }))
        }).collect()).unwrap_or_default();
        o["videos"] = json!(vids);
    }
    Some(o)
}

fn parse_suggestions(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(d) = v.get("d").and_then(|x| x.as_array()) {
        for it in d {
            if out.len() >= 30 { break; }
            let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("");
            if !valid_id(id) { continue; }
            let ty = match it.get("qid").and_then(|x| x.as_str()).unwrap_or("") {
                "movie" => "movie",
                "tvSeries" | "tvMiniSeries" => "series",
                _ => continue,
            };
            let name = it.get("l").and_then(|x| x.as_str()).unwrap_or("");
            if name.is_empty() { continue; }
            let year = it.get("y").map(|y| y.to_string()).unwrap_or_default();
            let poster = it.get("i").and_then(|i| i.get("imageUrl")).and_then(|x| x.as_str()).unwrap_or("");
            out.push(json!({"id": id, "type": ty, "name": name, "poster": poster, "year": year}));
        }
    }
    out
}

fn parse_ia(v: &Value) -> Vec<Value> {
    v.pointer("/response/docs").and_then(|d| d.as_array()).map(|a| a.iter().filter_map(|d| {
        let identifier = d["identifier"].as_str()?.to_string();
        let title = match &d["title"] {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.first().and_then(|x| x.as_str()).unwrap_or("").to_string(),
            _ => String::new(),
        };
        let year = match &d["year"] {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        Some(json!({"source": "internet-archive", "identifier": identifier, "title": title, "year": year}))
    }).collect()).unwrap_or_default()
}

                             
fn img_host_ok(h: &str) -> bool {
    h == "images.metahub.space" || h == "media-amazon.com" || h.ends_with(".media-amazon.com")
        || h == "ssl-images-amazon.com" || h.ends_with(".ssl-images-amazon.com")
}

fn img_response(ct: String, bytes: Vec<u8>) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "public, max-age=86400, immutable".to_string())], bytes).into_response()
}
fn svg_fallback() -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, "image/svg+xml".to_string()), (header::CACHE_CONTROL, "public, max-age=300".to_string())], FALLBACK_SVG).into_response()
}

async fn img(st: &crate::AppState, query: &HashMap<String, String>) -> Response {
    let u = query.get("u").map(String::as_str).unwrap_or("");
    let Ok(parsed) = url::Url::parse(u) else { return json_err(StatusCode::BAD_REQUEST, "bad request") };
    if parsed.scheme() != "https" || !img_host_ok(parsed.host_str().unwrap_or("")) {
        return json_err(StatusCode::BAD_REQUEST, "bad request");
    }
    {
        if let Ok(c) = img_cache().lock() {
            if let Some(e) = c.get(u) {
                if e.at.elapsed() < IMG_TTL { return img_response(e.ct.clone(), e.bytes.clone()); }
            }
        }
    }
    let eg = match st.egress() { Ok(c) => c, Err(_) => return svg_fallback() };
    let resp = match eg.get(u).timeout(FETCH_TIMEOUT).send().await { Ok(r) => r, Err(_) => return svg_fallback() };
    if !resp.status().is_success() { return svg_fallback(); }
    if resp.content_length().map(|n| n as usize > IMG_CAP).unwrap_or(false) { return svg_fallback(); }
    let ct = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !ct.starts_with("image/") { return svg_fallback(); }
    let mut resp=resp;let mut bytes=Vec::new();loop{match resp.chunk().await{Ok(Some(c))=>{if bytes.len().saturating_add(c.len())>IMG_CAP{return svg_fallback()}bytes.extend_from_slice(&c)},Ok(None)=>break,Err(_)=>return svg_fallback()}}
    if bytes.is_empty() || bytes.len() > IMG_CAP { return svg_fallback(); }
    let bytes = bytes.to_vec();
    if let Ok(mut c) = img_cache().lock() {
        if c.len() >= 200 { c.clear(); }
        c.insert(u.to_string(), ImgEntry { at: Instant::now(), ct: ct.clone(), bytes: bytes.clone() });
    }
    img_response(ct, bytes)
}

                                                                                   
                                                                                      
                                                                                        
                                                                                       
                                                                                        
                                                                                    
                                                                                        
                                                                           
struct ApprovedFile { name: &'static str, size: u64, length: f64 }
struct ApprovedItem {
    work_id: &'static str, ty: &'static str, title: &'static str, year: &'static str,
    version: &'static str, license: &'static str, basis: &'static str, files: &'static [ApprovedFile],
}
const APPROVED: [(&str, ApprovedItem); 1] = [(
    "night-of-the-living-dead_1968",
    ApprovedItem {
        work_id: "tt0063350", ty: "movie",
        title: "Night of the Living Dead", year: "1968",
        version: "original 1968 black-and-white theatrical cut",
        license: "public-domain",
        basis: "work published oct 1968 without the then-required copyright notice (public domain in the US); archive.org item metadata: collection feature_films, color \"black & white\", runtime 5796s (~96.6 min, the theatrical cut). file record from live archive.org metadata 2026-10-22.",
        files: &[ApprovedFile { name: "Night of the Living Dead - (1968).mp4", size: 558_667_836, length: 5796.5 }],
    },
)];
fn rights_verdict(identifier: &str, work_id: &str, work_type: &str) -> Value {
    let Some((_, rec)) = APPROVED.iter().find(|(id, _)| *id == identifier) else {
        return json!({"rights_verified": false, "rights_basis": "no approved rights record for this exact archive item"});
    };
    if work_id.is_empty() {
        return json!({"rights_verified": false, "rights_basis": "work id missing - cannot bind the approved record to this work"});
    }
    if work_id != rec.work_id {
        return json!({"rights_verified": false, "rights_basis": format!("approved record is pinned to work {}, not {work_id}", rec.work_id)});
    }
    if work_type.is_empty() {
        return json!({"rights_verified": false, "rights_basis": "work type missing - cannot bind the approved record to this work"});
    }
    if work_type != rec.ty {
        return json!({"rights_verified": false, "rights_basis": format!("approved record is a {} pin, not {work_type}", rec.ty)});
    }
    json!({
        "rights_verified": true,
        "rights_basis": rec.basis,
        "version": rec.version,
        "license": rec.license,
        "approved_files": rec.files.iter().map(|f| json!({"name": f.name, "size": f.size, "length": f.length})).collect::<Vec<Value>>(),
    })
}

                                                                                 
async fn legal(st: &crate::AppState, query: &HashMap<String, String>) -> Response {
    let q = apps::js_trim(query.get("q").map(String::as_str).unwrap_or(""));
    if q.is_empty() || q.chars().count() > 120 { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
    let year = query.get("year").map(String::as_str).unwrap_or("");
    let year_ok = year.is_empty() || (year.len() == 4 && year.bytes().all(|b| b.is_ascii_digit()));
    if !year_ok { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
    let work_id = query.get("id").map(String::as_str).unwrap_or("");
    let work_ty = query.get("type").map(String::as_str).unwrap_or("");
    if !work_id.is_empty() && !valid_id(work_id) { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
    if !work_ty.is_empty() && !valid_type(work_ty) { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
    let key = format!("legal:{}:{}:{}:{}", q.to_lowercase(), year, work_id, work_ty);
    if let Some(v) = cache_get(&key) {
        return json_ord(StatusCode::OK, vec![
            ("ok", OJ::Bool(true)),
            ("items", OJ::Val(v["items"].clone())),
            ("archive_down", OJ::Bool(v["archive_down"].as_bool().unwrap_or(false))),
            ("youtube_down", OJ::Bool(v["youtube_down"].as_bool().unwrap_or(false))),
        ]);
    }
    let mut ia_q = format!("{} AND mediatype:movies", enc_component(&q));
    if !year.is_empty() { ia_q.push_str(&format!(" AND year:{}", year)); }
    let ia_url = format!("https://archive.org/advancedsearch.php?q={}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&rows=12&output=json", ia_q);
    let (ia_items, ia_down) = match fetch_json(st, &ia_url).await {
        Ok(v) => (parse_ia(&v), false),
        Err(_) => (Vec::new(), true),
    };
    let (yt_items, yt_down) = match crate::lite::yt::search_retry(st, &q).await {
        Ok(vs) => (vs.into_iter().map(|v| json!({
            "source": "youtube-free", "id": v.id, "title": v.title,
            "channel": v.channel, "duration": v.duration,
        })).collect::<Vec<Value>>(), false),
        Err(_) => (Vec::new(), true),
    };
    if ia_down && yt_down { return upstream_fail(); }
    let mut items = ia_items;
                                                                                     
                                                        
    let have: std::collections::HashSet<String> =
        items.iter().filter_map(|i| i["identifier"].as_str().map(String::from)).collect();
    for (id, rec) in APPROVED.iter() {
        if rec.work_id == work_id && !have.contains(*id) {
            items.insert(0, json!({"identifier": id, "source": "internet-archive", "title": rec.title, "year": rec.year}));
        }
    }
                                                                                      
                                                                     
    for i in items.iter_mut() {
        if i["source"].as_str() == Some("internet-archive") {
            let identifier = i["identifier"].as_str().unwrap_or("").to_string();
            if let Some(obj) = i.as_object_mut() {
                if let Some(v) = rights_verdict(&identifier, work_id, work_ty).as_object() { obj.extend(v.clone()); }
            }
        }
    }
    items.extend(yt_items);
    let cached = json!({"items": items, "archive_down": ia_down, "youtube_down": yt_down});
    cache_put(key, SEARCH_TTL, cached.clone());
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)),
        ("items", OJ::Val(cached["items"].clone())),
        ("archive_down", OJ::Bool(ia_down)),
        ("youtube_down", OJ::Bool(yt_down)),
    ])
}

                                                                               
fn store_path(data_dir: &Path, user: &str) -> PathBuf { data_dir.join("apps").join("flick").join(format!("{user}.json")) }

fn load(data_dir: &Path, user: &str) -> Result<Value, Response> {
    match apps::read_store(&store_path(data_dir, user)) {
        apps::StoreRead::Missing => Ok(json!({"watch": [], "progress": {}})),
        apps::StoreRead::Corrupt => Err(apps::io_fail()),
        apps::StoreRead::Ok(v) => if v.is_object() { Ok(v) } else { Err(apps::io_fail()) },
    }
}
fn save(data_dir: &Path, user: &str, v: &Value) -> Result<(), Response> {
    let p = store_path(data_dir, user);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|_| apps::io_fail())?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)); }
    }
    apps::write_json(&p, v).map_err(|_| apps::io_fail())                                
}
fn watch_key(id: &str, ty: &str) -> String { format!("{ty}:{id}") }
fn progress_key(id: &str, ty: &str, s: i64, e: i64) -> String {
    if ty == "series" { format!("{ty}:{id}:{s}:{e}") } else { watch_key(id, ty) }
}

                                                                                       
                                                                                  
                                                                            
                                                               
fn valid_ia_identifier(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && id.as_bytes()[0].is_ascii_alphanumeric()
}
                                                       
const IA_PLAYABLE_EXT: [&str; 8] = ["mp4", "m4v", "webm", "ogv", "mpg", "mp3", "ogg", "m4a"];
const IA_FILES_MAX: usize = 50;

fn ia_download_url(id: &str, name: &str) -> String {
    let segs: Vec<String> = name.split('/').map(enc_component).collect();
    format!("https://archive.org/download/{id}/{}", segs.join("/"))
}
fn parse_ia_files(id: &str, v: &Value) -> Value {
    let mut out = Vec::new();
    if let Some(arr) = v["files"].as_array() {
        for f in arr {
            if out.len() >= IA_FILES_MAX { break; }
            let name = f["name"].as_str().unwrap_or("");
            if name.is_empty() { continue; }
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if !IA_PLAYABLE_EXT.contains(&ext.as_str()) { continue; }
                                                                                 
                                                                         
            let size = f["size"].as_str().and_then(|s| s.parse::<u64>().ok())
                .or_else(|| f["size"].as_u64());
            let length = f["length"].as_str().and_then(|s| s.parse::<f64>().ok())
                .or_else(|| f["length"].as_f64());
            out.push(json!({
                "name": name,
                "format": f["format"].as_str().unwrap_or(""),
                "size": size,
                "length": length,
                "url": ia_download_url(id, name),
            }));
        }
    }
    json!(out)
}

async fn ia_files(st: &crate::AppState, query: &HashMap<String, String>) -> Response {
    let id = apps::js_trim(query.get("identifier").map(String::as_str).unwrap_or(""));
    if !valid_ia_identifier(id) { return json_err(StatusCode::BAD_REQUEST, "bad identifier"); }
    let key = format!("iaf:{id}");
    if let Some(files) = cache_get(&key) {
        return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("identifier", OJ::Str(id.to_string())), ("files", OJ::Val(files))]);
    }
    let url = format!("https://archive.org/metadata/{id}");
                                                                                                    
    let r = match super::amp_media::guarded_open(st, reqwest::Method::GET, &url,
            &[("user-agent", "ramjet-flick/1.0".to_string())], None, FETCH_TIMEOUT).await {
        Ok(r) => r, Err(_) => return upstream_fail(),
    };
    if !r.status().is_success() { return upstream_fail(); }
    let bytes = match super::amp_media::read_capped(r, JSON_CAP).await { Ok(b) => b, Err(_) => return upstream_fail() };
    let v: Value = match serde_json::from_slice(&bytes) { Ok(v) => v, Err(_) => return upstream_fail() };
    let files = parse_ia_files(id, &v);
    cache_put(key, SEARCH_TTL, files.clone());             
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("identifier", OJ::Str(id.to_string())), ("files", OJ::Val(files))])
}

pub async fn handle(st: &crate::AppState, user: &str, method: &str, sub: &str, query: &HashMap<String, String>, body: &[u8]) -> Response {
    let data_dir = &st.data_dir;
    match (sub, method) {
        ("ping", "GET") => json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true))]),

        ("trending", "GET") => {
            let ty = query.get("type").map(String::as_str).unwrap_or("movie");
            if !valid_type(ty) { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
            let key = format!("trending:{ty}");
            if let Some(items) = cache_get(&key) {
                return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("type", OJ::Str(ty.to_string())), ("items", OJ::Val(items))]);
            }
            let url = format!("{META_HOST}/catalog/{ty}/top.json");
            match fetch_json(st, &url).await {
                Err(r) => r,
                Ok(v) => {
                    let items: Vec<Value> = v["metas"].as_array().map(|a| a.iter().filter_map(|m| norm_meta_item(m, ty)).collect()).unwrap_or_default();
                    let val = json!(items);
                    cache_put(key, CATALOG_TTL, val.clone());
                    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("type", OJ::Str(ty.to_string())), ("items", OJ::Val(val))])
                }
            }
        }

        ("search", "GET") => {
            let q = apps::js_trim(query.get("q").map(String::as_str).unwrap_or(""));
            if q.is_empty() || q.chars().count() > 80 { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
            let key = format!("search:{}", q.to_lowercase());
            if let Some(items) = cache_get(&key) {
                return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Val(items))]);
            }
            let first = q.chars().next().unwrap().to_ascii_lowercase();
            let url = format!("{SUGGEST_HOST}/suggestion/{}/{}.json",enc_component(&first.to_string()), enc_component(&q));
            match fetch_json(st, &url).await {
                Err(r) => r,
                Ok(v) => {
                    let val = json!(parse_suggestions(&v));
                    cache_put(key, SEARCH_TTL, val.clone());
                    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Val(val))])
                }
            }
        }

        ("meta", "GET") => {
            let ty = query.get("type").map(String::as_str).unwrap_or("");
            let id = query.get("id").map(String::as_str).unwrap_or("");
            if !valid_type(ty) || !valid_id(id) { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
            let key = format!("meta:{ty}:{id}");
            if let Some(meta) = cache_get(&key) {
                return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("meta", OJ::Val(meta))]);
            }
            let url = format!("{META_HOST}/meta/{ty}/{id}.json");
            match fetch_json(st, &url).await {
                Err(r) => r,
                Ok(v) => {
                    if v["meta"].is_null() { return json_err(StatusCode::NOT_FOUND, "not found"); }
                    match norm_meta(&v["meta"], ty) {
                        None => json_err(StatusCode::NOT_FOUND, "not found"),
                        Some(meta) => {
                            cache_put(key, CATALOG_TTL, meta.clone());
                            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("meta", OJ::Val(meta))])
                        }
                    }
                }
            }
        }

        ("img", "GET") => img(st, query).await,
        ("legal", "GET") => legal(st, query).await,
        ("ia-files", "GET") => ia_files(st, query).await,

        ("watch", "GET") => match load(data_dir, user) {
            Err(r) => r,
            Ok(mut v) => {
                let mut items: Vec<Value> = v["watch"].as_array().cloned().unwrap_or_default();
                items.retain(|i| valid_id(i["id"].as_str().unwrap_or("")) && valid_type(i["type"].as_str().unwrap_or("")));
                items.sort_by_key(|i| -(i["updated"].as_i64().unwrap_or(0)));
                json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Arr(items.into_iter().map(OJ::Val).collect()))])
            }
        },
        ("watch", "POST") => {
            let Ok(v) = serde_json::from_slice::<Value>(body) else { return json_err(StatusCode::BAD_REQUEST, "bad request") };
            let id = v["id"].as_str().unwrap_or("").to_string();
            let ty = v["type"].as_str().unwrap_or("").to_string();
            if !valid_id(&id) || !valid_type(&ty) { return json_err(StatusCode::BAD_REQUEST, "bad request") }
            let title = apps::js_slice16(apps::js_trim(v["title"].as_str().unwrap_or("")), 120);
            if title.is_empty() { return json_err(StatusCode::BAD_REQUEST, "bad request") }
            let poster = v["poster"].as_str().unwrap_or("");
            let poster_ok = poster.is_empty() || (poster.starts_with("https://") && POSTER_HOSTS.iter().any(|h| {
                url::Url::parse(poster).ok().and_then(|u| u.host_str().map(|x| x.to_string())).map(|h2| h2 == *h || h2.ends_with(&format!(".{h}"))).unwrap_or(false)
            }));
            if !poster_ok { return json_err(StatusCode::BAD_REQUEST, "bad request") }
            let season = v["season"].as_i64().filter(|n| *n >= 0).unwrap_or(0);
            let episode = v["episode"].as_i64().filter(|n| *n >= 0).unwrap_or(0);
            let _m = apps::store_mutex(&store_path(data_dir, user)); let _g = match _m.lock() { Ok(g) => g, Err(_) => return apps::io_fail() };
            let mut store = match load(data_dir, user) { Err(r) => return r, Ok(s) => s };
            let key = watch_key(&id, &ty);
            let mut items: Vec<Value> = store["watch"].as_array().cloned().unwrap_or_default();
            items.retain(|i| i["key"].as_str() != Some(key.as_str()));
            items.insert(0, json!({"key": key, "id": id, "type": ty, "title": title, "poster": poster, "season": season, "episode": episode, "updated": apps::millis()}));
            items.truncate(100);
            store["watch"] = json!(items);
            match save(data_dir, user, &store) { Err(r) => r, Ok(()) => apps::ok_true() }
        }
        ("watch", "DELETE") => {
            let id = query.get("id").map(String::as_str).unwrap_or("");
            let ty = query.get("type").map(String::as_str).unwrap_or("");
            if !valid_id(id) || !valid_type(ty) { return json_err(StatusCode::BAD_REQUEST, "bad request") }
            let _m = apps::store_mutex(&store_path(data_dir, user)); let _g = match _m.lock() { Ok(g) => g, Err(_) => return apps::io_fail() };
            let key = watch_key(id, ty);
            let mut store = match load(data_dir, user) { Err(r) => return r, Ok(s) => s };
            let mut items: Vec<Value> = store["watch"].as_array().cloned().unwrap_or_default();
            items.retain(|i| i["key"].as_str() != Some(key.as_str()));
            store["watch"] = json!(items);
            match save(data_dir, user, &store) { Err(r) => r, Ok(()) => apps::ok_true() }
        }
        ("progress", "GET") => {
            let id = query.get("id").map(String::as_str).unwrap_or("");
            let ty = query.get("type").map(String::as_str).unwrap_or("");
            if !valid_id(id) || !valid_type(ty) { return json_err(StatusCode::BAD_REQUEST, "bad request") }
            let s = query.get("s").and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            let e = query.get("e").and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
            match load(data_dir, user) {
                Err(r) => r,
                Ok(v) => {
                    let p = v["progress"][progress_key(id, ty, s, e)].clone();
                    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("progress", OJ::Val(p))])
                }
            }
        }
        ("progress", "POST") => {
            let Ok(v) = serde_json::from_slice::<Value>(body) else { return json_err(StatusCode::BAD_REQUEST, "bad request") };
            let id = v["id"].as_str().unwrap_or("").to_string();
            let ty = v["type"].as_str().unwrap_or("").to_string();
            if !valid_id(&id) || !valid_type(&ty) { return json_err(StatusCode::BAD_REQUEST, "bad request") }
            let num = |k: &str| v[k].as_f64().filter(|n| n.is_finite() && *n >= 0.0).unwrap_or(0.0);
            let (position, duration) = (num("position"), num("duration"));
            let season = v["season"].as_i64().filter(|n| *n >= 0).unwrap_or(0);
            let episode = v["episode"].as_i64().filter(|n| *n >= 0).unwrap_or(0);
            let _m = apps::store_mutex(&store_path(data_dir, user)); let _g = match _m.lock() { Ok(g) => g, Err(_) => return apps::io_fail() };
            let mut store = match load(data_dir, user) { Err(r) => return r, Ok(s) => s };
            if !store["progress"].is_object() { store["progress"] = json!({}); }
            store["progress"][progress_key(&id, &ty, season, episode)] = json!({"position": position, "duration": duration, "updated": apps::millis()});
            if let Some(m)=store["progress"].as_object_mut(){while m.len()>500{let old=m.iter().min_by_key(|(_,v)|v["updated"].as_i64().unwrap_or(0)).map(|(k,_)|k.clone());if let Some(k)=old{m.remove(&k);}else{break}}}
            match save(data_dir, user, &store) { Err(r) => r, Ok(()) => apps::ok_true() }
        }

                                                                                   
                                                                    
        ("resolve" | "stream" | "dl" | "download" | "embed", _) =>
            json_err(StatusCode::NOT_IMPLEMENTED, "this part isn't ready yet."),
        _ => json_err(StatusCode::NOT_FOUND, "not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_types() {
        assert!(valid_id("tt0133093"));
        assert!(valid_id("tt12345678"));
        assert!(!valid_id("tt123"));                   
        assert!(!valid_id("tt123456789"));            
        assert!(!valid_id("nm0133093"));
        assert!(!valid_id("tt0133a93"));
        assert!(valid_type("movie") && valid_type("series"));
        assert!(!valid_type("show"));
    }

    #[test]
    fn meta_item_normalizes_and_filters() {
        let good = json!({"id":"tt0133093","name":"The Matrix","poster":"https://images.metahub.space/poster/small/tt0133093/img","releaseInfo":"1999"});
        let m = norm_meta_item(&good, "movie").unwrap();
        assert_eq!(m["id"], "tt0133093");
        assert_eq!(m["year"], "1999");
        assert_eq!(m["type"], "movie");
        assert!(norm_meta_item(&json!({"id":"bad","name":"x"}), "movie").is_none());
        assert!(norm_meta_item(&json!({"id":"tt0133093","name":""}), "movie").is_none());
    }

    #[test]
    fn suggestions_map_qid_and_cap() {
        let mut d = vec![];
        for i in 0..40 {
            d.push(json!({"id": format!("tt{:07}", i + 1000000), "l": format!("t{i}"), "y": 2000 + i, "qid": "movie", "i": {"imageUrl": "https://m.media-amazon.com/x.jpg"}}));
        }
        d.push(json!({"id":"tt9999999","l":"doc","qid":"tvMovie"}));                             
        d.push(json!({"id":"nm0000001","l":"person","qid":"movie"}));                  
        let out = parse_suggestions(&json!({"d": d}));
        assert_eq!(out.len(), 30);
        assert!(out.iter().all(|x| x["type"] == "movie"));
        let series = parse_suggestions(&json!({"d":[{"id":"tt0903747","l":"Breaking Bad","qid":"tvSeries","y":2008}]}));
        assert_eq!(series[0]["type"], "series");
        assert_eq!(series[0]["year"], "2008");
    }

    #[test]
    fn ia_files_validation_and_parse() {
        assert!(valid_ia_identifier("night_of_living_dead"));
        assert!(valid_ia_identifier("a.b-c_d"));
        assert!(!valid_ia_identifier(""));
        assert!(!valid_ia_identifier(".hidden"));
        assert!(!valid_ia_identifier("-lead"));
        assert!(!valid_ia_identifier("a/b"));                         
        assert!(!valid_ia_identifier("a%2fb"));                           
        assert!(!valid_ia_identifier(&"x".repeat(101)));
        let v = json!({"files": [
            {"name": "movie.mp4", "format": "h.264", "size": "558667836", "length": "5796.5"},
            {"name": "clip.mp4", "format": "h.264", "length": "123456"},
            {"name": "notes.txt", "format": "Text"},
            {"name": "sub/dir/track.mp3", "format": "MP3", "size": "999"},
            {"name": "noext", "format": "unknown"},
            {"name": "film.ogv"}
        ]});
        let files = parse_ia_files("my-item", &v);
        let arr = files.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0]["url"], "https://archive.org/download/my-item/movie.mp4");
        assert_eq!(arr[0]["size"], 558667836);
        assert_eq!(arr[0]["length"], 5796.5);                                       
        assert!(arr[1]["size"].is_null());                                                        
        assert_eq!(arr[1]["length"], 123456.0);
        assert_eq!(arr[2]["url"], "https://archive.org/download/my-item/sub/dir/track.mp3");
        assert_eq!(arr[2]["size"], 999);
        assert!(arr[3]["size"].is_null());
        assert!(arr[3]["length"].is_null());
    }

    #[test]
    fn rights_verdict_binding() {
                                                                                       
        let v = rights_verdict("night-of-the-living-dead_1968", "tt0063350", "movie");
        assert_eq!(v["rights_verified"], true);
        assert_eq!(v["approved_files"][0]["name"], "Night of the Living Dead - (1968).mp4");
        assert_eq!(v["approved_files"][0]["size"], 558_667_836u64);
        assert_eq!(v["approved_files"][0]["length"], 5796.5);
                                                    
        assert_eq!(rights_verdict("night-of-the-living-dead_1968", "", "movie")["rights_verified"], false);
        assert_eq!(rights_verdict("night-of-the-living-dead_1968", "tt0100258", "movie")["rights_verified"], false);
                                                                                               
        assert_eq!(rights_verdict("night-of-the-living-dead_1968", "tt0063350", "series")["rights_verified"], false);
        assert_eq!(rights_verdict("night-of-the-living-dead_1968", "tt0063350", "")["rights_verified"], false);
                                                                        
        assert_eq!(rights_verdict("NightOfTheLivingDead1968ColorizedGeorgeA.Romero", "tt0063350", "movie")["rights_verified"], false);
        assert_eq!(rights_verdict("night-of-the-living-dead_202110", "tt0063350", "movie")["rights_verified"], false);
                                                                                
        assert!(rights_verdict("night-of-the-living-dead_1968", "tt0100258", "movie")["approved_files"].is_null());
    }

    #[test]
    fn legal_cache_key_separates_work_and_type() {
        let k = |id: &str, ty: &str| format!("legal:{}:{}:{}:{}", "night of the living dead", "1968", id, ty);
        assert_ne!(k("tt0063350", "movie"), k("tt0100258", "movie"));                   
        assert_ne!(k("tt0063350", "movie"), k("tt0063350", "series"));                   
        assert_ne!(k("tt0063350", "movie"), k("", ""));                                       
        assert_ne!(k("tt0063350", "series"), k("", ""));
    }
    #[test]
    fn ia_docs_handle_string_and_array_titles() {
        let v = json!({"response":{"docs":[
            {"identifier":"night_of_living_dead","title":"Night of the Living Dead","year":"1968"},
            {"identifier":"multi","title":["A","B"],"year":1955},
            {"title":"no identifier"}
        ]}});
        let items = parse_ia(&v);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["source"], "internet-archive");
        assert_eq!(items[0]["identifier"], "night_of_living_dead");
        assert_eq!(items[1]["title"], "A");
        assert_eq!(items[1]["year"], "1955");
    }

    #[test]
    fn img_host_allowlist() {
        assert!(img_host_ok("images.metahub.space"));
        assert!(img_host_ok("m.media-amazon.com"));
        assert!(img_host_ok("images-na.ssl-images-amazon.com"));
        assert!(img_host_ok("media-amazon.com"));
        assert!(!img_host_ok("evilmedia-amazon.com"));
        assert!(!img_host_ok("media-amazon.com.evil.com"));
        assert!(!img_host_ok("notssl-images-amazon.com"));
        assert!(!img_host_ok("ssl-images-amazon.com.evil.com"));
        assert!(!img_host_ok("metahub.space"));
        assert!(!img_host_ok("images.metahub.space.evil.com"));
    }

    #[test]
    fn fallback_svg_is_branded_and_static() {
        assert!(FALLBACK_SVG.starts_with("<svg"));
        assert!(FALLBACK_SVG.contains("flick"));
    }

    #[test]
    fn watch_store_roundtrip_and_corrupt_500() {
        let dir = std::env::temp_dir().join(format!("flick-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = json!({"watch":[{"key":"movie:tt0133093","id":"tt0133093","type":"movie","title":"t","poster":"","season":0,"episode":0,"updated":1}],"progress":{}});
        save(&dir, "u1", &store).unwrap();
        let back = load(&dir, "u1").unwrap();
        assert_eq!(back["watch"][0]["id"], "tt0133093");
                                                       
        let empty = load(&dir, "nobody").unwrap();
        assert!(empty["watch"].as_array().unwrap().is_empty());
                                                                               
        let p = store_path(&dir, "u1");
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(load(&dir, "u1").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn series_meta_keeps_only_numbered_videos() {
        let m = json!({"id":"tt0903747","name":"BB","videos":[
            {"id":"tt1","season":1,"episode":2,"title":"ep","released":"2008"},
            {"id":"tt2","season":"1","episode":3},
            {"id":"tt3","title":"no se"}
        ]});
        let out = norm_meta(&m, "series").unwrap();
        let vids = out["videos"].as_array().unwrap();
        assert_eq!(vids.len(), 1);
        assert_eq!(vids[0]["episode"], 2);
    }
}
