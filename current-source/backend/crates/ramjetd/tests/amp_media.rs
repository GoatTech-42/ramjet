                                                                                          
use ramjetd::apps::amp_media::*;
use std::net::IpAddr;
fn ip(s: &str) -> IpAddr { s.parse().unwrap() }

#[test] fn policy_denies_special_purpose() {
    for s in ["127.0.0.1","10.1.1.1","172.16.0.1","192.168.1.1","169.254.169.254","100.64.0.1","0.0.0.0","224.0.0.1","240.0.0.1",
              "192.0.2.1","198.51.100.1","203.0.113.1","198.18.0.1","192.0.0.1",
              "::1","::","fe80::1","fc00::1","ff02::1","64:ff9b::808:808","64:ff9b:1::1","2002::1","2001::1","2001:db8::1",
              "::ffff:127.0.0.1","::ffff:10.0.0.1","::127.0.0.1","3fff::1","5f00::1"] {
        assert!(!is_public_global(ip(s)), "{s} must be denied");
    }
}
#[test] fn policy_allows_public() {
    for s in ["8.8.8.8","1.1.1.1","93.184.216.34","2606:4700:4700::1111","2a00:1450:4001::1","::ffff:8.8.8.8"] {
        assert!(is_public_global(ip(s)), "{s} must be allowed");
    }
}
#[test] fn hop_rules() {
    let h = |s: &str| check_hop(&url::Url::parse(s).unwrap());
    assert!(h("https://api.audius.co/x").is_ok());
    assert!(h("https://api.audius.co:443/x").is_ok());
    assert!(h("http://api.audius.co/x").is_err());
    assert!(h("https://u:p@api.audius.co/x").is_err());
    assert!(h("https://api.audius.co:8443/x").is_err());
    assert!(h("https://127.0.0.1/x").is_err());
    assert!(h("https://[::1]/x").is_err());
    assert!(h("https://[64:ff9b::808:808]/x").is_err());
}
fn rendered(rows: Vec<serde_json::Value>) -> String { format!("[{}]", rows.iter().map(|r| r.as_str().unwrap()).collect::<Vec<_>>().join(",")) }
                                                                                                              
                                                                                                                            
#[test] fn oracle_goldens_vs_r32() {
                                                                                                                
                                                                                                   
    let live = std::env::var("RJ_ORACLE_DIR").ok();
    let base = live.clone().unwrap_or_else(|| format!("{}/tests/fixtures/amp", env!("CARGO_MANIFEST_DIR")));
    let fx = |n: &str| std::fs::read_to_string(format!("{base}/{n}")).unwrap();
    let dir = format!("{base}/cases");
    let (mut n, mut bad) = (0, vec![]);
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).filter(|f| f.ends_with(".json")).collect();
    files.sort();
    for f in files {
        let name = f.trim_end_matches(".json");
        let case: serde_json::Value = serde_json::from_str(&fx(&format!("cases/{f}"))).unwrap();
        for (k, key) in [("yt", "yt"), ("sc", "sc"), ("au", "au")] {
            let Some(inp) = case.get(key) else { continue };
            let node: ONode = serde_json::from_str(&inp.to_string()).unwrap();                                                                       
            let _ = node;
            let raw = fx(&format!("cases/{f}"));
            let node: ONode = { let whole: ONode = serde_json::from_str(&raw).unwrap(); match whole { ONode::Obj(v) => v.into_iter().find(|(kk, _)| kk == key).unwrap().1, _ => panic!() } };
            let got = match k { "yt" => Ok(parse_ytmusic(&node)), "sc" => parse_soundcloud(&node), _ => parse_audius(&node) }
                .map(rendered).unwrap_or_else(|_| "THROW".to_string());
            let want = fx(&format!("golden/{name}.{k}.json"));
            n += 1;
            if got != want { let i = got.bytes().zip(want.bytes()).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len()));
                let ctx = |s: &str| s.get(i.saturating_sub(60)..(i + 60).min(s.len())).unwrap_or("?").to_string();
                bad.push(format!("{name}.{k} @{i}\n  got  ...{}\n  want ...{}", ctx(&got), ctx(&want))); }
        }
    }
    assert!(bad.is_empty(), "{} of {} golden cases differ:\n{}", bad.len(), n, bad.join("\n"));
    assert!(live.is_some() && n > 0 || n >= 30, "expected the full oracle set, ran {n}");
}
async fn body(r: axum::response::Response) -> (u16, String) {
    let s = r.status().as_u16();
    (s, String::from_utf8(axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap())
}
#[tokio::test] async fn fanout_envelopes() {
    let (s, b) = body(combine("q", Err(()), Err(()), Err(()), None)).await;
    assert_eq!(s, 502); assert_eq!(b, r#"{"ok":false,"error":"every catalog timed out - try again"}"#);
    let (s, b) = body(combine("q", Err(()), Ok(vec![]), Err(()), None)).await;
    assert_eq!(s, 200); assert_eq!(b, r#"{"ok":true,"q":"q","results":{"youtube":[],"soundcloud":[],"audius":[]},"next":{"youtube":null,"soundcloud":null,"audius":null}}"#);
}
#[test] fn cursor_parsing() {
    assert_eq!(parse_cursor("au:0"), Some(0));
    assert_eq!(parse_cursor("au:12"), Some(12));
    assert_eq!(parse_cursor("au:"), None);
    assert_eq!(parse_cursor("au:abc"), None);
    assert_eq!(parse_cursor("au:12x"), None);
    assert_eq!(parse_cursor("yt:anything"), None);
    assert_eq!(parse_cursor("sc:anything"), None);
    assert_eq!(parse_cursor(""), None);
    assert_eq!(parse_cursor("au:10001"), None, "past the deepest allowed offset");
    assert_eq!(parse_cursor(&format!("au:{}", u64::from(u32::MAX) + 1)), None, "overflow is refused");
}
#[test] fn au_next_page() {
    assert_eq!(au_next(0, AU_PAGE).as_deref(), Some("au:12"), "first full page continues at 12");
    assert_eq!(au_next(12, AU_PAGE).as_deref(), Some("au:24"), "second full page continues at 24");
    assert_eq!(au_next(12, 5), None, "a short page is the end");
    assert_eq!(au_next(0, 0), None, "an empty page is the end");
    assert_eq!(au_next(9984, AU_PAGE).as_deref(), Some("au:9996"), "a full page inside the bound continues");
    assert_eq!(au_next(9996, AU_PAGE), None, "minting past AU_MAX_OFFSET ends instead of dead-ending on a refused cursor");
    assert_eq!(au_next(u32::MAX - 4, AU_PAGE), None, "offset overflow ends, never wraps");
}
use ramjetd::AppState;

