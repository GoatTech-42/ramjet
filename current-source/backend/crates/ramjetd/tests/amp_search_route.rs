// Amp search routing: the cursor query parameter must reach the handler, and the
// cursored path must be distinguishable from the first-page path. With no egress
// client every upstream fails fast and offline; the two paths answer DIFFERENT
// 502 bodies, which is what proves which path ran.
use axum::http::{Request, StatusCode};
use ramjetd::auth_api::store::{AuthStore, Login};
use ramjetd::{AppState, Shared};
use std::sync::Arc;

static FIXTURE_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn fixture(user: &str) -> Arc<AppState> {
    use std::os::unix::fs::PermissionsExt;
    // unique per test: cargo runs tests in parallel threads and each fixture rm -rf's its dir
    let seq = FIXTURE_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("amp-route-{}-{}-{}", user, std::process::id(), seq));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("auth.db");
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
    let auth_db = AuthStore::open(&db).unwrap();
    auth_db.claim(user, "fixture pass", false).unwrap();
    Arc::new(AppState {
        data_dir: dir.clone(),
        auth_db,
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

fn shared(st: &Arc<AppState>) -> Shared { (st.clone(), st.data_dir.clone()) }

fn session_cookie(st: &Arc<AppState>, user: &str) -> String {
    let id = match st.auth_db.login(user, "fixture pass").unwrap() {
        Login::Ok(id) => id,
        _ => panic!("fixture login must succeed"),
    };
    st.auth_db.issue(&id).unwrap()
}

async fn body_string(r: axum::response::Response) -> String {
    let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
    String::from_utf8(b.to_vec()).unwrap()
}

async fn search(st: &Arc<AppState>, uri: &str) -> (StatusCode, String) {
    let cookie = session_cookie(st, "amp-route");
    let req = Request::builder().method("GET").uri(uri)
        .header("cookie", format!("rj2_session={cookie}"))
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(st)), req).await;
    let s = r.status();
    (s, body_string(r).await)
}

#[tokio::test]
async fn foreign_cursor_is_a_400_before_any_fetch() {
    let st = fixture("amp-route");
    let (s, b) = search(&st, "/api/apps/amp/search?q=hello&cursor=yt:abcdef").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(b, r#"{"ok":false,"error":"that cursor is not understood - only audius pages continue"}"#,
        "the cursor parameter must reach the handler's cursor validation");
}

#[tokio::test]
async fn audius_cursor_takes_the_audius_only_path() {
    let st = fixture("amp-route");
    let (s, b) = search(&st, "/api/apps/amp/search?q=hello&cursor=au:12").await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert_eq!(b, r#"{"ok":false,"error":"the catalog timed out - try again"}"#,
        "the cursored path fetches only audius; its failure is the single-catalog 502");
}

#[tokio::test]
async fn no_cursor_is_the_all_sources_first_page() {
    let st = fixture("amp-route");
    let (s, b) = search(&st, "/api/apps/amp/search?q=hello").await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert_eq!(b, r#"{"ok":false,"error":"every catalog timed out - try again"}"#,
        "control: without a cursor the first-page fan-out runs and fails as all-sources");
}
