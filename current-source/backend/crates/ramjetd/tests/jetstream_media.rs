use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use ramjetd::jetstream_media::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::Arc;
use std::time::{Duration, Instant};
use url::Url;

fn u(s: &str) -> Url { Url::parse(s).unwrap() }

                                                    

#[test]
fn media_hosts() {
    for ok in ["https://rr3---sn-abc123.googlevideo.com/videoplayback?x=1", "https://redirector.googlevideo.com/a"] { assert!(media_host_ok(&u(ok)), "{ok}"); }
    for bad in ["http://rr3.googlevideo.com/a", "https://googlevideo.com/a", "https://evilgooglevideo.com/a", "https://googlevideo.com.evil.com/a",
        "https://x.googlevideo.com:8443/a", "https://user@x.googlevideo.com/a", "https://127.0.0.1/a", "https://[::1]/a", "https://i.ytimg.com/a"] {
        assert!(!media_host_ok(&u(bad)), "{bad}");
    }
}

#[test]
fn thumb_hosts() {
    for ok in ["https://i.ytimg.com/vi/x/hq.jpg", "https://i9.ytimg.com/vi/x/hq.jpg", "https://i1.ytimg.com/a"] { assert!(thumb_host_ok(&u(ok)), "{ok}"); }
    for bad in ["http://i.ytimg.com/a", "https://ytimg.com/a", "https://evil-i.ytimg.com/a", "https://i12.ytimg.com/a", "https://i.ytimg.com.evil.com/a", "https://x.googlevideo.com/a"] { assert!(!thumb_host_ok(&u(bad)), "{bad}"); }
}

#[test]
fn range_parsing_and_fail_status() {
    assert_eq!(parse_range("bytes=0-99"), Some(Rng::From(0, Some(99))));
    assert_eq!(parse_range("bytes=100-"), Some(Rng::From(100, None)));
    assert_eq!(parse_range("bytes=-500"), Some(Rng::Suffix(500)));
    for bad in ["bytes=-", "bytes=0-1,5-9", "items=0-1", "bytes=a-b", " bytes=0-1", "bytes=0-1 ", ""] { assert_eq!(parse_range(bad), None, "{bad:?}"); }
    assert_eq!(parse_range("bytes=5-2"), None);                     
    assert_eq!(parse_range("bytes=99999999999999999999999-"), Some(Rng::From(u64::MAX, None)));                          
    assert_eq!((fail_status(202), fail_status(302), fail_status(403), fail_status(410), fail_status(500), fail_status(404)), (502, 502, 403, 410, 500, 404));
}

                                                                    

fn f(url: &str, vc: &str, ac: &str, w: u32, h: u32, fps: u32, abr: u32, ext: &str) -> Value {
    json!({"url": url, "protocol": "https", "vcodec": vc, "acodec": ac, "width": w, "height": h, "fps": fps, "abr": abr, "ext": ext, "format_note": format!("{h}p")})
}

#[test]
fn pick_1080_30fps_and_best_audio() {
    let d = json!({"channel": "Chan", "channel_id": "UC1", "duration": 61.5, "formats": [
        f("v1080_60", "avc1.640028", "none", 1920, 1080, 60, 0, "mp4"),
        f("v1080_30", "avc1.640028", "none", 1920, 1080, 30, 0, "mp4"),
        f("v2160", "avc1.640033", "none", 3840, 2160, 30, 0, "mp4"),
        f("v720", "avc1.4d401f", "none", 1280, 720, 30, 0, "mp4"),
        f("v360", "avc1.4d401e", "none", 640, 360, 30, 0, "mp4"),
        f("a48", "none", "mp4a.40.5", 0, 0, 0, 48, "m4a"),
        f("a128", "none", "mp4a.40.2", 0, 0, 0, 128, "m4a"),
        f("opus", "none", "opus", 0, 0, 0, 160, "webm"),
        f("vp9_1080", "vp09.00.40.08", "none", 1920, 1080, 30, 0, "webm"),
        f("vp9_720", "vp09.00.31.08", "none", 1280, 720, 30, 0, "webm"),
    ]});
    let e = build_entry(&d).unwrap();
    assert_eq!(e.hd, Some(Hd { video_url: "v1080_30".into(), audio_url: "a128".into(), quality: "1080p".into() }));                                            
    assert_eq!(e.hd_vp9.as_ref().unwrap().video_url, "vp9_1080");
    assert_eq!(e.hd_l.as_ref().unwrap().video_url, "v720");                               
    assert_eq!(e.hd_lvp9.as_ref().unwrap().video_url, "vp9_720");
    assert_eq!((e.channel.as_str(), e.channel_id.as_str(), e.duration, e.quality.as_str()), ("Chan", "UC1", 61.5, "1080p"));
}

#[test]
fn portrait_short_measures_short_side_and_keeps_60fps_when_only_option() {
    let d = json!({"formats": [
        f("short720_60", "avc1.64001f", "none", 720, 1280, 60, 0, "mp4"),
        f("a", "none", "mp4a.40.2", 0, 0, 0, 128, "m4a"),
    ]});
    let e = build_entry(&d).unwrap();
    assert_eq!(e.hd.as_ref().unwrap().video_url, "short720_60");                                   
    assert_eq!(e.hd_l.as_ref().unwrap().video_url, "short720_60");
}

#[test]
fn non_https_and_no_audio_means_no_hd() {
    let mut hls = f("v1080", "avc1.640028", "none", 1920, 1080, 30, 0, "mp4");
    hls["protocol"] = json!("m3u8_native");
    let d = json!({"formats": [hls, f("a", "none", "mp4a.40.2", 0, 0, 0, 128, "m4a")]});
    let e = build_entry(&d).unwrap();
    assert!(e.hd.is_none() && e.hd_vp9.is_none());
    let d = json!({"formats": [f("v1080", "avc1.640028", "none", 1920, 1080, 30, 0, "mp4")]});
    let e = build_entry(&d).unwrap();
    assert!(e.hd.is_none());
}

                                                                  