fn fixture_state() -> Arc<AppState> {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("amp-cursor-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("auth.db");
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
    Arc::new(AppState {
        data_dir: dir.clone(),
        auth_db: ramjetd::auth_api::store::AuthStore::open(&db).unwrap(),
        tickets: Default::default(),
        guard: Arc::new(ramjetd::guard::Guard::load(&dir.to_string_lossy())),
        rates: Default::default(),
        egress_client: None,
        pfetch_client: None,
        adblock: ramjetd::adblock::Adblock::load(&dir),
        started: std::time::Instant::now(),
        local_http: reqwest::Client::new(),
        searx_url: "http://127.0.0.1:1".into(),
        ytdlp: "/bin/false".into(),
        proxy_url: String::new(),
        lite: ramjetd::lite::LiteState::new(),
        jetstream_js: ramjetd::apps::jetstream_up::Js::new(),
    })
}
fn no_track() -> Track { Arc::new(|_| {}) }

#[test] fn au_search_url_shape() {
    let u = au_search_url("a b", 24);
    assert!(u.starts_with("https://discoveryprovider.audius.co/v1/tracks/search?query="), "{u}");
    assert!(u.contains("app_name=ramjet-amp"), "{u}");
    assert!(u.contains("limit=12"), "{u}");
    assert!(u.contains("offset=24"), "{u}");
}

