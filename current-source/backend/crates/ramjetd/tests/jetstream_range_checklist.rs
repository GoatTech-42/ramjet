                                                                                                             
                                                                                                   
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::response::Response;
use axum::routing::get;
use ramjetd::jetstream_media::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::Arc;
use std::time::{Duration, Instant};

const N: usize = 1_048_576;
const ETAG: &str = "\"fixture-v1\"";
const LM: &str = "Mon, 19 Oct 2026 00:00:00 GMT";

fn fixture() -> Vec<u8> { (0..N).map(|i| (i % 251) as u8).collect() }
fn sha(b: &[u8]) -> String { format!("{:x}", Sha256::digest(b)) }
fn local_ok(u: &url::Url) -> bool { u.scheme() == "http" && u.host_str() == Some("127.0.0.1") }
const LOCAL: Policy = Policy { media_ok: local_ok, thumb_ok: local_ok, pin: false };

#[derive(Clone, Default)]
struct Up { hits: Arc<AtomicUsize> }

                                                                                                          
async fn upstream(State(up): State<Up>, req: Request) -> Response {
    up.hits.fetch_add(1, SeqCst);
    let data = fixture();
    let h = req.headers();
    let mut rng = h.get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    if let Some(ir) = h.get("if-range").and_then(|v| v.to_str().ok()) { if ir != ETAG { rng = None; } }
    let base = |b: Body, len: usize| Response::builder().header("content-type", "video/mp4").header("etag", ETAG).header("last-modified", LM).header("content-length", len).body(b);
    let Some(r) = rng else { return base(Body::from(data), N).unwrap(); };
    let r = r.strip_prefix("bytes=").unwrap();
    let (a, b) = r.split_once('-').unwrap();
    let (a, b) = if a.is_empty() { (N.saturating_sub(b.parse().unwrap()), N - 1) } else { (a.parse::<usize>().unwrap(), if b.is_empty() { N - 1 } else { b.parse::<usize>().unwrap().min(N - 1) }) };
    if a >= N { return Response::builder().status(416).header("content-range", format!("bytes */{N}")).body(Body::empty()).unwrap(); }
    let part = data[a..=b].to_vec();
    let len = part.len();
    let mut resp = base(Body::from(part), len).unwrap();
    *resp.status_mut() = axum::http::StatusCode::PARTIAL_CONTENT;
    resp.headers_mut().insert("content-range", format!("bytes {a}-{b}/{N}").parse().unwrap());
    resp
}

async fn empty_up(req: Request) -> Response {
    if req.headers().contains_key("range") { return Response::builder().status(416).header("content-range", "bytes */0").body(Body::empty()).unwrap(); }
    Response::builder().header("content-type", "video/mp4").header("content-length", 0).body(Body::empty()).unwrap()
}

                                                 
async fn deaf_up() -> Response {
    let d = fixture();
    Response::builder().header("content-type", "video/mp4").header("content-length", N).body(Body::from(d)).unwrap()
}

async fn front(State(p): State<u16>, method: axum::http::Method, Query(q): Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> Response {
    let c = reqwest::Client::new();
    let t: Track = Arc::new(|_| {});
    let rg = headers.get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let ir = headers.get("if-range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let path = q.get("p").cloned().unwrap_or_else(|| "up".into());
    let u = format!("http://127.0.0.1:{p}/{path}");
    if method == axum::http::Method::HEAD { return gv_head(&c, &LOCAL, u, rg.as_deref(), None, 4 << 20).await; }                     
    gv_proxy(&c, &LOCAL, u, rg.as_deref(), ir.as_deref(), None, 4 << 20, t, None, None).await
}

async fn rig() -> (String, Up) {
    let up = Up::default();
    let uapp = axum::Router::new().route("/up", get(upstream)).route("/empty", get(empty_up)).route("/deaf", get(deaf_up)).with_state(up.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, uapp).await.unwrap(); });
    let fapp = axum::Router::new().route("/m", get(front)).with_state(up_port);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, fapp).await.unwrap(); });
    (format!("http://127.0.0.1:{port}/m"), up)
}