fn fake_ytdlp(dir: &std::path::Path, body_json: &str, sleep: &str, fail: bool) -> ResolveCfg {
    use std::os::unix::fs::PermissionsExt;
    let log = dir.join("calls.log");
    let script = dir.join("yt-dlp");
    let sh = format!("#!/bin/sh\necho \"$@\" >> {log}\nsleep {sleep}\n{}\ncat <<'JSON'\n{body_json}\nJSON\n", if fail { "echo 'ERROR: nope' >&2; exit 1" } else { "" }, log = log.display());
    std::fs::write(&script, sh).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    ResolveCfg { ytdlp: script, proxy: "socks5h://127.0.0.1:9".into() }
}
fn calls(dir: &std::path::Path) -> Vec<String> { std::fs::read_to_string(dir.join("calls.log")).unwrap_or_default().lines().map(String::from).collect() }

const HD_JSON: &str = r#"{"channel":"C","formats":[{"url":"vv","protocol":"https","vcodec":"avc1.1","acodec":"none","width":1920,"height":1080,"fps":30,"format_note":"1080p"},{"url":"aa","protocol":"https","vcodec":"none","acodec":"mp4a.40.2","abr":128,"ext":"m4a"}]}"#;
const NOHD_JSON: &str = r#"{"formats":[{"url":"mm","protocol":"https","vcodec":"avc1.1","acodec":"mp4a.40.2","width":640,"height":360,"ext":"mp4","format_note":"360p"},{"url":"m720","protocol":"https","vcodec":"avc1.1","acodec":"mp4a.40.2","width":1280,"height":720,"ext":"mp4","format_note":"720p"}]}"#;

#[tokio::test]
async fn resolve_args_cache_and_dedupe() {
    let dir = tempdir("rs1");
    let cfg = fake_ytdlp(&dir, HD_JSON, "0.4", false);
    let id = "AAAAAAAAAA1";
    let (a, b) = tokio::join!(resolve_stream(&cfg, id, false), resolve_stream(&cfg, id, false));
    assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
    assert_eq!(calls(&dir).len(), 1, "concurrent resolves share one yt-dlp");
    let c = calls(&dir)[0].clone();
    assert!(c.starts_with("--no-playlist --no-warnings --skip-download --extractor-args youtube:skip=hls,dash --proxy socks5h://127.0.0.1:9 -j -- https://www.youtube.com/watch?v=AAAAAAAAAA1"), "{c}");
    let t = Instant::now();
    resolve_stream(&cfg, id, false).await.unwrap();
    assert!(t.elapsed() < Duration::from_millis(100) && calls(&dir).len() == 1, "cache hit spawns nothing");
    resolve_stream(&cfg, id, true).await.unwrap();
    assert_eq!(calls(&dir).len(), 2, "force re-resolves");
                                            
    assert!(calls(&dir).iter().all(|l| !l.contains("player_client=android")));
}

#[tokio::test]
async fn no_hd_runs_android_for_muxed_360() {
    let dir = tempdir("rs2");
    let cfg = fake_ytdlp(&dir, NOHD_JSON, "0", false);
    let e = resolve_stream(&cfg, "BBBBBBBBBB2", false).await.unwrap();
    let c = calls(&dir);
    assert_eq!(c.len(), 2, "{c:?}");
    assert!(c[1].contains("--extractor-args youtube:player_client=android") && !c[1].contains("skip=hls"));
                                                          
    assert_eq!(mux_url(&cfg, "BBBBBBBBBB2", &e).await.as_deref(), Some("mm"));
    assert_eq!(calls(&dir).len(), 2, "mux url is memoized, no third spawn");
}

