                                                                              
                                                                            
                                                        
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use crate::AppState;

                              
const MIME: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"), (".js", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"), (".svg", "image/svg+xml"), (".webmanifest", "application/manifest+json"),
    (".png", "image/png"), (".jpg", "image/jpeg"), (".webp", "image/webp"), (".woff2", "font/woff2"),
    (".json", "application/json"), (".ico", "image/x-icon"), (".mp4", "video/mp4"),
    (".wasm", "application/wasm"), (".mjs", "text/javascript; charset=utf-8"),
];

                                                                                       
fn r32_prefix_allowed(path: &str) -> bool {
                                                                              
                                                                  
    !path.ends_with(".map") && (path.starts_with("/assets/") || path.starts_with("/skin/") || path.starts_with("/a/")
        || matches!(path, "/favicon.svg" | "/favicon.ico" | "/favicon-32.png" | "/icon-192.png" | "/icon-512-maskable.png" | "/apple-touch-icon.png"
            | "/logo-512.png" | "/manifest.webmanifest"))
}

                                                                                      
const COMPRESSIBLE: &[&str] = &[".js", ".mjs", ".css", ".html", ".json", ".svg", ".wasm"];
static ZCACHE: std::sync::Mutex<Option<std::collections::HashMap<String, axum::body::Bytes>>> =
    std::sync::Mutex::new(None);

fn zget(key: &str) -> Option<axum::body::Bytes> {
    ZCACHE.lock().unwrap().as_ref().and_then(|m| m.get(key).cloned())
}
fn zput(key: String, v: Vec<u8>) -> axum::body::Bytes {
    let v = axum::body::Bytes::from(v);
    let mut g = ZCACHE.lock().unwrap();
    let m=g.get_or_insert_with(Default::default);const CAP:usize=32*1024*1024;
    if v.len()<=CAP{m.remove(&key);while m.len()>=128||m.values().map(|v|v.len()).sum::<usize>().saturating_add(v.len())>CAP{if let Some(old)=m.keys().next().cloned(){m.remove(&old);}else{break}}m.insert(key,v.clone());}
    v
}

                                                                            
                                                                             
                                                                            
pub fn resolve_safe(dist: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let joined = dist.join(rel_path);
    if !joined.is_file() { return None; }
                                                                            
    let canon = joined.canonicalize().ok()?;
    let canon_dist = dist.canonicalize().ok()?;
    if !canon.starts_with(&canon_dist) { return None; }
    Some(joined)
}

fn bundled_font(path: &str) -> Option<&'static [u8]> {
    match path {
        "/assets/IBMPlexSans-var-IvpUvPa2.woff2" | "/assets/fonts/IBMPlexSans-var.woff2" => Some(include_bytes!("../assets/fonts/IBMPlexSans-var.woff2")),
        "/assets/IBMPlexMono-400-normal-DMJ8VG8y.woff2" | "/assets/fonts/IBMPlexMono-400-normal.woff2" => Some(include_bytes!("../assets/fonts/IBMPlexMono-400-normal.woff2")),
        "/assets/IBMPlexMono-500-normal-DSY6xOcd.woff2" | "/assets/fonts/IBMPlexMono-500-normal.woff2" => Some(include_bytes!("../assets/fonts/IBMPlexMono-500-normal.woff2")),
        _ => None,
    }
}

fn bundled_response(bytes:&'static [u8],mime:&str,req:&Request<Body>)->Response{
    use sha2::{Digest,Sha256};
    static TAGS:std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<usize,String>>>=std::sync::OnceLock::new();
    let etag={let mut m=TAGS.get_or_init(Default::default).lock().unwrap_or_else(|e|e.into_inner());m.entry(bytes.as_ptr() as usize).or_insert_with(||format!("\"{:x}\"",Sha256::digest(bytes))).clone()};
    let matched=req.headers().get(header::IF_NONE_MATCH).and_then(|v|v.to_str().ok()).is_some_and(|s|s.split(',').any(|v|v.trim()==etag||v.trim()=="*"||v.trim().strip_prefix("W/")==Some(etag.as_str())));
    let b=Response::builder().status(if matched{StatusCode::NOT_MODIFIED}else{StatusCode::OK})
        .header(header::ETAG,etag).header(header::CACHE_CONTROL,"public, max-age=0, must-revalidate").header("x-content-type-options","nosniff");
    if matched{return b.body(Body::empty()).unwrap()}
    b.header(header::CONTENT_TYPE,mime).header(header::CONTENT_LENGTH,bytes.len()).body(if req.method()==axum::http::Method::HEAD{Body::empty()}else{Body::from(bytes)}).unwrap()
}