#[tokio::test] async fn cursor_rejected_before_any_fetch() {
    // a cursor parse_cursor refuses is a 400 with the honest copy - no upstream fetch happens on this path
    let st = fixture_state();
    let tr = no_track();
    for bad in ["bogus", "yt:abc", "sc:9", "au:", "au:12x", "au:10001"] {
        let (s, b) = body(search(&st, &tr, "hello", Some(bad)).await).await;
        assert_eq!(s, 400, "{bad}");
        assert!(b.contains("that cursor is not understood"), "{b}");
    }
}

#[tokio::test] async fn cursor_envelope_ends_at_cap() {
    // a full page fetched at the deepest in-bound offset ends truthfully: no cursor is minted past the cap
    let (s, b) = body(combine("q", Ok(vec![]), Ok(vec![]), Ok(vec![serde_json::json!({"k":1})]), au_next(9996, AU_PAGE))).await;
    assert_eq!(s, 200);
    assert!(b.contains(r#""next":{"youtube":null,"soundcloud":null,"audius":null}"#), "{b}");
}

#[tokio::test] async fn next_cursor_envelope() {
    // first page with a full audius page: only audius continues, yt/sc never guessed
    let (s, b) = body(combine("q", Ok(vec![]), Ok(vec![]), Ok(vec![]), au_next(0, AU_PAGE))).await;
    assert_eq!(s, 200);
    assert!(b.contains(r#""next":{"youtube":null,"soundcloud":null,"audius":"au:12"}"#), "{b}");
    // empty page: the end, every cursor null
    let (s, b) = body(combine("q", Ok(vec![]), Ok(vec![]), Ok(vec![]), None)).await;
    assert_eq!(s, 200);
    assert!(b.contains(r#""next":{"youtube":null,"soundcloud":null,"audius":null}"#), "{b}");
}
#[test] fn art_targets() {
    assert_eq!(art_target("yt","dQw4w9WgXcQ","").unwrap(), "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
}

                                                                                 
async fn full(r: axum::response::Response) -> (u16, axum::http::HeaderMap, Vec<u8>) {
    let (p, b) = r.into_parts();
    (p.status.as_u16(), p.headers, axum::body::to_bytes(b, 1 << 22).await.unwrap().to_vec())
}
fn hv(h: &axum::http::HeaderMap, k: &str) -> String { h.get(k).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default() }
fn data(n: usize) -> Vec<u8> { (0..n).map(|i| (i % 251) as u8).collect() }

#[test] fn range_parsing() {
    assert_eq!(parse_range(None), RangeReq::None);
    assert_eq!(parse_range(Some("bytes=5-")), RangeReq::From(5, None));
    assert_eq!(parse_range(Some("bytes=5-9")), RangeReq::From(5, Some(9)));
    assert_eq!(parse_range(Some("bytes=-500")), RangeReq::Suffix(500));
    assert_eq!(parse_range(Some("bytes=0-1,5-9")), RangeReq::None);
    assert_eq!(parse_range(Some("bytes=-")), RangeReq::None);
    assert_eq!(parse_range(Some("items=1-2")), RangeReq::None);
    assert_eq!(parse_range(Some("bytes=a-b")), RangeReq::None);
}
#[test] fn range_resolution() {
    assert_eq!(resolve_range(RangeReq::Suffix(100), 1000), Ok(Some((900, 999))));
    assert_eq!(resolve_range(RangeReq::Suffix(5000), 1000), Ok(Some((0, 999))));                                          
    assert_eq!(resolve_range(RangeReq::Suffix(0), 1000), Err(()));
    assert_eq!(resolve_range(RangeReq::From(1000, None), 1000), Err(()));                                          
    assert_eq!(resolve_range(RangeReq::From(10, Some(99999)), 1000), Ok(Some((10, 999))));
    assert_eq!(resolve_range(RangeReq::From(20, Some(10)), 1000), Ok(None));                                  
}
#[test] fn upstream_range_window() {
    assert_eq!(media_range(None), "bytes=0-1048575");
    assert_eq!(media_range(Some("bytes=100-")), "bytes=100-1048675");
    assert_eq!(media_range(Some("bytes=5-20")), "bytes=5-20");
    assert_eq!(media_range(Some("bytes=5-999999999")), "bytes=5-1048580");
    assert_eq!(media_range(Some("bytes=-500")), "bytes=-500");                                                          
    assert_eq!(media_range(Some("bytes=-99999999")), "bytes=-1048576");
}
#[tokio::test] async fn window_get_head_suffix_416() {
    let d = data(1000);
    let get = |r: RangeReq, def: bool, head: bool| serve_window(r, 1000, 0, &d, "audio/mp4", def, head);
                                                 
    let (s, h, b) = full(get(RangeReq::None, true, false)).await;
    assert_eq!((s, hv(&h, "content-range").as_str(), b.len()), (206, "bytes 0-999/1000", 1000));
    let (s, h, b) = full(get(RangeReq::None, false, false)).await;
    assert_eq!(s, 200); assert_eq!(hv(&h, "accept-ranges"), "bytes"); assert_eq!(hv(&h, "content-length"), "1000"); assert_eq!(b, d);
    assert!(h.get("content-range").is_none());
                                                                 
    let (s, h, b) = full(get(RangeReq::From(10, Some(19)), true, false)).await;
    assert_eq!((s, hv(&h, "content-range").as_str(), hv(&h, "content-length").as_str(), hv(&h, "accept-ranges").as_str(), hv(&h, "content-type").as_str()), (206, "bytes 10-19/1000", "10", "bytes", "audio/mp4"));
    assert_eq!(b, &d[10..20]);
    let (s, h, b) = full(get(RangeReq::From(990, None), true, false)).await;
    assert_eq!((s, hv(&h, "content-range").as_str(), b.len()), (206, "bytes 990-999/1000", 10));
             
    let (s, h, b) = full(get(RangeReq::Suffix(100), true, false)).await;
    assert_eq!((s, hv(&h, "content-range").as_str(), hv(&h, "content-length").as_str()), (206, "bytes 900-999/1000", "100"));
    assert_eq!(b, &d[900..]);
                                                                                 
    for r in [RangeReq::From(1000, None), RangeReq::From(5000, Some(6000)), RangeReq::Suffix(0)] {
        let (s, h, b) = full(get(r, true, false)).await;
        assert_eq!(s, 416); assert_eq!(hv(&h, "content-range"), "bytes */1000");
        assert_eq!(hv(&h, "content-length"), "0"); assert_eq!(hv(&h, "accept-ranges"), "bytes"); assert!(b.is_empty());
    }
                                                                                                             
    for (r, def) in [(RangeReq::None, true), (RangeReq::None, false), (RangeReq::From(10, Some(19)), true), (RangeReq::Suffix(100), true), (RangeReq::From(1000, None), true)] {
        let (gs, gh, _) = full(get(r, def, false)).await;
        let (hs, hh, hb) = full(get(r, def, true)).await;
        assert_eq!(gs, hs);
        for k in ["content-length", "content-range", "accept-ranges", "content-type", "cache-control"] { assert_eq!(hv(&gh, k), hv(&hh, k), "{k} differs for HEAD {r:?}"); }
        assert!(hb.is_empty());
    }
}
#[tokio::test] async fn window_inside_larger_object() {
                                                                                                         
    let blk = data(100);
    let (s, h, b) = full(serve_window(RangeReq::From(150, Some(399)), 1000, 100, &blk, "audio/mp4", true, false)).await;
    assert_eq!(s, 206); assert_eq!(hv(&h, "content-range"), "bytes 150-199/1000"); assert_eq!(hv(&h, "content-length"), "50"); assert_eq!(b.len(), 50);
                                                                                                
    let (s, h, b) = full(serve_window(RangeReq::From(500, None), 1000, 100, &blk, "audio/mp4", true, false)).await;
    assert_eq!((s, hv(&h, "content-length").as_str(), b.len()), (503, "0", 0));
}
#[test] fn yt_block_cache_is_lru_and_bounded() {
    assert_eq!(YT_CACHE_MAX, 64 * 1024 * 1024);
    let blk = |n: usize| std::sync::Arc::new(vec![0u8; n]);
    let id = "lru-test-track";
    for i in 0..4u64 { cache_block_put(id, 7, i, blk(100), 250); }                                               
    assert!(cache_block_get(id, 7, 3).is_some() && cache_block_get(id, 7, 2).is_some());
    assert!(cache_block_get(id, 7, 0).is_none() && cache_block_get(id, 7, 1).is_none(), "oldest evicted first");
    cache_block_get(id, 7, 2);                                                                                 
    cache_block_put(id, 7, 9, blk(100), 250);
    assert!(cache_block_get(id, 7, 2).is_some() && cache_block_get(id, 7, 9).is_some() && cache_block_get(id, 7, 3).is_none());
    assert!(cache_bytes() > 0);
}