#[tokio::test]
async fn resolve_failures_use_the_human_string() {
    let dir = tempdir("rs3");
    let cfg = fake_ytdlp(&dir, "{}", "0", true);
    assert_eq!(resolve_stream(&cfg, "CCCCCCCCCC3", false).await.err().as_deref(), Some("can't load this video - try another"));
    let dir = tempdir("rs4");
    let cfg = fake_ytdlp(&dir, "not json", "0", false);
    assert_eq!(resolve_stream(&cfg, "DDDDDDDDDD4", false).await.err().as_deref(), Some("can't load this video - try another"));
    let dir = tempdir("rs5");
    let cfg = fake_ytdlp(&dir, r#"{"formats":[]}"#, "0", false);
    assert_eq!(resolve_stream(&cfg, "EEEEEEEEEE5", false).await.err().as_deref(), Some("no playable stream for this one"));
    let bad = ResolveCfg { ytdlp: "/nonexistent/yt-dlp".into(), proxy: String::new() };
    assert_eq!(resolve_stream(&bad, "FFFFFFFFFF6", false).await.err().as_deref(), Some("can't load this video - try another"));
}

fn tempdir(n: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("jsm-{n}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

                                                                                      

fn local_ok(u: &Url) -> bool { u.scheme() == "http" && u.host_str() == Some("127.0.0.1") }
const LOCAL: Policy = Policy { media_ok: local_ok, thumb_ok: local_ok, pin: false };

fn blob() -> Vec<u8> { (0..1000u32).map(|i| (i % 251) as u8).collect() }

#[derive(Clone, Default)]
struct Mock { hits: Arc<AtomicUsize>, sent: Arc<AtomicUsize>, ranges: Arc<std::sync::Mutex<Vec<String>>> }

                                                                                                           
                                                                                                              
                                                                                     
const MOCK_LM: &str = "Mon, 24 Jun 2024 02:22:13 GMT";
async fn vid(State(m): State<Mock>, req: Request) -> Response { vid_impl(m, req, true).await }
async fn vid_nolm(State(m): State<Mock>, req: Request) -> Response { vid_impl(m, req, false).await }
async fn vid_impl(m: Mock, req: Request, lm: bool) -> Response {
    m.hits.fetch_add(1, SeqCst);
    let data = blob();
    let rng = req.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    m.ranges.lock().unwrap().push(rng.clone().unwrap_or_default());
    let Some(r) = rng else {
        let mut b = Response::builder().header("content-type", "video/mp4").header("content-length", data.len());
        if lm { b = b.header("last-modified", MOCK_LM); }
        return b.body(Body::from(data)).unwrap();
    };
    let r = r.strip_prefix("bytes=").unwrap();
    let (a, b) = r.split_once('-').unwrap();
    let (a, b): (usize, usize) = if a.is_empty() { let n: usize = b.parse().unwrap(); (1000usize.saturating_sub(n), 999) } else { (a.parse().unwrap(), if b.is_empty() { 999 } else { b.parse::<usize>().unwrap().min(999) }) };
    if a >= 1000 { return Response::builder().status(416).header("content-range", "bytes */1000").body(Body::empty()).unwrap(); }
    let part = data[a..=b].to_vec();
    let mut resp = Response::builder().status(206).header("content-type", "video/mp4").header("content-range", format!("bytes {a}-{b}/1000")).header("content-length", part.len());
    if lm { resp = resp.header("last-modified", MOCK_LM); }
    resp.body(Body::from(part)).unwrap()
}

                                                                                                                    
async fn vid_flip(State(m): State<Mock>, req: Request) -> Response {
    let n = m.hits.fetch_add(1, SeqCst);
    let flipped = n >= 3;
    let data: Vec<u8> = if flipped { vec![0xFF; 1000] } else { blob() };
    let rng = req.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    m.ranges.lock().unwrap().push(rng.clone().unwrap_or_default());
    let lm = if flipped { "Tue, 25 Jun 2024 02:22:13 GMT" } else { MOCK_LM };
    let Some(r) = rng else { return Response::builder().header("last-modified", lm).header("content-length", data.len()).body(Body::from(data)).unwrap(); };
    let r = r.strip_prefix("bytes=").unwrap();
    let (a, b) = r.split_once('-').unwrap();
    let a: usize = a.parse().unwrap();
    let b: usize = if b.is_empty() { 999 } else { b.parse::<usize>().unwrap().min(999) };
    let part = data[a..=b].to_vec();
    Response::builder().status(206).header("content-type", "video/mp4").header("last-modified", lm).header("content-range", format!("bytes {a}-{b}/1000")).header("content-length", part.len()).body(Body::from(part)).unwrap()
}


                                                                                                         
                                                                                                        
                                                                                                      
async fn vid_sel(State(m): State<Mock>, req: Request) -> Response {
    m.hits.fetch_add(1, SeqCst);
    let path = req.uri().path().to_string();
    let hdr = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let (rng, ir) = (hdr("range"), hdr("if-range"));
    m.ranges.lock().unwrap().push(format!("{}|{}", rng.clone().unwrap_or_default(), ir.clone().unwrap_or_default()));
    let data = blob();
    let mut b = Response::builder().header("content-type", "video/mp4");
    match path.as_str() {
        "/vid-weak" => { b = b.header("etag", "W/\"w1\""); }
        "/vid-badlm" => { b = b.header("last-modified", "not a date"); }
        "/vid-both" => { b = b.header("etag", "\"e1\"").header("last-modified", MOCK_LM); }
        _ => { b = b.header("etag", "\"e1\""); }
    }
    let ir_mismatch = path == "/vid-ir" && ir.as_deref().is_some_and(|v| v != "\"e1\"");
    let Some(r) = rng.filter(|_| !ir_mismatch) else { return b.header("content-length", data.len()).body(Body::from(data)).unwrap(); };
    let r = r.strip_prefix("bytes=").unwrap();
    let (a, e) = r.split_once('-').unwrap();
    let a: usize = a.parse().unwrap();
    let e: usize = if e.is_empty() { 999 } else { e.parse::<usize>().unwrap().min(999) };
    let part = data[a..=e].to_vec();
    b.status(206).header("content-range", format!("bytes {a}-{e}/1000")).header("content-length", part.len()).body(Body::from(part)).unwrap()
}

async fn spawn_mock() -> (u16, Mock) {
    let m = Mock::default();
    let app = axum::Router::new()
        .route("/vid", get(vid))
        .route("/vid-nolm", get(vid_nolm))
        .route("/vid-flip", get(vid_flip))
        .route("/vid-zero", get(|State(m): State<Mock>, req: Request| async move {
                                                                                                                      
            m.hits.fetch_add(1, SeqCst);
            let probe = req.headers().get("range").and_then(|v| v.to_str().ok()) == Some("bytes=0-0");
            let (cr, body) = if probe { ("bytes 0-0/1000", vec![0u8]) } else { ("bytes 0-299/0", vec![0u8; 300]) };
            Response::builder().status(206).header("content-type", "video/mp4").header("etag", "\"z\"").header("content-range", cr).header("content-length", body.len()).body(Body::from(body)).unwrap()
        }))
        .route("/vid-weak", get(vid_sel)).route("/vid-badlm", get(vid_sel)).route("/vid-both", get(vid_sel)).route("/vid-ir", get(vid_sel))
        .route("/gone", get(|State(m): State<Mock>| async move { m.hits.fetch_add(1, SeqCst); StatusCode::FORBIDDEN }))
        .route("/boom", get(|| async { StatusCode::INTERNAL_SERVER_ERROR }))
        .route("/accepted", get(|| async { StatusCode::ACCEPTED }))
        .route("/nolen", get(|| async { Response::builder().body(Body::from("xx")).unwrap() }))
        .route("/r416", get(|| async { Response::builder().status(416).header("content-range", "bytes */777").body(Body::empty()).unwrap() }))
        .route("/endless", get(|State(m): State<Mock>| async move {
            let s = futures::stream::unfold(m.clone(), |m| async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                m.sent.fetch_add(1, SeqCst);
                Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![7u8; 1024])), m))
            });
            Response::builder().header("content-type", "video/mp4").body(Body::from_stream(s)).unwrap()
        }))
        .with_state(m.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap(); });
    (port, m)
}