pub async fn serve(State((_, dist)): State<(Arc<AppState>, PathBuf)>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let bundle=if path=="/assets/fonts/OFL-IBM-Plex.txt"{Some((include_bytes!("../assets/fonts/OFL-IBM-Plex-LICENSE.txt").as_slice(),"text/plain; charset=utf-8"))}else{bundled_font(&path).map(|b|(b,"font/woff2"))};
    if let Some((bytes,mime))=bundle{
        let mut r=bundled_response(bytes,mime,&req);
        if path.starts_with("/assets/IBMPlex"){r.headers_mut().insert(header::CACHE_CONTROL,"public, max-age=31536000, immutable".parse().unwrap());}
        return r
    }

    if !r32_prefix_allowed(&path) { return axum::response::Response::builder().status(StatusCode::NOT_FOUND).header(axum::http::header::CONTENT_TYPE, "text/plain").body(axum::body::Body::from("nothing here")).unwrap(); }
    let rel = path.trim_start_matches('/');
    let safe = match resolve_safe(&dist, rel) {
        Some(p) => p,
        None => return axum::response::Response::builder().status(StatusCode::NOT_FOUND).header(axum::http::header::CONTENT_TYPE, "text/plain").body(axum::body::Body::from("nothing here")).unwrap(),
    };
    let meta = match std::fs::metadata(&safe) { Ok(m) => m, Err(_) => return axum::response::Response::builder().status(StatusCode::NOT_FOUND).header(axum::http::header::CONTENT_TYPE, "text/plain").body(axum::body::Body::from("nothing here")).unwrap() };
    let etag = format!("W/\"{}-{}\"", meta.len(), meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0));
    if req.headers().get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }
    let ext = safe.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mime = MIME.iter().find(|(k, _)| *k == ext).map(|(_, v)| *v).unwrap_or("application/octet-stream");
    let engine = rel.starts_with("skin/") || rel.starts_with("assets/codec/") || rel.starts_with("assets/player/")
        || rel.starts_with("assets/net/") || rel.starts_with("assets/net2/") || rel == "a/player-boot.js";
    let cc = if engine { "no-cache" } else { "public, max-age=31536000, immutable" };
    let bytes = match tokio::fs::read(&safe).await {
        Ok(b) => b,
        Err(_) => return axum::response::Response::builder().status(StatusCode::NOT_FOUND).header(axum::http::header::CONTENT_TYPE, "text/plain").body(axum::body::Body::from("nothing here")).unwrap(),
    };
                                                                                      
                                                                                    
    let mut body = axum::body::Bytes::from(bytes);
    let mut encoding: Option<&'static str> = None;
                                                                                     
                                                    
    let compressible = COMPRESSIBLE.contains(&ext.as_str()) && body.len() > 1024;
    if compressible {
        let ae = req.headers().get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("");
        let want_br = ae.split(',').any(|t| t.trim().starts_with("br"));
        let want_gz = ae.split(',').any(|t| t.trim().starts_with("gzip"));
        let enc = if want_br { Some("br") } else if want_gz { Some("gzip") } else { None };
        if let Some(e) = enc {
            let key = format!("{e}:{safe:?}:{etag}");
            let z=match zget(&key){Some(z)=>z,None=>{
                let input=body.clone();let key2=key.clone();
                match tokio::task::spawn_blocking(move||{
                    use std::io::Write;
                    let compressed=if e=="br"{let mut w=brotli::CompressorWriter::new(Vec::new(),4096,6,22);w.write_all(&input).map(|_|w.into_inner()).unwrap_or_default()}
                        else{let mut w=flate2::write::GzEncoder::new(Vec::new(),flate2::Compression::new(9));w.write_all(&input).map(|_|w.finish().unwrap_or_default()).unwrap_or_default()};
                    zput(key2,compressed)
                }).await{Ok(z)=>z,Err(_)=>axum::body::Bytes::new()}
            }};
            if !z.is_empty(){body=z;encoding=Some(e);}

        }
    }
    let mut b = Response::builder().status(200).header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cc).header(header::ETAG, etag);
    if compressible { b = b.header(header::VARY, "Accept-Encoding"); }
    if let Some(e) = encoding { b = b.header(header::CONTENT_ENCODING, e); }
    b=b.header(header::CONTENT_LENGTH,body.len());
    b.body(if req.method()==axum::http::Method::HEAD{Body::empty()}else{Body::from(body)}).unwrap()
}

