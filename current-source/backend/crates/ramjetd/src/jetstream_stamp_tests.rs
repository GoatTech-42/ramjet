                                                                                      
                                                                                      
use super::*;

fn seed(id: &str) {
    let e = Entry { url: std::sync::Mutex::new(Some("http://127.0.0.1:9/never".into())), mux: tokio::sync::OnceCell::new(),
        quality: String::new(), title: "T".into(), channel: "C".into(), channel_id: String::new(), duration: 0.0,
        hd: Some(Hd { video_url: "http://127.0.0.1:9/v".into(), audio_url: "http://127.0.0.1:9/a".into(), quality: "q".into() }),
        hd_vp9: None, hd_l: None, hd_lvp9: None, expires: std::time::Instant::now() + RESOLVE_TTL };
    let store = RESOLVED.get_or_init(|| std::sync::Mutex::new(ResolveStore { map: HashMap::new(), order: Default::default(), inflight: HashMap::new(), neg: HashMap::new() }));
    store.lock().unwrap().map.insert(id.to_string(), Arc::new(e));
}
fn pulls(user: &str, id: &str) -> usize {
    TEST_PULL_CALLS.get_or_init(Default::default).lock().unwrap().get(&(user.to_string(), id.to_string())).copied().unwrap_or(0)
}
fn mkstate(user: &str) -> Arc<crate::AppState> {
    let mut st = crate::auth_api::devices::tests::fixture(user);
    st.egress_client = Some(reqwest::Client::new());                                                                
    st.proxy_url = "socks5h://127.0.0.1:1".into();
    Arc::new(st)
}
fn cookie_headers(st: &crate::AppState, user: &str) -> HeaderMap {
    let id = match st.auth_db.login(user, "fixture pass").unwrap() { crate::auth_api::store::Login::Ok(i) => i, _ => panic!("login") };
    let tok = st.auth_db.issue(&id).unwrap();
    let mut h = HeaderMap::new();
    h.insert("cookie", format!("rj2_session={tok}").parse().unwrap());
    h
}
fn q(id: &str, kind: Option<&str>) -> Query<HashMap<String, String>> {
    let mut m = HashMap::new(); m.insert("id".to_string(), id.to_string());
    if let Some(k) = kind { m.insert("kind".to_string(), k.to_string()); }
    Query(m)
}
async fn played(st: &crate::AppState, id: &str) -> bool {
    tokio::time::sleep(Duration::from_millis(400)).await;
    std::fs::read(st.data_dir.join("jetstream-playback.json")).map(|b| String::from_utf8_lossy(&b).contains(id)).unwrap_or(false)
}

#[tokio::test]
async fn vsrc_upstream_failure_does_not_stamp_or_record() {
    let (user, id) = ("stamp-u1", "STMPVSRC001");
    let st = mkstate(user); seed(id);
    let h = cookie_headers(&st, user);
    let r = vsrc_handler(State((st.clone(), std::path::PathBuf::new())), Method::GET, q(id, Some("video")), h).await;
    assert!(r.status().as_u16() != 401 && !r.status().is_success(), "fixture upstream must fail, got {}", r.status());
    assert_eq!(pulls(user, id), 0, "failed vsrc pull must not stamp (status {})", r.status());
    assert!(!played(&st, id).await, "failed vsrc pull must not record a play");
}
#[tokio::test]
async fn vsrc_user_cap_429_does_not_stamp_or_record() {
    let (user, id) = ("stamp-u2", "STMPVSRC002");
    let st = mkstate(user); seed(id);
    let _held: Vec<_> = (0..3).map(|_| user_permit(user).expect("permit")).collect();
    let h = cookie_headers(&st, user);
    let r = vsrc_handler(State((st.clone(), std::path::PathBuf::new())), Method::GET, q(id, Some("video")), h).await;
    assert_eq!(r.status().as_u16(), 429);
    assert_eq!(pulls(user, id), 0, "429 must not stamp a pull");
    assert!(!played(&st, id).await, "429 must not record a play");
}
#[tokio::test]
async fn stream_upstream_failure_does_not_stamp_or_record() {
    let (user, id) = ("stamp-u3", "STMPSTRM003");
    let st = mkstate(user); seed(id);
    let h = cookie_headers(&st, user);
    let r = stream_handler(State((st.clone(), std::path::PathBuf::new())), Method::GET, q(id, None), h).await;
    assert!(r.status().as_u16() != 401 && !r.status().is_success(), "got {}", r.status());
    assert_eq!(pulls(user, id), 0, "failed stream pull must not stamp (status {})", r.status());
    assert!(!played(&st, id).await);
}
#[tokio::test]
async fn stream_user_cap_429_does_not_stamp_or_record() {
    let (user, id) = ("stamp-u4", "STMPSTRM004");
    let st = mkstate(user); seed(id);
    let _held: Vec<_> = (0..3).map(|_| user_permit(user).expect("permit")).collect();
    let h = cookie_headers(&st, user);
    let r = stream_handler(State((st.clone(), std::path::PathBuf::new())), Method::GET, q(id, None), h).await;
    assert_eq!(r.status().as_u16(), 429);
    assert_eq!(pulls(user, id), 0);
    assert!(!played(&st, id).await);
}

                                                                                                  
                                                                                                                   