fn counter() -> (Track, Arc<AtomicUsize>) { let n = Arc::new(AtomicUsize::new(0)); let n2 = n.clone(); (Arc::new(move |k| { n2.fetch_add(k, SeqCst); }), n) }
async fn body(r: Response) -> Vec<u8> { axum::body::to_bytes(r.into_body(), 10_000_000).await.unwrap().to_vec() }
fn hv(r: &Response, k: &str) -> String { r.headers().get(k).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default() }
async fn gv(port: u16, path: &str, range: Option<&str>, cap: u64) -> (Response, Arc<AtomicUsize>) {
    let (t, n) = counter();
    let c = reqwest::Client::new();
    let r = gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{port}{path}"), range, None, None, cap, t, None, None).await;
    (r, n)
}

#[tokio::test]
async fn no_range_is_full_200_with_length_and_accept_ranges_and_exact_tracking() {
    let (p, _) = spawn_mock().await;
    let (r, n) = gv(p, "/vid?x=full", None, 4 << 20).await;
    assert_eq!(r.status(), 200);
    assert_eq!((hv(&r, "content-length"), hv(&r, "accept-ranges"), hv(&r, "content-type"), hv(&r, "cache-control")), ("1000".into(), "bytes".into(), "video/mp4".into(), "private, no-store".into()));
    assert_eq!(body(r).await, blob());
    assert_eq!(n.load(SeqCst), 1000, "track_bytes counts exactly the bytes sent");
}

#[tokio::test]
async fn explicit_range_passthrough_one_upstream_hit() {
    let (p, m) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=ex", Some("bytes=100-199"), 300).await;
    assert_eq!(r.status(), 206);
    assert_eq!((hv(&r, "content-range"), hv(&r, "content-length"), hv(&r, "accept-ranges")), ("bytes 100-199/1000".into(), "100".into(), "bytes".into()));
    assert_eq!(body(r).await, blob()[100..200].to_vec());
    assert_eq!(m.hits.load(SeqCst), 1, "explicit range needs no size probe");
}

#[tokio::test]
async fn open_ended_is_probed_then_capped_with_truthful_content_range() {
    let (p, m) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=open", Some("bytes=100-"), 300).await;
    assert_eq!(r.status(), 206);
    assert_eq!((hv(&r, "content-range"), hv(&r, "content-length")), ("bytes 100-999/1000".into(), "900".into()));                                                 
    assert_eq!(body(r).await, blob()[100..].to_vec());
    assert_eq!(m.ranges.lock().unwrap().clone(), ["bytes=100-100", "bytes=100-399", "bytes=400-699", "bytes=700-999"].map(String::from).to_vec());
                                                            
    let (r2, _) = gv(p, "/vid?x=open", Some("bytes=900-"), 300).await;
    assert_eq!(hv(&r2, "content-range"), "bytes 900-999/1000");
    assert_eq!(body(r2).await, blob()[900..].to_vec());
    assert_eq!(m.hits.load(SeqCst), 5);
}

#[tokio::test]
async fn suffix_ranges_item_3() {
    let (p, _) = spawn_mock().await;
                                                                                                      
                                                                              
    let (r, _) = gv(p, "/vid?x=suf", Some("bytes=-100"), 50).await;
    assert_eq!(r.status(), 206);
    assert_eq!((hv(&r, "content-range"), hv(&r, "content-length")), ("bytes 950-999/1000".into(), "50".into()));
    assert_eq!(body(r).await, blob()[950..].to_vec());
    let (r, _) = gv(p, "/vid?x=suf", Some("bytes=-5000"), 50).await;                                                  
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (206, "bytes 950-999/1000".into()));
    assert_eq!(body(r).await, blob()[950..].to_vec());
    let (r, _) = gv(p, "/vid?x=suf", Some("bytes=-0"), 50).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (416, "bytes */1000".into()));
    assert!(body(r).await.is_empty());
}