#[cfg(test)]
mod bundled_font_tests {
    #[tokio::test]async fn font_etag_conditional_and_head(){
        use super::*;let bytes=bundled_font("/assets/fonts/IBMPlexSans-var.woff2").unwrap();
        let r=bundled_response(bytes,"font/woff2",&Request::builder().body(Body::empty()).unwrap());assert_eq!(r.status(),StatusCode::OK);let tag=r.headers()[header::ETAG].clone();assert_eq!(axum::body::to_bytes(r.into_body(),1000000).await.unwrap().len(),bytes.len());
        let r=bundled_response(bytes,"font/woff2",&Request::builder().header(header::IF_NONE_MATCH,tag).body(Body::empty()).unwrap());assert_eq!(r.status(),StatusCode::NOT_MODIFIED);assert!(axum::body::to_bytes(r.into_body(),1000000).await.unwrap().is_empty());
        let r=bundled_response(bytes,"font/woff2",&Request::builder().method("HEAD").body(Body::empty()).unwrap());assert_eq!(r.headers()[header::CONTENT_LENGTH],bytes.len().to_string());assert!(axum::body::to_bytes(r.into_body(),1000000).await.unwrap().is_empty());
    }
    #[tokio::test]async fn hashed_engine_fonts_are_served_same_origin_immutable(){
        use super::*;let st=Arc::new(crate::auth_api::devices::tests::fixture("hashed-font-fixture"));
        for path in ["/assets/IBMPlexSans-var-IvpUvPa2.woff2","/assets/IBMPlexMono-400-normal-DMJ8VG8y.woff2","/assets/IBMPlexMono-500-normal-DSY6xOcd.woff2"]{
            let r=serve(State((st.clone(),PathBuf::from("/missing-dist"))),Request::builder().uri(path).body(Body::empty()).unwrap()).await;
            assert_eq!(r.status(),StatusCode::OK);assert_eq!(r.headers()[header::CACHE_CONTROL],"public, max-age=31536000, immutable");assert_eq!(r.headers()[header::CONTENT_TYPE],"font/woff2");
            let tag=r.headers()[header::ETAG].clone();assert!(axum::body::to_bytes(r.into_body(),1000000).await.unwrap().starts_with(b"wOF2"));
            let r=serve(State((st.clone(),PathBuf::new())),Request::builder().uri(path).header(header::IF_NONE_MATCH,tag).body(Body::empty()).unwrap()).await;assert_eq!(r.status(),StatusCode::NOT_MODIFIED);assert_eq!(r.headers()[header::CACHE_CONTROL],"public, max-age=31536000, immutable");
        }
    }
    #[test] fn stable_font_bytes_are_woff2() {
        for path in ["/assets/fonts/IBMPlexSans-var.woff2", "/assets/fonts/IBMPlexMono-400-normal.woff2", "/assets/fonts/IBMPlexMono-500-normal.woff2"] {
            assert!(super::bundled_font(path).unwrap().starts_with(b"wOF2"));
        }
        assert!(super::bundled_font("/assets/fonts/../secret").is_none());
    }
}