fn hdr(r: &reqwest::Response, k: &str) -> String { r.headers().get(k).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default() }

                                                                                                            
async fn both(c: &reqwest::Client, url: &str, range: Option<&str>) -> (u16, String, String, Vec<u8>) {
    let mk = |m: reqwest::Method| { let mut r = c.request(m, url); if let Some(x) = range { r = r.header("range", x); } r };
    let g = mk(reqwest::Method::GET).send().await.unwrap();
    let h = mk(reqwest::Method::HEAD).send().await.unwrap();
    assert_eq!(g.status(), h.status(), "HEAD status parity {range:?}");
    for k in ["content-length", "content-type", "accept-ranges", "etag", "last-modified", "content-range"] { assert_eq!(hdr(&g, k), hdr(&h, k), "HEAD {k} parity {range:?}"); }
    let out = (g.status().as_u16(), hdr(&g, "content-range"), hdr(&g, "content-length"), Vec::<u8>::new());
    let body = g.bytes().await.unwrap().to_vec();
    assert!(h.bytes().await.unwrap().is_empty(), "HEAD body empty");
    (out.0, out.1, out.2, body)
}

#[tokio::test]
async fn items_1_to_9_exact_bytes_on_get_and_head() {
    let (url, _) = rig().await;
    let c = reqwest::Client::new();
    let fx = fixture();
                  
    let r = c.get(&url).send().await.unwrap();
    assert_eq!((r.status().as_u16(), hdr(&r, "content-length"), hdr(&r, "accept-ranges"), hdr(&r, "etag"), hdr(&r, "last-modified"), hdr(&r, "content-type")),
        (200, N.to_string(), "bytes".into(), ETAG.into(), LM.into(), "video/mp4".into()));
    assert_eq!(sha(&r.bytes().await.unwrap()), sha(&fx));
    let (s, cr, cl, b) = both(&c, &url, None).await;                               
    assert_eq!((s, cr.as_str(), cl.as_str(), b.len()), (200, "", "1048576", N));
             
    let (s, cr, cl, b) = both(&c, &url, Some("bytes=0-0")).await;
    assert_eq!((s, cr.as_str(), cl.as_str(), b), (206, "bytes 0-0/1048576", "1", vec![0u8]));
             
    let (a, e) = (300_000usize, 399_999usize);
    let (s, cr, cl, b) = both(&c, &url, Some(&format!("bytes={a}-{e}"))).await;
    assert_eq!((s, cr, cl), (206, format!("bytes {a}-{e}/{N}"), (e - a + 1).to_string()));
    assert_eq!(sha(&b), sha(&fx[a..=e]));
            
    let (s, cr, _, b) = both(&c, &url, Some("bytes=1000000-")).await;
    assert_eq!((s, cr), (206, format!("bytes 1000000-{}/{N}", N - 1)));
    assert_eq!(sha(&b), sha(&fx[1_000_000..]));
                
    let (s, cr, cl, b) = both(&c, &url, Some("bytes=-4096")).await;
    assert_eq!((s, cr, cl), (206, format!("bytes {}-{}/{N}", N - 4096, N - 1), "4096".into()));
    assert_eq!(sha(&b), sha(&fx[N - 4096..]));
    for sfx in [N, N + 5] {
        let (s, cr, _, b) = both(&c, &url, Some(&format!("bytes=-{sfx}"))).await;
        assert_eq!((s, cr), (206, format!("bytes 0-{}/{N}", N - 1)), "suffix {sfx}");
        assert_eq!(sha(&b), sha(&fx));
    }
                   
    let (s, cr, _, b) = both(&c, &url, Some(&format!("bytes=1048000-{}", N + 100))).await;
    assert_eq!((s, cr), (206, format!("bytes 1048000-{}/{N}", N - 1)));
    assert_eq!(sha(&b), sha(&fx[1_048_000..]));
                                                            
    for rg in ["bytes=-0".to_string(), format!("bytes={N}-"), format!("bytes={N}-{}", N + 10), "bytes=99999999999-".to_string()] {
        let (s, cr, _, b) = both(&c, &url, Some(&rg)).await;
        assert_eq!((s, cr.as_str(), b.len()), (416, "bytes */1048576", 0), "{rg}");
    }
    let (s, cr, _, b) = both(&c, &format!("{url}?p=empty"), Some("bytes=-5")).await;                         
    assert_eq!((s, cr.as_str(), b.len()), (416, "bytes */0", 0));
    let (s, cr, _, b) = both(&c, &format!("{url}?p=empty"), Some("bytes=0-0")).await;                                                  
    assert_eq!((s, cr.as_str(), b.len()), (416, "bytes */0", 0));
    let (s, _, cl, b) = both(&c, &format!("{url}?p=empty"), None).await;
    assert_eq!((s, cl.as_str(), b.len()), (200, "0", 0));
                                                                                          
    for rg in ["bytes=0-1,5-6", "items=0-1", "bytes=abc", "bytes=5-2", "bytes=", "bytes=-"] {
        let (s, cr, cl, b) = both(&c, &url, Some(rg)).await;
        assert_eq!((s, cr.as_str(), cl.as_str(), sha(&b)), (200, "", "1048576", sha(&fx)), "{rg}");
    }
}