use std::sync::atomic::{AtomicU8, Ordering};
const SIZE: usize = 1000;
fn body_byte(i: usize) -> u8 { (i % 251) as u8 }
struct Origin { port: u16, mode: Arc<AtomicU8>, hits: Arc<std::sync::atomic::AtomicUsize> }                                           
async fn origin() -> Origin {
    let mode = Arc::new(AtomicU8::new(0));
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (m2, h2) = (mode.clone(), hits.clone());
    let app = axum::Router::new().route("/v", axum::routing::any(move |method: Method, hd: HeaderMap| { let (m, h) = (m2.clone(), h2.clone()); async move {
        h.fetch_add(1, Ordering::SeqCst);
        let mode = m.load(Ordering::SeqCst);
        if mode == 1 { return Response::builder().status(500).body(Body::empty()).unwrap(); }
        let range = hd.get("range").and_then(|v| v.to_str().ok()).and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.split_once('-')).map(|(a, b)| (a.parse::<usize>().ok(), b.parse::<usize>().ok()));
        let mut b = Response::builder().header("accept-ranges", "bytes").header("content-type", "video/mp4");
        if mode == 0 { b = b.header("etag", "\"strong-1\""); }
        match range {
            Some((Some(a), e)) => {
                if a >= SIZE { return Response::builder().status(416).header("content-range", format!("bytes */{SIZE}")).body(Body::empty()).unwrap(); }
                let e = e.map(|e| e.min(SIZE - 1)).unwrap_or(SIZE - 1);
                let v: Vec<u8> = (a..=e).map(body_byte).collect();
                b.status(206).header("content-range", format!("bytes {a}-{e}/{SIZE}")).header("content-length", v.len()).body(if method == Method::HEAD { Body::empty() } else { Body::from(v) }).unwrap()
            }
            _ => { let v: Vec<u8> = (0..SIZE).map(body_byte).collect(); b.status(200).header("content-length", SIZE).body(Body::from(v)).unwrap() }
        }
    }}));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    Origin { port, mode, hits }
}
fn seed_url(id: &str, port: u16) {
    let u = format!("http://127.0.0.1:{port}/v");
    let e = Entry { url: std::sync::Mutex::new(Some(u.clone())), mux: tokio::sync::OnceCell::new(), quality: String::new(), title: "T".into(), channel: "C".into(), channel_id: String::new(), duration: 0.0,
        hd: Some(Hd { video_url: u.clone(), audio_url: u, quality: "q".into() }), hd_vp9: None, hd_l: None, hd_lvp9: None, expires: std::time::Instant::now() + RESOLVE_TTL };
    RESOLVED.get_or_init(|| std::sync::Mutex::new(ResolveStore { map: HashMap::new(), order: Default::default(), inflight: HashMap::new(), neg: HashMap::new() }))
        .lock().unwrap().map.insert(id.to_string(), Arc::new(e));
}
fn direct_state(user: &str) -> Arc<crate::AppState> {
    let mut st = crate::auth_api::devices::tests::fixture(user);
    st.egress_client = Some(reqwest::Client::new()); st.proxy_url = "test-direct".into();
    Arc::new(st)
}
async fn get(st: &Arc<crate::AppState>, user: &str, id: &str, method: Method, range: Option<&str>, stream: bool) -> (u16, usize) {
    let mut h = cookie_headers(st, user);
    if let Some(r) = range { h.insert("range", r.parse().unwrap()); }
    let r = if stream { stream_handler(State((st.clone(), std::path::PathBuf::new())), method, q(id, None), h).await }
            else { vsrc_handler(State((st.clone(), std::path::PathBuf::new())), method, q(id, Some("video")), h).await };
    let code = r.status().as_u16();
    let n = axum::body::to_bytes(r.into_body(), 16 << 20).await.map(|b| b.len()).unwrap_or(0);
    (code, n)
}
fn plays(st: &crate::AppState, id: &str) -> usize {
    std::fs::read(st.data_dir.join("jetstream-playback.json")).map(|b| String::from_utf8_lossy(&b).matches(id).count()).unwrap_or(0)
}
async fn settle() { tokio::time::sleep(Duration::from_millis(500)).await; }