#[tokio::test]
async fn out_of_bounds_is_416_with_content_range_item_3() {
    let (p, _) = spawn_mock().await;
                                                    
    let (r, _) = gv(p, "/vid?x=oob", Some("bytes=5000-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (416, "bytes */1000".into()));
    assert!(body(r).await.is_empty());
                                                                                  
    let (r, _) = gv(p, "/vid?x=oob", Some("bytes=5000-5999"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (416, "bytes */1000".into()));
    let (r, _) = gv(p, "/r416", Some("bytes=0-9"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (416, "bytes */777".into()));
}

#[tokio::test]
async fn multi_range_and_garbage_are_a_plain_200() {
    let (p, _) = spawn_mock().await;
    for rg in ["bytes=0-1,5-9", "bytes=abc", "items=0-5"] {
        let (r, _) = gv(p, "/vid?x=multi", Some(rg), 300).await;
                                                                                                           
                                                                                                        
                                                                                               
        assert_eq!(r.status(), 200, "{rg}");
        assert_eq!(hv(&r, "content-range"), "", "{rg}");
        assert_eq!(hv(&r, "content-length"), "1000", "{rg}");
        assert_eq!(body(r).await, blob(), "{rg}");
    }
}


                                                                                                    

                                                                                             
                                                                                                  
#[tokio::test]
async fn open_ended_range_streams_the_remainder_when_validated() {
    let (p, m) = spawn_mock().await;
    let (r, n) = gv(p, "/vid?x=oe0", Some("bytes=0-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length"), hv(&r, "accept-ranges")), (206, "bytes 0-999/1000".into(), "1000".into(), "bytes".into()));
    assert_eq!(body(r).await, blob());
    assert_eq!(n.load(SeqCst), 1000, "track_bytes counts exactly the bytes sent");
    let seen = m.ranges.lock().unwrap().clone();
    for w in ["bytes=300-599", "bytes=600-899", "bytes=900-999"] { assert!(seen.iter().any(|x| x == w), "upstream window {w} in {seen:?}"); }
    let (p, m) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=oe319", Some("bytes=319-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 319-999/1000".into(), "681".into()));
    assert_eq!(body(r).await, blob()[319..].to_vec());
    let seen = m.ranges.lock().unwrap().clone();
    for w in ["bytes=319-618", "bytes=619-918", "bytes=919-999"] { assert!(seen.iter().any(|x| x == w), "upstream window {w} in {seen:?}"); }
                                                
    let (p, _) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=oe800", Some("bytes=800-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 800-999/1000".into(), "200".into()));
    assert_eq!(body(r).await, blob()[800..].to_vec());
}

#[tokio::test]
async fn open_ended_range_without_validator_keeps_the_capped_window() {
    let (p, _) = spawn_mock().await;
    let (r, _) = gv(p, "/vid-nolm?x=oenv", Some("bytes=319-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 319-618/1000".into(), "300".into()));
    assert_eq!(body(r).await, blob()[319..619].to_vec());
}

#[tokio::test]
async fn closed_and_suffix_ranges_are_still_clamped_to_the_cap() {
    let (p, _) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=cl1", Some("bytes=100-999"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 100-399/1000".into(), "300".into()));
    let (r, _) = gv(p, "/vid?x=cl2", Some("bytes=-900"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 700-999/1000".into(), "300".into()));
}

#[tokio::test]
async fn open_ended_range_past_eof_is_416() {
    let (p, _) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=oe416", Some("bytes=1000-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (416, "bytes */1000".into()));
}

                                                                                                     
#[tokio::test]
async fn open_ended_range_aborts_when_the_object_changes_mid_walk() {
    let (p, _) = spawn_mock().await;
    let (r, _) = gv(p, "/vid-flip?x=flip", Some("bytes=0-"), 300).await;
    assert_eq!(r.status().as_u16(), 206);
    let got = axum::body::to_bytes(r.into_body(), 10_000).await;
    match got {
        Err(_) => {}
        Ok(b) => { assert!(b.len() < 1000, "short body, not a complete one"); assert!(!b.contains(&0xFF), "no byte of the changed object is delivered"); }
    }
}

                                                                                   
#[tokio::test]
async fn head_open_ended_range_matches_get() {
    let (p, _) = spawn_mock().await;
    let c = reqwest::Client::new();
    let h = gv_head(&c, &LOCAL, format!("http://127.0.0.1:{p}/vid?x=hd"), Some("bytes=319-"), None, 300).await;
    assert_eq!((h.status().as_u16(), hv(&h, "content-range"), hv(&h, "content-length")), (206, "bytes 319-999/1000".into(), "681".into()));
    let h = gv_head(&c, &LOCAL, format!("http://127.0.0.1:{p}/vid-nolm?x=hdnv"), Some("bytes=319-"), None, 300).await;
    assert_eq!((h.status().as_u16(), hv(&h, "content-range"), hv(&h, "content-length")), (206, "bytes 319-618/1000".into(), "300".into()));
}

                                                                                          
#[tokio::test]
async fn open_ended_range_stops_fetching_when_the_client_leaves() {
    use futures::StreamExt;
    let (p, m) = spawn_mock().await;
    let (r, _) = gv(p, "/vid?x=gone", Some("bytes=0-"), 100).await;
    assert_eq!(r.status().as_u16(), 206);
    let mut s = r.into_body().into_data_stream();
    let _ = s.next().await.unwrap().unwrap();
    drop(s);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a = m.hits.load(SeqCst);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(a, m.hits.load(SeqCst), "no upstream requests after the client left");
    assert!(a <= 5, "bounded read-ahead: {a} upstream requests for a 10-window object after 1 chunk consumed");
}


                                                                                                       
                                                                                       
#[tokio::test]
async fn open_ended_range_needs_a_chosen_validator_weak_and_garbage_do_not_count() {
    for path in ["/vid-weak", "/vid-badlm"] {
        let (p, m) = spawn_mock().await;
        let (r, _) = gv(p, &format!("{path}?x=sel"), Some("bytes=319-"), 300).await;
        assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 319-618/1000".into(), "300".into()), "{path}");
        assert_eq!(body(r).await, blob()[319..619].to_vec(), "{path}");
        let seen = m.ranges.lock().unwrap().clone();
        assert!(!seen.iter().any(|x| x.starts_with("bytes=619-")), "{path}: no walk windows: {seen:?}");
    }
}

                                                                                                           
                                                                          
#[tokio::test]
async fn open_ended_walk_uses_the_etag_for_if_range_when_both_validators_exist() {
    let (p, m) = spawn_mock().await;
    let (r, _) = gv(p, "/vid-both?x=both", Some("bytes=319-"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "etag"), hv(&r, "last-modified")), (206, "bytes 319-999/1000".into(), "\"e1\"".into(), MOCK_LM.into()));
    assert_eq!(body(r).await, blob()[319..].to_vec());
    let seen = m.ranges.lock().unwrap().clone();
    for w in ["bytes=619-918|\"e1\"", "bytes=919-999|\"e1\""] { assert!(seen.iter().any(|x| x == w), "{w} in {seen:?}"); }
    assert!(!seen.iter().any(|x| x.contains(MOCK_LM)), "date never used as If-Range when a strong etag exists: {seen:?}");
}

                                                                                                
                                                                                               
#[tokio::test]
async fn open_ended_range_with_mismatching_if_range_is_not_walked() {
    let (p, m) = spawn_mock().await;
    let (t, _) = counter();
    let c = reqwest::Client::new();
    let r = gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{p}/vid-ir?x=irbad"), Some("bytes=319-"), Some("\"stale\""), None, 300, t, None, None).await;
    let st = r.status().as_u16();
    let b = body(r).await;
    assert!(b.len() <= 300, "capped, got {} bytes (status {st})", b.len());
    let seen = m.ranges.lock().unwrap().clone();
    assert!(!seen.iter().any(|x| x.starts_with("bytes=619-")), "no walk windows: {seen:?}");
                                                     
    let (p, _) = spawn_mock().await;
    let (t, _) = counter();
    let r = gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{p}/vid-ir?x=irok"), Some("bytes=319-"), Some("\"e1\""), None, 300, t, None, None).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (206, "bytes 319-999/1000".into()));
    assert_eq!(body(r).await, blob()[319..].to_vec());
}


                                                                                                    
                                                                                                         
