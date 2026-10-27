                                                                                      
                                                                                            
                                                                                          
                                                                               
                                                                               
                                                                                     
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};
use crate::lite::{json_ord, json_err, OJ};
use super::{io_fail, js_len16, millis, oj_num, parse_body2, read_store, store_mutex, too_large, write_json, BodyErr, StoreRead};

                               
const KEYS: [&str; 23] = ["rj-theme", "rj-layout", "rj-wall", "rj-tech", "rj-desk", "sage-style", "rj-note", "rj-todo", "amp-recent", "rj-browse-recent", "rj-browse-history", "js-later", "js-pos", "js-audio-only", "sage-conv-id", "sage-conversation", "rj-cloak", "rj-adblock", "rj-datasaver", "rj-autoclear", "js-searches", "amp-searches", "rj-browse-searches"];

fn file(data_dir: &std::path::Path) -> std::path::PathBuf { data_dir.join("user-prefs.json") }

                                                                                     
                                                                                  
                                                                                
fn validate_container(all: &Value, user: &str) -> Result<(), Response> {
    match all.get(user) {
        None => Ok(()),
        Some(u) if !u.is_object() || u.get("prefs").is_some_and(|p| !p.is_object()) => Err(io_fail()),
        Some(_) => Ok(()),
    }
}

pub fn get(data_dir: &std::path::Path, user: &str) -> Response {
    let f = file(data_dir);
    let _m = store_mutex(&f);
    let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };                                 
    let all = match read_store(&f) {
        StoreRead::Missing => json!({}),
        StoreRead::Corrupt => return io_fail(),                                
        StoreRead::Ok(v) => v,
    };
    if let Err(r) = validate_container(&all, user) { return r; }
    let m = &all[user];                                                   
    let prefs = &m["prefs"];
    let pairs: Vec<(String, OJ)> = KEYS.iter()
        .filter_map(|k| prefs[k].as_str().map(|v| (k.to_string(), OJ::Str(v.to_string()))))
        .collect();
                                   
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("prefs", OJ::Obj(pairs)), ("ts", oj_num(m["ts"].as_f64().unwrap_or(0.0)))])
}

pub fn post(data_dir: &std::path::Path, user: &str, body: &[u8]) -> Response {
    let f = file(data_dir);
    let _m = store_mutex(&f);
    let _g = match _m.lock() { Ok(g) => g, Err(_) => return io_fail() };                                                                 
    let b = match parse_body2(body, 65536) {                             
        Ok(Some(v)) => v,
        Ok(None) => return json_err(StatusCode::BAD_REQUEST, "bad request"),                    
        Err(BodyErr::TooLarge) => return too_large(),                                            
    };
                                                                                     
                                                                              
                                                                  
    if !b.is_object() { return json_err(StatusCode::BAD_REQUEST, "bad request"); }
    let mut prefs = serde_json::Map::new();
    for k in KEYS {
        let v = &b["prefs"][k];
                                                                         
        if let Some(s) = v.as_str() { if js_len16(s) <= 60000 { prefs.insert(k.to_string(), json!(s)); } }
    }
                                                                                   
    let now = millis() as f64;
    let ts = match &b["ts"] {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()).map(|x| x.min(now + 60000.0)).unwrap_or(now),
        _ => now,
    };
    let mut all = match read_store(&f) {
        StoreRead::Missing => json!({}),
        StoreRead::Corrupt => return io_fail(),                                         
        StoreRead::Ok(v) => v,
    };
    if let Err(r) = validate_container(&all, user) { return r; }
    all[user] = json!({ "prefs": Value::Object(prefs), "ts": ts });
    if write_json(&f, &all).is_err() { return io_fail(); }                          
                            
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("ts", oj_num(ts))])
}