#[test] fn yt_block_cache_generation_isolation() {
    let blk = std::sync::Arc::new(vec![1u8; 10]);
    cache_block_put("gen-test", 100, 0, blk, 1 << 20);
    assert!(cache_block_get("gen-test", 100, 0).is_some());
    assert!(cache_block_get("gen-test", 101, 0).is_none(), "a new cell generation must not see the old cell's blocks");
}
#[tokio::test] async fn head_only_matches_get_without_body() {
    let d = data(700);
    for (r, def) in [(RangeReq::None, false), (RangeReq::From(10, Some(19)), false), (RangeReq::Suffix(50), false), (RangeReq::From(700, None), false)] {
        let (gs, gh, _) = full(serve_window(r, 700, 0, &d, "audio/mpeg", def, false)).await;
        let (hs, hh, hb) = full(head_only(r, 700, "audio/mpeg", def)).await;
        assert_eq!(gs, hs);
        for k in ["content-length", "content-range", "accept-ranges", "content-type"] { assert_eq!(hv(&gh, k), hv(&hh, k), "{k} {r:?}"); }
        assert!(hb.is_empty());
    }
}

                                                                                    
const N: u64 = 1_048_576;
fn fixture() -> Vec<u8> { data(N as usize) }
fn sha(b: &[u8]) -> String { use sha2::{Digest, Sha256}; Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect() }
async fn both(r: RangeReq, d: &[u8]) -> ((u16, axum::http::HeaderMap, Vec<u8>), (u16, axum::http::HeaderMap, Vec<u8>)) {
    (full(serve_window(r, N, 0, d, "audio/mpeg", false, false)).await, full(serve_window(r, N, 0, d, "audio/mpeg", false, true)).await)
}
fn rr(h: &str) -> RangeReq { parse_range(Some(h)) }
#[tokio::test] async fn qa_1_2_no_range_200_and_head_parity() {
    let d = fixture();
    let (g, h) = both(RangeReq::None, &d).await;
    assert_eq!(g.0, 200); assert_eq!(hv(&g.1, "content-length"), N.to_string()); assert_eq!(hv(&g.1, "accept-ranges"), "bytes");
    assert_eq!(sha(&g.2), sha(&d));
    assert_eq!(h.0, 200); assert!(h.2.is_empty());
    for k in ["content-length", "content-type", "accept-ranges"] { assert_eq!(hv(&g.1, k), hv(&h.1, k)); }
                                                                    
    let (g, h) = both(rr("bytes=100-199"), &d).await;
    assert_eq!(h.0, 206); assert_eq!(hv(&h.1, "content-range"), "bytes 100-199/1048576"); assert_eq!(hv(&h.1, "content-length"), "100"); assert!(h.2.is_empty());
    assert_eq!(g.0, 206);
}
#[tokio::test] async fn qa_3_to_7_ranges_with_bytes_verified() {
    let d = fixture();
    let check = |name: &'static str, hdr: &'static str, st: u64, en: u64| { let d = d.clone(); async move {
        let (g, h) = both(rr(hdr), &d).await;
        assert_eq!(g.0, 206, "{name}"); assert_eq!(hv(&g.1, "content-range"), format!("bytes {st}-{en}/{N}"), "{name}");
        assert_eq!(hv(&g.1, "content-length"), (en - st + 1).to_string(), "{name}"); assert_eq!(g.2, &d[st as usize..=en as usize], "{name}");
        assert_eq!(h.0, 206, "{name} HEAD"); assert!(h.2.is_empty()); assert_eq!(hv(&h.1, "content-range"), hv(&g.1, "content-range"));
    } };
    check("0-0", "bytes=0-0", 0, 0).await;
    check("mid", "bytes=1000-5999", 1000, 5999).await;
    check("open", "bytes=1048000-", 1048000, N - 1).await;
    check("suffix k", "bytes=-1000", N - 1000, N - 1).await;
    check("suffix N", "bytes=-1048576", 0, N - 1).await;
    check("suffix N+5", "bytes=-1048581", 0, N - 1).await;
    check("end clamp", "bytes=500-1048676", 500, N - 1).await;
}
#[tokio::test] async fn qa_8_416_only_for_the_three_cases_empty_body() {
    let d = fixture();
    for h in ["bytes=-0", "bytes=1048576-", "bytes=9999999-", "bytes=1048576-2000000"] {
        let (g, hd) = both(rr(h), &d).await;
        for r in [g, hd] { assert_eq!(r.0, 416, "{h}"); assert_eq!(hv(&r.1, "content-range"), "bytes */1048576"); assert!(r.2.is_empty()); assert_eq!(hv(&r.1, "content-length"), "0"); }
    }
                                                                                                        
    for (r, want) in [(rr("bytes=-5"), 416), (rr("bytes=0-"), 416), (RangeReq::None, 200)] {
        let (s, h, b) = full(serve_window(r, 0, 0, &[], "audio/mpeg", false, false)).await;
        assert_eq!(s, want); assert!(b.is_empty()); assert_eq!(hv(&h, "content-length"), "0");
        if want == 416 { assert_eq!(hv(&h, "content-range"), "bytes */0"); }
        let (hs, hh, _) = full(head_only(r, 0, "audio/mpeg", false)).await;
        assert_eq!((hs, hv(&hh, "content-range")), (s, hv(&h, "content-range")));
    }
}
#[tokio::test] async fn qa_9_ignored_headers_give_plain_200() {
    let d = fixture();
    for h in ["bytes=0-1,5-6", "items=0-1", "bytes=abc", "bytes=5-2", "bytes=", "bytes=-", "bytes=1-2-3"] {
        let (g, hd) = both(rr(h), &d).await;
        assert_eq!(g.0, 200, "{h}"); assert_eq!(sha(&g.2), sha(&d)); assert!(h.is_empty() || !hv(&g.1, "content-type").contains("multipart"));
        assert!(g.1.get("content-range").is_none(), "{h}"); assert_eq!(hd.0, 200); assert!(hd.2.is_empty());
    }
}
#[tokio::test] async fn qa_10_if_range_never_matches_without_validators() {
    assert_eq!(effective_range(Some("bytes=0-9"), Some("\"abc\"")), None);
    assert_eq!(effective_range(Some("bytes=0-9"), None), Some("bytes=0-9"));
    let d = fixture();
    let g = full(serve_window(parse_range(effective_range(Some("bytes=0-9"), Some("W/\"x\""))), N, 0, &d, "audio/mpeg", false, false)).await;
    assert_eq!(g.0, 200); assert_eq!(g.2.len() as u64, N);
}

                                                           
use ramjetd::apps::amp_media::{fail_active, run_capped, YT_FAIL_TTL};
                                                                                                  
                                                                                                   
async fn take_slot(s: &'static tokio::sync::Semaphore, d: Duration) -> Result<tokio::sync::SemaphorePermit<'static>, ()> {
    match tokio::time::timeout(d, s.acquire()).await { Ok(Ok(p)) => Ok(p), _ => Err(()) }
}
use std::time::{Duration, Instant};
fn sh(s: &str) -> tokio::process::Command { let mut c = tokio::process::Command::new("sh"); c.args(["-c", s]); c }
#[tokio::test] async fn run_capped_returns_stdout() {
    assert_eq!(run_capped(sh("printf hello"), 1024, Duration::from_secs(5)).await.unwrap(), b"hello");
}
#[tokio::test] async fn run_capped_exact_cap_ok_one_over_is_killed() {
    assert_eq!(run_capped(sh("printf aaaaa"), 5, Duration::from_secs(5)).await.unwrap().len(), 5);
    assert!(run_capped(sh("printf aaaaaa"), 5, Duration::from_secs(5)).await.is_err());
}
#[tokio::test] async fn run_capped_kills_an_endless_producer_fast() {
    let t = Instant::now();
    assert!(run_capped(sh("yes"), 1_000_000, Duration::from_secs(20)).await.is_err());
    assert!(t.elapsed() < Duration::from_secs(5), "endless output must be cut at the cap, took {:?}", t.elapsed());
}
#[tokio::test] async fn run_capped_nonzero_exit_and_timeout_and_spawn_failure_are_errors() {
    assert!(run_capped(sh("echo x; exit 3"), 1024, Duration::from_secs(5)).await.is_err());
    let t = Instant::now();
    assert!(run_capped(sh("sleep 30"), 1024, Duration::from_millis(200)).await.is_err());
    assert!(t.elapsed() < Duration::from_secs(5));
    assert!(run_capped(tokio::process::Command::new("/nonexistent/yt-dlp"), 1024, Duration::from_secs(1)).await.is_err());
}
#[tokio::test] async fn run_capped_stderr_flood_does_not_block() {
    let out = run_capped(sh("head -c 2000000 /dev/zero >&2; printf ok"), 1024, Duration::from_secs(10)).await.unwrap();
    assert_eq!(out, b"ok");
}
#[tokio::test] async fn take_slot_waits_then_times_out_then_frees() {
    static S: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let p = take_slot(&S, Duration::from_millis(50)).await.unwrap();
    assert!(take_slot(&S, Duration::from_millis(50)).await.is_err());
    drop(p);
    assert!(take_slot(&S, Duration::from_millis(50)).await.is_ok());
}
#[tokio::test] async fn slots_cap_concurrent_spawns() {
    static S: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static MAX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    use std::sync::atomic::Ordering::SeqCst;
    let hs: Vec<_> = (0..8).map(|_| tokio::spawn(async {
        let _p = take_slot(&S, Duration::from_secs(10)).await.unwrap();
        let n = LIVE.fetch_add(1, SeqCst) + 1; MAX.fetch_max(n, SeqCst);
        let _ = run_capped(sh("sleep 0.1"), 1024, Duration::from_secs(5)).await;
        LIVE.fetch_sub(1, SeqCst);
    })).collect();
    for h in hs { h.await.unwrap(); }
    assert_eq!(MAX.load(SeqCst), 2);
}
#[test] fn fail_ttl_none_is_r32_parity_forever_and_some_expires() {
    let t0 = Instant::now(); let later = t0 + Duration::from_secs(3600);
    assert!(!fail_active(None, None, later));
    assert!(fail_active(Some(t0), None, later), "no TTL = r32: stays failed");
    assert!(fail_active(Some(t0), Some(Duration::from_secs(60)), t0 + Duration::from_secs(59)));
    assert!(!fail_active(Some(t0), Some(Duration::from_secs(60)), t0 + Duration::from_secs(60)));
    assert!(!fail_active(Some(t0), Some(Duration::from_secs(60)), later));
}
#[test] fn div17_failure_ttl_is_60s() {
    assert_eq!(YT_FAIL_TTL, Some(Duration::from_secs(60)));
    let t0 = Instant::now();
    assert!(fail_active(Some(t0), YT_FAIL_TTL, t0 + Duration::from_secs(59)));
    assert!(!fail_active(Some(t0), YT_FAIL_TTL, t0 + Duration::from_secs(61)), "a failed track is retried after the TTL");
}

                                                                                                                            
use axum::body::to_bytes;
use std::sync::{atomic::{AtomicI64, Ordering}, Arc};
fn counter() -> (Track, Arc<AtomicI64>) { let c = Arc::new(AtomicI64::new(0)); let c2 = c.clone(); (Arc::new(move |n| { c2.fetch_add(n, Ordering::SeqCst); }) as Track, c) }
async fn fin(ct: &str, body: &[u8]) -> (u16, Option<String>, Option<String>, Vec<u8>, i64) {
    let (t, c) = counter();
    let r = art_finish(ct.to_string(), body.to_vec(), &t);
    let st = r.status().as_u16();
    let h = |k: &str| r.headers().get(k).map(|v| v.to_str().unwrap().to_string());
    let (ctype, cc) = (h("content-type"), h("cache-control"));
    let b = to_bytes(r.into_body(), 1 << 20).await.unwrap().to_vec();
    (st, ctype, cc, b, c.load(Ordering::SeqCst))
}
#[tokio::test] async fn div19_image_types_pass_through_verbatim_with_r32_headers() {
    for ct in ["image/jpeg", "image/png", "image/webp", "image/gif", "IMAGE/PNG", "image/jpeg; charset=binary", "Image/Jpeg"] {
        let (st, ctype, cc, b, tracked) = fin(ct, b"\xff\xd8\xffDATA").await;
        assert_eq!(st, 200, "{ct}");
        assert_eq!(ctype.as_deref(), Some(ct), "content-type is passed back verbatim: {ct}");
                                                                                                                     
        assert_eq!(cc.as_deref(), Some("private, max-age=86400"), "{ct}");
        assert_eq!(b, b"\xff\xd8\xffDATA", "{ct}");
        assert_eq!(tracked, 7, "image bytes are counted against the bandwidth guard: {ct}");
    }
}
#[tokio::test] async fn div19_non_image_types_are_bodiless_204_and_not_counted() {
    for ct in ["text/html", "text/html; charset=utf-8", "application/javascript", "application/octet-stream", "application/json", "text/plain",
               "application/xhtml+xml", "audio/mpeg", "", "image", "imag/png", "x-image/png", "application/image/png", "  "] {
        let (st, ctype, cc, b, tracked) = fin(ct, b"<script>alert(1)</script>").await;
        assert_eq!(st, 204, "{ct:?}");
        assert!(ctype.is_none() && cc.is_none(), "204 carries no content-type or cache headers: {ct:?}");
        assert!(b.is_empty(), "204 is bodiless: {ct:?}");
        assert_eq!(tracked, 0, "nothing served, nothing counted: {ct:?}");
    }
}
#[tokio::test] async fn div19_leading_whitespace_before_image_slash_still_counts_as_image() {
                                                                                                                  
    assert_eq!(fin(" image/png", b"x").await.0, 200);
}
#[tokio::test] async fn div19_empty_image_body_is_still_200() {
    let (st, _, _, b, n) = fin("image/jpeg", b"").await; assert_eq!((st, b.len(), n), (200, 0, 0));
}
#[tokio::test] async fn div26_svg_subtypes_are_blocked_as_non_image() {
    for ct in ["image/svg+xml", "IMAGE/SVG+XML", "image/svg", "image/svg+xml; charset=utf-8", " image/svg+xml", "image/svg-xml", "image/svgz", "image/SVG+XML;x=1", "image/ svg+xml"] {
        let (st, ctype, cc, b, n) = fin(ct, b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>").await;
        assert_eq!((st, ctype, cc, b.len(), n), (204, None, None, 0, 0), "{ct:?} must be a bodiless 204, uncounted");
    }
}
#[tokio::test] async fn div26_does_not_catch_look_alike_raster_types() {
    for ct in ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/heic", "image/tiff", "image/sv", "image/s-vg"] {
        assert_eq!(fin(ct, b"x").await.0, 200, "{ct}");
    }
}
#[tokio::test] async fn div19_art_validation_matrix_still_400s_before_any_fetch() {
                                                                                                                                   
    for (src, id, u) in [("yt", "short", ""), ("yt", "", ""), ("yt", "bad id chars", ""), ("sc", "", "!!notb64"), ("au", "", ""), ("zz", "x", "x"), ("", "", "")] {
        let r = ramjetd::apps::amp::art_validate(src, id, u);
        assert!(r.is_some(), "{src:?}/{id:?}/{u:?} must be rejected up front");
        assert_eq!(r.unwrap().status().as_u16(), 400);
    }
}