#[tokio::test]
async fn open_ended_range_with_a_zero_total_window_fails_closed_without_panic() {
    let (p, _) = spawn_mock().await;
    let (r, _) = gv(p, "/vid-zero?x=zero", Some("bytes=0-"), 300).await;
    let cr = hv(&r, "content-range");
                                                                                                                                                   
    assert!(!cr.contains("18446744073709551615"), "no synthesized header from a total-0 window: {cr:?}");
    let st = r.status().as_u16();
    let got = axum::body::to_bytes(r.into_body(), 10_000).await;
    assert!(!(st == 206 && got.as_ref().is_ok_and(|b| b.len() > 300)), "never more than one capped window");
}

                                                                                                             
                                                                              
#[tokio::test]
async fn walk_without_validator_fails_closed_but_ranged_is_unaffected() {
    let (p, _) = spawn_mock().await;
    for rg in [None, Some("bytes=abc")] {
        let (r, _) = gv(p, "/vid-nolm?x=nv", rg, 300).await;
        assert_eq!(r.status(), 502, "{rg:?} no validator -> fail closed");
        assert!(body(r).await.is_empty(), "{rg:?} bodiless");
    }
    let (r, _) = gv(p, "/vid-nolm?x=nvr", Some("bytes=100-199"), 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (206, "bytes 100-199/1000".into()));
    assert_eq!(body(r).await, blob()[100..200].to_vec());
}

#[tokio::test]
async fn failures_are_bodiless_and_never_leak_odd_statuses() {
    let (p, m) = spawn_mock().await;
    let (r, _) = gv(p, "/boom", Some("bytes=0-9"), 300).await;
    assert_eq!(r.status(), 500);
    assert!(body(r).await.is_empty());
    let (r, _) = gv(p, "/accepted", Some("bytes=0-9"), 300).await;                             
    assert_eq!(r.status(), 502);
    assert!(body(r).await.is_empty());
                                                             
    let t = Instant::now();
    let (r, _) = gv(p, "/gone", Some("bytes=0-9"), 300).await;
    assert_eq!(r.status(), 403);
    assert!(body(r).await.is_empty());
    assert_eq!(m.hits.load(SeqCst), 5);
    assert!(t.elapsed() >= Duration::from_millis(3000), "300+600+900+1200ms backoff");
                                                                           
    let c = reqwest::Client::new();
    let (tr, _) = counter();
    let r = gv_proxy(&c, &PROD, "https://evil.example/videoplayback".into(), None, None, None, 300, tr, None, None).await;
    assert_eq!(r.status(), 502);
}

#[tokio::test]
async fn refresh_swaps_the_url_after_403() {
    let (p, m) = spawn_mock().await;
    let c = reqwest::Client::new();
    let (t, _) = counter();
    let good = format!("http://127.0.0.1:{p}/vid?x=ref");
    let g2 = good.clone();
    let refresh = move || -> futures::future::BoxFuture<'static, Option<String>> { let g = g2.clone(); Box::pin(async move { Some(g) }) };
                                                                  
    let r = gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{p}/gone"), Some("bytes=0-9"), None, Some(&refresh), 300, t.clone(), None, None).await;
    assert_eq!(r.status(), 206);
    assert_eq!(body(r).await.len(), 10);
                                                                 
    let r = gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{p}/gone"), Some("bytes=0-"), None, Some(&refresh), 300, t, None, None).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (206, "bytes 0-999/1000".into()));                          
    let _ = m;
}

#[tokio::test]
async fn ttfb_item_6_and_content_length_item_5() {
    let (p, _) = spawn_mock().await;
    let t = Instant::now();
    let (r, _) = gv(p, "/vid?x=ttfb", Some("bytes=0-"), 4 << 20).await;
    assert!(t.elapsed() < Duration::from_millis(300), "proxy overhead, not upstream: {:?}", t.elapsed());
    assert!(!hv(&r, "content-length").is_empty());
    assert_eq!(body(r).await.len(), 1000);
}

#[tokio::test]
async fn client_disconnect_aborts_upstream_and_counts_only_what_flowed() {
    let (p, m) = spawn_mock().await;
    let (t, n) = counter();
    let c = reqwest::Client::new();
    let r = gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{p}/endless"), None, None, None, 4 << 20, t, None, None).await;
    assert_eq!(r.status(), 200);
    let mut s = r.into_body().into_data_stream();
    use futures::StreamExt;
    for _ in 0..5 { s.next().await.unwrap().unwrap(); }
    drop(s);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a = m.sent.load(SeqCst);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(a, m.sent.load(SeqCst), "upstream stopped producing after the client went away");
    assert!(a < 100, "bounded read-ahead: {a} chunks produced for 5 consumed");
    assert!(n.load(SeqCst) >= 5 * 1024 && n.load(SeqCst) <= 20 * 1024);
}

                                                                                               
#[tokio::test]
async fn head_matches_get_on_the_wire() {
    let (p, _) = spawn_mock().await;
    async fn h(State(p): State<u16>, Query(q): Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> Response {
        let (t, _) = counter();
        let c = reqwest::Client::new();
        let rg = headers.get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
        gv_proxy(&c, &LOCAL, format!("http://127.0.0.1:{p}/vid?x={}", q.get("x").cloned().unwrap_or_default()), rg.as_deref(), None, None, 4 << 20, t, None, None).await
    }
    let app = axum::Router::new().route("/m", get(h)).with_state(p);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap(); });
    let c = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/m?x=head");
    let head = c.head(&url).send().await.unwrap();
    assert_eq!((head.status().as_u16(), head.headers()["content-length"].to_str().unwrap().to_string(), head.headers()["accept-ranges"].to_str().unwrap().to_string()), (200, "1000".into(), "bytes".into()));
    let get_r = c.get(&url).send().await.unwrap();
    assert_eq!(get_r.headers()["content-length"], "1000");
    assert_eq!(get_r.bytes().await.unwrap().len(), 1000);
                                                                        
    for i in 0..20u64 {
        let r = c.get(&url).header("range", format!("bytes={}-{}", i * 10, i * 10 + 9)).send().await.unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.headers()["content-range"].to_str().unwrap(), format!("bytes {}-{}/1000", i * 10, i * 10 + 9));
        assert_eq!(r.bytes().await.unwrap().to_vec(), blob()[(i * 10) as usize..(i * 10 + 10) as usize].to_vec());
    }
}

                                               

