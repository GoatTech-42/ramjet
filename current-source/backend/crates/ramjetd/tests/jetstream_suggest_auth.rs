                                                                                  
  
                                                                             
                                                                                  
                                                                                  
  
                                                                              
                                                                              
                                                                            
                                                                                 
                                         

use axum::http::{Method, Request, StatusCode};
use ramjetd::auth_api::{devices, store::{AuthStore, Login}};
use ramjetd::{AppState, Shared};
use std::sync::Arc;

const SUGGEST: &str = "/api/apps/jetstream/suggest?q=hello";
                                                       
const DEV_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";
const UNKNOWN_TOKEN: &str = "ffffffffffffffffffffffffffffffffffffffffffffffff";

fn fixture(user: &str) -> Arc<AppState> {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("sugg-auth-{}-{}", user, std::process::id()));
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

fn get(uri: &str) -> Request<axum::body::Body> {
    Request::builder().method("GET").uri(uri).body(axum::body::Body::empty()).unwrap()
}

async fn body_string(r: axum::response::Response) -> String {
    let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
    String::from_utf8(b.to_vec()).unwrap()
}

fn with_device(st: &Arc<AppState>, user: &str) {
    st.auth_db.device_insert("dev1", user, "tv", "roku", DEV_TOKEN).unwrap();
}

fn session_cookie(st: &Arc<AppState>, user: &str) -> String {
    let id = match st.auth_db.login(user, "fixture pass").unwrap() {
        Login::Ok(id) => id,
        _ => panic!("fixture login must succeed"),
    };
    st.auth_db.issue(&id).unwrap()
}

                                                                

#[test]
fn suggest_path_is_in_device_scope_and_not_deferred() {
                                                                                    
    assert!(devices::scope_allows("/api/apps/jetstream/suggest", "GET"),
        "device scope must cover /api/apps/jetstream/* (any method)");
                                                         
    assert!(!ramjetd::auth_api::deferred("/api/apps/jetstream/suggest", &Method::GET));
                                                                     
    assert!(!devices::scope_allows("/api/apps/jetstream", "GET"));
}

                                       

#[tokio::test]
async fn no_credentials_is_401_not_signed_in() {
    let st = fixture("sugg-anon");
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), get(SUGGEST)).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"not signed in"}"#);
}

#[tokio::test]
async fn malformed_bearer_is_401() {
    let st = fixture("sugg-badbearer");
    let req = Request::builder().method("GET").uri(SUGGEST)
        .header("authorization", "Bearer abc")                     
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), req).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"not signed in"}"#);
}

#[tokio::test]
async fn unknown_bearer_is_401() {
    let st = fixture("sugg-unknownbearer");
    let req = Request::builder().method("GET").uri(SUGGEST)
        .header("authorization", format!("Bearer {UNKNOWN_TOKEN}"))                             
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), req).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"not signed in"}"#);
}

#[tokio::test]
async fn valid_device_bearer_passes_auth_and_scope_then_reaches_handler() {
    let st = fixture("sugg-dev");
    with_device(&st, "sugg-dev");
    let req = Request::builder().method("GET").uri(SUGGEST)
        .header("authorization", format!("Bearer {DEV_TOKEN}"))
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), req).await;
                                                                                  
                                                              
    assert_eq!(r.status(), StatusCode::BAD_GATEWAY, "expected handler-reached 502, got non-auth failure?");
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"can't load suggestions - try again"}"#);
}

#[tokio::test]
async fn valid_device_bearer_out_of_scope_path_is_403_control() {
                                                                        
    let st = fixture("sugg-devscope");
    with_device(&st, "sugg-devscope");
    let req = Request::builder().method("GET").uri("/api/admin/users")
        .header("authorization", format!("Bearer {DEV_TOKEN}"))
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), req).await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"this device can't do that"}"#);
}

#[tokio::test]
async fn valid_session_cookie_passes_auth_then_reaches_handler() {
    let st = fixture("sugg-cookie");
    let cookie = session_cookie(&st, "sugg-cookie");
    let req = Request::builder().method("GET").uri(SUGGEST)
        .header("cookie", format!("rj2_session={cookie}"))
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), req).await;
    assert_eq!(r.status(), StatusCode::BAD_GATEWAY, "expected handler-reached 502, got non-auth failure?");
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"can't load suggestions - try again"}"#);
}

#[tokio::test]
async fn revoked_session_cookie_is_401() {
    let st = fixture("sugg-revoked");
    let cookie = session_cookie(&st, "sugg-revoked");
    st.auth_db.logout(&cookie).unwrap();
    let req = Request::builder().method("GET").uri(SUGGEST)
        .header("cookie", format!("rj2_session={cookie}"))
        .body(axum::body::Body::empty()).unwrap();
    let r = ramjetd::auth_api::dispatch(axum::extract::State(shared(&st)), req).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_string(r).await, r#"{"ok":false,"error":"not signed in"}"#);
}