#[tokio::test]
async fn item_10_if_range() {
    let (url, _) = rig().await;
    let c = reqwest::Client::new();
    let fx = fixture();
    let r = c.get(&url).header("range", "bytes=10-19").header("if-range", ETAG).send().await.unwrap();
    assert_eq!((r.status().as_u16(), hdr(&r, "content-range")), (206, format!("bytes 10-19/{N}")));
    assert_eq!(r.bytes().await.unwrap().to_vec(), fx[10..20].to_vec());
    let r = c.get(&url).header("range", "bytes=10-19").header("if-range", "\"stale\"").send().await.unwrap();
    assert_eq!((r.status().as_u16(), hdr(&r, "content-length")), (200, N.to_string()));
    assert_eq!(sha(&r.bytes().await.unwrap()), sha(&fx));
                                                                
    let r = c.get(&url).header("range", "bytes=0-").header("if-range", ETAG).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 206);
}

#[tokio::test]
async fn item_11_keepalive_sequence_and_item_12_local_ttfb() {
    let (url, up) = rig().await;
    let c = reqwest::Client::new();
    let fx = fixture();
    let mut worst = Duration::ZERO;
    let mut times = vec![];
    for i in 0..30usize {
        let a = (i * 33_333) % (N - 5000);
        let t = Instant::now();
        let r = c.get(&url).header("range", format!("bytes={a}-{}", a + 4095)).send().await.unwrap();
        let first = t.elapsed();
        assert_eq!(r.status().as_u16(), 206);
        assert_eq!(r.bytes().await.unwrap().to_vec(), fx[a..a + 4096].to_vec());
        worst = worst.max(first);
        times.push(first);
    }
    times.sort();
    assert!(worst < Duration::from_millis(500), "local TTFB p50 {:?} max {:?}", times[15], worst);
    assert!(up.hits.load(SeqCst) >= 30);
}

#[tokio::test]
async fn item_14_upstream_ignoring_range_gives_200_not_a_false_206() {
    let (url, _) = rig().await;
    let c = reqwest::Client::new();
    for rg in ["bytes=100-199", "bytes=-100", "bytes=5-"] {
        let h = c.head(&format!("{url}?p=deaf")).header("range", rg).send().await.unwrap();
        assert_eq!((h.status().as_u16(), hdr(&h, "content-range")), (200, String::new()), "HEAD {rg}");                             
        let r = c.get(&format!("{url}?p=deaf")).header("range", rg).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200, "{rg}");
        assert_eq!(hdr(&r, "content-range"), "", "{rg}");
        assert_eq!(sha(&r.bytes().await.unwrap()), sha(&fixture()), "{rg}");
    }
}
