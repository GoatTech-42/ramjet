                                                  
                                                                                    
                                                                               
                                                                                       
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use futures::StreamExt;
use std::collections::HashMap;
use super::{json_err_x, qparam, Shared};
use super::ssrf::SsrfErr;
use serde_json::json;

const MAX_IMG: usize = 15_000_000;
const MAX_VID: usize = 80_000_000;

                                                                                   
fn err(status: StatusCode, msg: &str) -> Response { json_err_x(status, json!({"error": msg.chars().take(160).collect::<String>()})) }

                                                                                       
                                                                                     
                                                                                       
                                                                                    
                                                                                    
                                                         
fn failed_500() -> Response {
                                                                                       
                                                                                 
                                                                                        
    let body = axum::body::Body::from_stream(futures::stream::once(
        std::future::ready(Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"{\"ok\":false,\"error\":\"failed\"}"))),
    ));
    let r = Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(body)
        .unwrap();
    r
}

fn media_err(e: SsrfErr) -> Response {
    match e {
        SsrfErr::Transport => failed_500(),
        SsrfErr::Msg(m) => err(StatusCode::BAD_GATEWAY, &m),
    }
}

async fn ff_jpeg(buf: &[u8], full: bool) -> Result<Vec<u8>, SsrfErr> {
    let dir = super::tmp_path("img");
    std::fs::create_dir_all(&dir).map_err(|_| SsrfErr::Transport)?;                                                    
    let f = dir.join("in.bin");
    std::fs::write(&f, buf).map_err(|_| SsrfErr::Transport)?;
    let vf = if full { "scale='min(4096,iw)':-2,format=yuvj420p" } else { "scale='min(1600,iw)':-2,format=yuvj420p" };
    let q = if full { "2" } else { "4" };
    let mut cmd = tokio::process::Command::new("nice");
    cmd.args(["-n", "10", "ffmpeg", "-v", "error", "-i"])
        .arg(&f).args(["-frames:v", "1", "-vf", vf, "-q:v", q, "-f", "mjpeg", "pipe:1"]).kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    let _ = std::fs::remove_dir_all(&dir);
    match out {
        Ok(Ok(o)) if o.status.success() && !o.stdout.is_empty() => Ok(o.stdout),
        Err(_) => Err(SsrfErr::Msg("could not read that image".into())),                                                                          
        Ok(Err(_)) => Err(SsrfErr::Transport),                                                                        
        _ => Err(SsrfErr::Msg("could not read that image".into())),                                        
    }
}

async fn heif_jpeg(buf: &[u8]) -> Result<Vec<u8>, SsrfErr> {
    let dir = super::tmp_path("heif");
    std::fs::create_dir_all(&dir).map_err(|_| SsrfErr::Transport)?;
    std::fs::write(dir.join("in.heic"), buf).map_err(|_| SsrfErr::Transport)?;
    let mut cmd = tokio::process::Command::new("nice");
    cmd.args(["-n", "10", "heif-convert", "-q", "90"])
        .arg(dir.join("in.heic")).arg(dir.join("out.jpg")).kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    let bytes = match out {
        Ok(Ok(o)) if o.status.success() => std::fs::read(dir.join("out.jpg")).map_err(|_| SsrfErr::Transport),                                         
        Err(_) => Err(SsrfErr::Msg("heif".into())),                                                                    
        Ok(Err(_)) => Err(SsrfErr::Transport),                                                                       
        _ => Err(SsrfErr::Msg("heif".into())),                                
    };
    let _ = std::fs::remove_dir_all(&dir);
    bytes
}

fn media_headers(buf: Vec<u8>, mime: &str, filename: &str) -> Response {
    Response::builder()
        .header(axum::http::header::CONTENT_TYPE, mime)
        .header(axum::http::header::CONTENT_LENGTH, buf.len())
        .header("content-disposition", format!("inline; filename=\"{filename}\""))
        .header(axum::http::header::CACHE_CONTROL, "private, max-age=3600")
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(buf))
        .unwrap()
}