async fn spawn_thumbs() -> u16 {
    let app = axum::Router::new()
        .route("/vi/{id}/{name}", get(|axum::extract::Path((_, name)): axum::extract::Path<(String, String)>| async move {
            match name.as_str() {
                "maxresdefault.jpg" => Response::builder().status(404).body(Body::empty()).unwrap(),
                "sddefault.jpg" => Response::builder().header("content-type", "image/jpeg").body(Body::from(vec![1u8; 100])).unwrap(),                           
                "hqdefault.jpg" => Response::builder().header("content-type", "image/jpeg").body(Body::from(vec![2u8; 7000])).unwrap(),
                _ => Response::builder().header("content-type", "image/jpeg").body(Body::from(vec![3u8; 50])).unwrap(),
            }
        }))
        .route("/big/{id}", get(|| async { Response::builder().body(Body::from(vec![0u8; 4_000_001])).unwrap() }));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap(); });
    port
}

#[tokio::test]
async fn thumb_by_id_walks_down_and_skips_placeholders() {
    let p = spawn_thumbs().await;
    let c = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{p}");
    let t = thumb_id_with(&c, &LOCAL, &base, "abcdefghij1", false).await.unwrap();
    assert_eq!((t.len(), t[0]), (7000, 2));                                            
    let t = thumb_id_with(&c, &LOCAL, &base, "abcdefghij1", true).await.unwrap();                     
    assert_eq!(t.len(), 7000);
                                          
    assert!(thumb_id_with(&c, &PROD, "https://evil.example", "abcdefghij1", false).await.is_none());
}

#[tokio::test]
async fn generic_thumb_by_url() {
    let p = spawn_thumbs().await;
    let c = reqwest::Client::new();
    let ok = thumb_with(&c, &LOCAL, &format!("http://127.0.0.1:{p}/vi/x/hqdefault.jpg")).await.unwrap();
    assert_eq!((ok.status().as_u16(), hv(&ok, "content-type"), hv(&ok, "content-length")), (200, "image/jpeg".into(), "7000".into()));
    assert_eq!(body(ok).await.len(), 7000);
    assert_eq!(thumb_with(&c, &LOCAL, &format!("http://127.0.0.1:{p}/big/x")).await.err(), Some(LegErr::Upstream));                         
    assert_eq!(thumb_with(&c, &PROD, "https://x.googlevideo.com/a.jpg").await.err(), Some(LegErr::Blocked));
    assert_eq!(thumb_with(&c, &PROD, "not a url").await.err(), Some(LegErr::BadUrl));
}

                                                                
                                                                                                          
                                                                                                           
                                                                                    
fn sha_hex(b: &[u8]) -> String { use sha2::{Digest, Sha256}; format!("{:x}", Sha256::digest(b)) }