#[test]
fn prod_policy_still_rejects_loopback() {
    let u = Url::parse("http://127.0.0.1:8080/v").unwrap();
    assert!(!(PROD.media_ok)(&u) && PROD.pin, "PROD must reject loopback and keep pin");
    assert!(!media_host_ok(&Url::parse("https://127.0.0.1/v").unwrap()));
}
#[tokio::test]
async fn first_leg_206_stamps_and_records_once_dedupes_repeat() {
    let (user, id) = ("stamp-s1", "STMPSUCC001");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    let (c, n) = get(&st, user, id, Method::GET, Some("bytes=0-99"), false).await;
    assert_eq!((c, n), (206, 100), "success first leg");
    settle().await;
    assert_eq!(pulls(user, id), 1); assert_eq!(plays(&st, id), 1);
    let (c, _) = get(&st, user, id, Method::GET, Some("bytes=0-99"), false).await;
    assert_eq!(c, 206); settle().await;
    assert_eq!(pulls(user, id), 2, "each GET pull stamps"); assert_eq!(plays(&st, id), 1, "10-min dedupe: still one play");
}
#[tokio::test]
async fn plain_200_stamps_and_records() {
    let (user, id) = ("stamp-s2", "STMPSUCC002");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    let (c, n) = get(&st, user, id, Method::GET, None, false).await;
    assert_eq!(c, 200); assert_eq!(n, SIZE); settle().await;
    assert_eq!(pulls(user, id), 1); assert_eq!(plays(&st, id), 1);
}
#[tokio::test]
async fn continuation_206_stamps_pull_but_records_no_play() {
    let (user, id) = ("stamp-s3", "STMPSUCC003");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    let (c, n) = get(&st, user, id, Method::GET, Some("bytes=100-199"), false).await;
    assert_eq!((c, n), (206, 100)); settle().await;
    assert_eq!(pulls(user, id), 1); assert_eq!(plays(&st, id), 0, "continuation never records a play");
}
#[tokio::test]
async fn failed_then_same_id_success_records_exactly_one_play() {
    let (user, id) = ("stamp-s4", "STMPSUCC004");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    o.mode.store(1, Ordering::SeqCst);
    let (c, _) = get(&st, user, id, Method::GET, Some("bytes=0-99"), false).await;
    assert!(c >= 500, "failed attempt got {c}"); settle().await;
    assert_eq!(pulls(user, id), 0); assert_eq!(plays(&st, id), 0);
    o.mode.store(0, Ordering::SeqCst);
    let (c, _) = get(&st, user, id, Method::GET, Some("bytes=0-99"), false).await;
    assert_eq!(c, 206); settle().await;
    assert_eq!(pulls(user, id), 1); assert_eq!(plays(&st, id), 1, "the failed first try did not consume the 10-min dedupe slot");
}
#[tokio::test]
async fn past_eof_416_does_not_stamp() {
    let (user, id) = ("stamp-s5", "STMPSUCC005");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    let (c, _) = get(&st, user, id, Method::GET, Some("bytes=5000-5100"), false).await;
    assert_ne!(c / 100, 2, "got {c}"); settle().await;
    assert_eq!(pulls(user, id), 0, "status {c}"); assert_eq!(plays(&st, id), 0);
}
#[tokio::test]
async fn validatorless_plain_get_refusal_does_not_stamp() {
    let (user, id) = ("stamp-s6", "STMPSUCC006");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    o.mode.store(2, Ordering::SeqCst);
    let (c, _) = get(&st, user, id, Method::GET, None, false).await; settle().await;
    println!("validatorless plain GET -> {c}, pulls {}", pulls(user, id));
    if c / 100 != 2 { assert_eq!(pulls(user, id), 0); assert_eq!(plays(&st, id), 0); }
}
#[tokio::test]
async fn head_never_stamps_or_records() {
    let (user, id) = ("stamp-s7", "STMPSUCC007");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    let (c, _) = get(&st, user, id, Method::HEAD, Some("bytes=0-99"), false).await; settle().await;
    println!("vsrc HEAD -> {c}");
    assert_eq!(pulls(user, id), 0); assert_eq!(plays(&st, id), 0);
}
#[tokio::test]
async fn stream_first_leg_206_stamps_and_records() {
    let (user, id) = ("stamp-s8", "STMPSUCC008");
    let o = origin().await; let st = direct_state(user); seed_url(id, o.port);
    let (c, n) = get(&st, user, id, Method::GET, Some("bytes=0-99"), true).await;
    assert_eq!((c, n), (206, 100)); settle().await;
    assert_eq!(pulls(user, id), 1); assert_eq!(plays(&st, id), 1);
}