async fn media_image(st: &crate::AppState, u: &str, full: bool) -> Result<Response, SsrfErr> {
                                                                                       
                                                                                     
                                                                                                                
                                                                                        
    let raw: Vec<u8> = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let (resp, _f) = super::ssrf::safe_get_stall_t(st, u, "image/*", std::time::Duration::from_secs(10)).await?;                                                   
                                                                                      
                                                                                  
        let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
        let re = regex::Regex::new(r"^(text|application/(json|xml))\b|html").unwrap();
        if resp.status().as_u16() != 200 || re.is_match(&ct) {
            return Err(SsrfErr::Msg("not an image".into()));
        }
        let mut raw: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        loop {
            let c = match tokio::time::timeout(std::time::Duration::from_secs(10), stream.next()).await {
                Err(_) => return Err(SsrfErr::Msg("timed out".into())),                              
                Ok(None) => break,
                Ok(Some(Err(e))) => return Err(if e.is_timeout() { SsrfErr::Msg("timed out".into()) } else { SsrfErr::Transport }),                                               
                Ok(Some(Ok(c))) => c,
            };
            if raw.len() + c.len() > MAX_IMG { return Err(SsrfErr::Msg("image too large".into())); }
            raw.extend_from_slice(&c);
        }
        Ok(raw)
    }).await.map_err(|_| SsrfErr::Msg("timed out".into()))??;
    let is_png = raw.len() >= 4 && raw[0] == 0x89 && raw[1] == 0x50 && raw[2] == 0x4e && raw[3] == 0x47;
    if full && is_png {
        return Ok(media_headers(raw, "image/png", "image.png"));
    }
    let is_heif = raw.len() > 12 && &raw[4..8] == b"ftyp"
        && matches!(&String::from_utf8_lossy(&raw[8..12]).to_string()[..], "avif" | "avis" | "heic" | "heix" | "heim" | "mif1" | "msf1");
    let out = if is_heif { ff_jpeg(&heif_jpeg(&raw).await?, full).await? } else { ff_jpeg(&raw, full).await? };
    Ok(media_headers(out, "image/jpeg", "image.jpg"))
}

async fn media_video(st: &crate::AppState, u: &str) -> Result<Response, (StatusCode, SsrfErr)> {
    if st.lite.video_busy.compare_exchange(0, 1, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_err() {
        return Err((StatusCode::TOO_MANY_REQUESTS, SsrfErr::Msg("one video at a time, try again in a moment".into())));
    }
    let r = media_video_inner(st, u).await;
    st.lite.video_busy.store(0, std::sync::atomic::Ordering::SeqCst);
    r
}

async fn media_video_inner(st: &crate::AppState, u: &str) -> Result<Response, (StatusCode, SsrfErr)> {
                                                                                 
                                                                                
                                    
    let (resp, _f) = super::ssrf::safe_get_stall_t(st, u, "video/mp4,video/*", std::time::Duration::from_secs(10))
        .await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;                                                           
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_lowercase();
    if resp.status().as_u16() != 200 || !matches!(ct.as_str(), "video/mp4" | "video/quicktime" | "video/x-m4v") {
        return Err((StatusCode::BAD_GATEWAY, SsrfErr::Msg("not an mp4 (use /api/lite/video for YouTube ids)".into())));
    }
    let len = resp.content_length().unwrap_or(0);
    if len as usize > MAX_VID { return Err((StatusCode::BAD_GATEWAY, SsrfErr::Msg("video too large".into()))); }
                                                                                          
    let stream = futures::stream::try_unfold((resp, tokio::time::Instant::now(), 0usize), |(mut resp, start, mut n)| async move {
        if start.elapsed() > std::time::Duration::from_secs(30) {
            return Err(std::io::Error::new(std::io::ErrorKind::Other, "timed out"));               
        }
        match tokio::time::timeout(std::time::Duration::from_secs(10), resp.chunk()).await {
            Err(_) => Err(std::io::Error::new(std::io::ErrorKind::Other, "timed out")),                      
            Ok(Ok(None)) => Ok(None),
            Ok(Err(_)) => Err(std::io::Error::new(std::io::ErrorKind::Other, "upstream error")),                      
            Ok(Ok(Some(c))) => {
                n += c.len();
                if n > MAX_VID { Err(std::io::Error::new(std::io::ErrorKind::Other, "video too large")) } else { Ok(Some((c, (resp, start, n)))) }
            }
        }
    });
    let mut b = Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "video/mp4")
        .header("content-disposition", "inline; filename=\"video.mp4\"")
        .header(axum::http::header::CACHE_CONTROL, "private, no-store");
    if len > 0 { b = b.header(axum::http::header::CONTENT_LENGTH, len); }
    b.body(axum::body::Body::from_stream(stream)).map_err(|e| (StatusCode::BAD_GATEWAY, SsrfErr::Msg(e.to_string())))
}