#[tokio::test]
async fn oracle_matches_r32_gvproxy_except_declared_deltas() {
    let golden: Value = serde_json::from_str(include_str!("golden/r32_gvproxy.json")).unwrap();
    let (port, _) = spawn_mock().await;
    let mut checked = 0;
    let mut deltas = 0;
    for (name, g) in golden.as_object().unwrap() {
        let path = g["path"].as_str().unwrap();
        let range = g["range"].as_str();
        let (r, _) = gv(port, path, range, 300).await;
        let status = r.status().as_u16();
        let got = (hv(&r, "content-range"), hv(&r, "content-length"), hv(&r, "accept-ranges"), hv(&r, "content-type"), hv(&r, "cache-control"));
        let b = body(r).await;
        let want = |k: &str| g[k].as_str().unwrap().to_string();
                                                                                                
        let (e_status, e_cr, e_cl, e_len, e_sha, delta): (u16, String, String, usize, String, bool) = match name.as_str() {
            "open_past_eof" | "explicit_past_eof" => (416, "bytes */1000".into(), String::new(), 0, g["body_sha256"].as_str().unwrap().into(), true),                                 
            "open_ended" => (206, "bytes 100-999/1000".into(), "900".into(), 900, sha_hex(&blob()[100..]), true),                                                                             
            "suffix" => (206, "bytes 900-999/1000".into(), "100".into(), 100, sha_hex(&blob()[900..]), true),                                                       
            "inverted" => (200, String::new(), "1000".into(), 1000, sha_hex(&blob()), true),                                                                                                                                             
            "no_range" | "multi" => (200, String::new(), "1000".into(), 1000, sha_hex(&blob()), true),                                                                                                              
            "upstream_202" => (502, String::new(), String::new(), 0, g["body_sha256"].as_str().unwrap().into(), true),                                        
            _ => (g["status"].as_u64().unwrap() as u16, want("content_range"), want("content_length_hdr"), g["body_len"].as_u64().unwrap() as usize, g["body_sha256"].as_str().unwrap().into(), false),
        };
        assert_eq!(status, e_status, "{name} status");
        assert_eq!(got.0, e_cr, "{name} content-range");
        assert_eq!(got.1, e_cl, "{name} content-length");
        assert_eq!((b.len(), sha_hex(&b)), (e_len, e_sha), "{name} body");
        if status == 200 || status == 206 {
            assert_eq!(got.2, "bytes", "{name} accept-ranges (declared delta: r32 sent none)");
            let gs = g["status"].as_u64().unwrap();
            let (ect, ecc) = if gs == 200 || gs == 206 { (g["content_type"].as_str().unwrap(), g["cache_control"].as_str().unwrap()) } else { ("video/mp4", "private, no-store") };
            assert_eq!((got.3.as_str(), got.4.as_str()), (ect, ecc), "{name} headers");
        } else {
            assert_eq!(got.2, "", "{name} bodiless failures carry no accept-ranges");
        }
        checked += 1;
        if delta { deltas += 1; }
    }
    assert_eq!((checked, deltas), (11, 8), "11 golden cases, exactly 8 declared deltas (+accept-ranges on every 200/206)");
}

                                                                                             

                                                                                    
async fn counting_relay(to: u16) -> (u16, Arc<AtomicUsize>) {
    let n = Arc::new(AtomicUsize::new(0));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let n2 = n.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut c, _)) = l.accept().await else { return };
            let n3 = n2.clone();
            tokio::spawn(async move {
                let Ok(mut up) = tokio::net::TcpStream::connect(("127.0.0.1", to)).await else { return };
                let (mut cr, mut cw) = c.split();
                let (mut ur, mut uw) = up.split();
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let a = async { let mut b = [0u8; 4096]; loop { match cr.read(&mut b).await { Ok(0) | Err(_) => break, Ok(k) => { if uw.write_all(&b[..k]).await.is_err() { break; } } } } };
                let d = async { let mut b = [0u8; 4096]; loop { match ur.read(&mut b).await { Ok(0) | Err(_) => break, Ok(k) => { n3.fetch_add(k, SeqCst); if cw.write_all(&b[..k]).await.is_err() { break; } } } } };
                tokio::select! { _ = a => {}, _ = d => {} }
            });
        }
    });
    (port, n)
}

#[tokio::test]
async fn head_costs_under_8kb_upstream() {
    let (p, m) = spawn_mock().await;
    let (rp, bytes) = counting_relay(p).await;
    let c = reqwest::Client::builder().pool_max_idle_per_host(0).build().unwrap();
    let url = format!("http://127.0.0.1:{rp}/vid?x=headcost");
    let r = gv_head(&c, &LOCAL, url.clone(), None, None, 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-length"), hv(&r, "accept-ranges"), hv(&r, "content-type")), (200, "1000".into(), "bytes".into(), "video/mp4".into()));
    assert!(body(r).await.is_empty());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let first = bytes.load(SeqCst);
    assert!(first > 0 && first < 8 * 1024, "first HEAD pulled {first} bytes upstream");
    assert_eq!(m.hits.load(SeqCst), 1);
                                                                                                                           
    let r = gv_head(&c, &LOCAL, url.clone(), Some("bytes=100-"), None, 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 100-999/1000".into(), "900".into()));                                           
    let r = gv_head(&c, &LOCAL, url.clone(), Some("bytes=-100"), None, 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range"), hv(&r, "content-length")), (206, "bytes 900-999/1000".into(), "100".into()));
    let r = gv_head(&c, &LOCAL, url.clone(), Some("bytes=5000-"), None, 300).await;
    assert_eq!((r.status().as_u16(), hv(&r, "content-range")), (416, "bytes */1000".into()));
    let r = gv_head(&c, &LOCAL, url.clone(), Some("bytes=5-2"), None, 300).await;                                  
    assert_eq!((r.status().as_u16(), hv(&r, "content-length")), (200, "1000".into()));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(bytes.load(SeqCst), first, "cached meta: later HEADs cost 0 upstream bytes");
    assert_eq!(m.hits.load(SeqCst), 1, "one upstream request total for five HEADs");
                                      
    let r = gv_head(&c, &LOCAL, format!("http://127.0.0.1:{p}/accepted"), None, None, 300).await;
    assert_eq!(r.status().as_u16(), 502);
    let r = gv_head(&c, &PROD, "https://evil.example/x".into(), None, None, 300).await;
    assert_eq!(r.status().as_u16(), 502);
}

                                                                                                              
                                                                                                                    
                                                                                    
#[test]
fn vp9_only_entry_shape_matches_the_r32_404_path() {
    let d = json!({"formats": [
        f("vp9_1080", "vp09.00.40.08", "none", 1920, 1080, 30, 0, "webm"),
        f("a128", "none", "mp4a.40.2", 0, 0, 0, 128, "m4a"),
    ]});
    let e = build_entry(&d).unwrap();
    assert!(e.hd.is_none(), "r32 hd = hdOf(avc1 video) = null here, so /vsrc 404s for every kind");
    assert_eq!(e.hd_vp9.as_ref().map(|h| h.video_url.as_str()), Some("vp9_1080"));
    assert_eq!(e.quality, "1080p");
}

#[tokio::test]
async fn ytdlp_stdout_is_capped_while_collecting() {
                                                                                                             
    let dir = tempdir("cap1");
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("yt-dlp");
    std::fs::write(&script, "#!/bin/sh\nyes '{\"x\":1}' | head -c 41943040\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let cfg = ResolveCfg { ytdlp: script, proxy: String::new() };
    let t = Instant::now();
    assert_eq!(resolve_stream(&cfg, "GGGGGGGGGG7", false).await.err().as_deref(), Some("can't load this video - try another"));
    assert!(t.elapsed() < Duration::from_secs(10));
    assert_eq!(YTDLP_OUT_MAX, 32 * 1024 * 1024);
}