fn fb_allowed(fb: &str) -> bool {
    url::Url::parse(fb).ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|h| {
            let re = regex::Regex::new(r"^(encrypted-tbn\d\.gstatic\.com|imgs\.search\.brave\.com|external-content\.duckduckgo\.com)$").unwrap();                                                                                             
            re.is_match(&h)
        })
        .unwrap_or(false)
}

pub async fn handler(State((st, _)): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let kind = qparam(&params, "kind");
    let u = qparam(&params, "u");
    match kind.as_str() {
        "image" => {
            match media_image(&st, &u, qparam(&params, "orig") == "1").await {
                Ok(r) => r,
                Err(e0) => {
                    let fb = qparam(&params, "fb");
                    if !fb_allowed(&fb) { return media_err(e0); }
                                                                                                
                    match media_image(&st, &fb, false).await { Ok(r) => r, Err(fbe) => media_err(fbe) }
                }
            }
        }
        "video" => match media_video(&st, &u).await {
            Ok(r) => r,
            Err((code, e)) => match e {
                SsrfErr::Msg(m) => err(code, &m),                                                                        
                SsrfErr::Transport => failed_500(),
            },
        },
        _ => err(StatusCode::BAD_REQUEST, "kind=image|video"),
    }
}
                                                                     
                                                                                   
#[cfg(test)]
mod fb_ddg_parity_tests {
    fn ok(s: &str) -> bool { super::fb_allowed(s) }

    #[test]
    fn accepts_new_ddg_thumb_host() {
        assert!(ok("https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fx.example%2Fa.jpg"));
        assert!(ok("https://EXTERNAL-CONTENT.DUCKDUCKGO.COM/iu/?u=x"));                             
    }
    #[test]
    fn preserves_existing_hosts() {
        assert!(ok("https://encrypted-tbn0.gstatic.com/images?q=tbn:abc"));
        assert!(ok("https://encrypted-tbn3.gstatic.com/images?q=tbn:abc"));
        assert!(ok("https://imgs.search.brave.com/abc.jpg"));
    }
    #[test]
    fn rejects_host_spoofs() {
        assert!(!ok("https://external-content.duckduckgo.com.evil.com/iu/?u=x"));                  
        assert!(!ok("https://evil-external-content.duckduckgo.com/iu/?u=x"));                      
        assert!(!ok("https://evil.com/?next=external-content.duckduckgo.com"));                     
        assert!(!ok("https://external-content.duckduckgo.com./iu/?u=x"));                                       
        assert!(!ok("https://external-content.duckduckgo.com@evil.com/iu/?u=x"));                                       
        assert!(!ok("https://external-content.duckduckgo.c\u{03BF}m/iu/?u=x"));                                                   
        assert!(!ok("https://xn--xternal-contentduckduckgo-x39e.com/iu/?u=x"));                                      
    }
    #[test]
    fn rejects_non_url_and_exotic() {
        assert!(!ok(""));
        assert!(!ok("not a url"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("//external-content.duckduckgo.com/x"));                             
    }
    #[test]
    fn ftp_scheme_note() {
                                                                                 
                                                                             
                                                                                       
        assert!(ok("ftp://external-content.duckduckgo.com/x"));                                                  
    }
}
