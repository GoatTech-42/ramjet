                                                                  
                                                                                       
                                                                                     
                                                                       
                                                                                     
                                                                                     
                                                                 
use ramjetd::{egress, lite, statics, AppState};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(feature = "qa-hooks")]
#[used]
static QA_HOOKS_BUILD_MARKER: &[u8] = b"RAMJET_QA_HOOKS_BUILD_NOT_FOR_DEPLOYMENT\0";

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
    ).init();
    #[cfg(feature = "qa-hooks")]
    tracing::warn!("QA-HOOKS BUILD: render/CA test knobs ACTIVE - NOT FOR DEPLOYMENT");

    let data_dir = PathBuf::from(std::env::var("RJ_DATA").unwrap_or_else(|_| "./data".into()));
    ramjetd::auth_api::boot_check(&data_dir).expect("private pre-provisioned DATA required");
    ramjetd::apps::amp_media::remux_boot_clean(&data_dir);                                                     
    ramjetd::apps::downloads::boot_sweep(&data_dir);                                                                     
    let db_path=std::env::var("RJ_AUTH_DB").expect("RJ_AUTH_DB required for INC2");
    let auth_db=ramjetd::auth_api::store::AuthStore::open(std::path::Path::new(&db_path)).expect("auth DB unavailable");
    let dist = PathBuf::from(std::env::var("RJ_DIST").unwrap_or_else(|_| "./web/dist".into()));
    let searx_url = std::env::var("SEARXNG_URL").unwrap_or_else(|_| "http://127.0.0.1:8888".into());
    let ytdlp = PathBuf::from(std::env::var("YTDLP").unwrap_or_else(|_| "./bin/yt-dlp".into()));
    let proxy_url = std::env::var("RJ_PROXY").unwrap_or_default();

                                                                                           
                                                                            
    let egress_client = if proxy_url.is_empty() {
        tracing::error!("RJ_PROXY unset: no direct-connect path exists; external egress DISABLED");
        None
    } else {
        match egress::build(&proxy_url) {
                                                                                           
                                                                                 
            Ok(eg) => {
                let mut up = None;
                for attempt in 1..=3u8 {
                    match egress::probe(&eg).await {
                        Ok(ip) => { tracing::info!("egress up via proxy, upstream sees {ip}"); up = Some(eg.client.clone()); break; }
                        Err(e) => tracing::error!("proxy probe attempt {attempt}/3 failed ({e})"),
                    }
                    if attempt < 3 { tokio::time::sleep(std::time::Duration::from_secs(2)).await; }
                }
                if up.is_none() { tracing::error!("proxy probe failed after 3 attempts; external egress DISABLED"); }
                up
            }
            Err(e) => { tracing::error!("{e}; external egress DISABLED"); None }
        }
    };

    let pfetch_client = if egress_client.is_some() {
        match ramjetd::egress::build_pfetch(&proxy_url) { Ok(c) => Some(c), Err(e) => { tracing::error!("{e}; pfetch DISABLED"); None } }
    } else { None };
    let adblock = ramjetd::adblock::Adblock::load(&data_dir);
    let guard = std::sync::Arc::new(ramjetd::guard::Guard::load(&data_dir.to_string_lossy()));                                                                    
    let state = Arc::new(AppState {
        data_dir,
        egress_client,
        pfetch_client,
        adblock,
        started: std::time::Instant::now(),
        local_http: egress::local_client(),
        searx_url,
        ytdlp,
        proxy_url,
        auth_db,
        rates: Default::default(),
        tickets: Default::default(),
        guard,

        lite: lite::LiteState::new(),
        jetstream_js: ramjetd::apps::jetstream_up::Js::new(),
    });

    let shared = (state.clone(), dist);
    let app = axum::Router::new()
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .route("/", axum::routing::get(page_index))
        .route("/login", axum::routing::get(page_login))
        .route("/login.html", axum::routing::get(page_login))
        .route("/index.html", axum::routing::get(page_index))
        .route("/password", axum::routing::get(page_password))
        .route("/claim", axum::routing::get(page_claim))
        .route("/browse", axum::routing::get(page_browse))
        .route("/jetstream", axum::routing::get(page_jetstream))
        .route("/amp", axum::routing::get(page_amp))
        .route("/sage", axum::routing::get(page_sage))
        .route("/banter", axum::routing::get(page_banter))
        .route("/settings", axum::routing::get(page_settings))
                                                                                  
                                                                                         
                                              
        .route("/browse/", axum::routing::get(page_slash_index))
        .route("/amp/", axum::routing::get(page_slash_index))
        .route("/sage/", axum::routing::get(page_slash_index))
        .route("/settings/", axum::routing::get(page_slash_index))
        .route("/jetstream/", axum::routing::get(page_slash_404))
        .route("/banter/", axum::routing::get(page_slash_404))
        .route("/auth/ai-key", axum::routing::get(ai_key))
        .route("/searx/{*rest}", axum::routing::get(searx_stub))
        .route("/a/r/{a}/{b}/codec.wasm.js", axum::routing::get(codec_wasm_shim))
        .nest("/api/lite", lite::router(shared.clone()))
        .merge(ramjetd::jetstream_media::router())
        .route("/api/media-bridge/ticket", axum::routing::post(ramjetd::auth_api::wisp::ticket).fallback(||async{ramjetd::lite::json_err(axum::http::StatusCode::METHOD_NOT_ALLOWED,"bad method")}))
        .route("/api/media-bridge/{*rest}", axum::routing::any(ramjetd::auth_api::wisp::relay))
        .route("/api/{*rest}", axum::routing::any(ramjetd::auth_api::dispatch))
        .fallback(statics::serve)
                                                                                     
                                                                                  
        .layer(axum::middleware::from_fn_with_state(shared.clone(), api_session_gate))
        .layer(axum::middleware::from_fn(|req: axum::http::Request<axum::body::Body>, next: axum::middleware::Next| async move {
            let m = req.method().clone();
            let p = req.uri().path().to_string();
            if !p.starts_with("/api/") && m != axum::http::Method::GET && m != axum::http::Method::HEAD {
                return axum::http::Response::builder().status(axum::http::StatusCode::METHOD_NOT_ALLOWED).body(axum::body::Body::empty()).unwrap();
            }
            next.run(req).await
        }))
        .with_state(shared);

                                                                                                                                                     
                                                                                                                                                  
    if let Some(rc) = ramjetd::render_config::load(&state.data_dir) {
        match tokio::net::TcpListener::bind(rc.listen).await {
            Ok(l) => {
                let cc = rc.connect_config();
                let socks = cc.socks.clone();
                let resolve = ramjetd::render_connect::doh_resolver(cc);
                let dial: ramjetd::render_connect::DialFn = std::sync::Arc::new(move |ip, port| { let s = socks.clone(); Box::pin(async move { ramjetd::render_connect::socks5_dial(&s, ip, port).await }) });
                tokio::spawn(ramjetd::render_connect::serve(l, resolve, dial));
                tracing::info!("render terminator on {}", rc.listen);
                ramjetd::render_config::install(rc);
            }
            Err(e) => tracing::warn!("render terminator bind failed ({e}); renderer disabled"),
        }
    } else { tracing::info!("render.json absent or invalid; renderer disabled"); }
    ramjetd::apps::browse_render::start_sweeper();
    ramjetd::auth_api::devices::start_pair_sweeper(state.clone());

                                                                                                    
    ramjetd::jetstream_media::set_pull_hook(std::sync::Arc::new(|u: &str, v: &str| { ramjetd::apps::browse_render::stamp_media_pull(u, v); }));

    let host = std::env::var("RJ_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("RJ_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(14224);
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("bind addr");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    tracing::info!("ramjetd on {addr}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.expect("serve");
}


                                                                                
                                                                                
                                                                               
                                                                         
                                                                            
                                                                                   
                                              
async fn api_session_gate(
    axum::extract::State(st): axum::extract::State<Shared2>,
    mut req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let p = req.uri().path().to_string();
                                                                                
                                                                           
                                                                  
    let bridge_socket = ramjetd::auth_api::wisp::socket_key(&p).is_some();
                                                                                               
                                                                                    
    let open_pair = matches!(p.as_str(),"/api/devices/pair"|"/api/devices/pair/status"|"/api/devices/pair/consume");
                                                                                           
                                                                                          
                                                                                         
                                        
    let open_pfetch = p == "/api/pfetch" && req.method() == axum::http::Method::POST;
                                                                                      
    let token=ramjetd::auth_api::devices::bearer_token(req.headers());
    let auth=if let Some(token)=token{match ramjetd::auth_api::devices::resolve_bounded(st.0.clone(),token).await{Ok(v)=>v,Err(())=>return axum::response::Response::builder().status(503).body(axum::body::Body::from("try again in a moment")).unwrap()}}else{None};
    let device_ok=auth.is_some();
    req.extensions_mut().insert(ramjetd::auth_api::devices::DeviceAuth(auth.map(|(u,id)|ramjetd::auth_api::devices::DeviceIdentity(u,id))));
                                                                                          
    let thumb_path = matches!(p.as_str(),"/api/apps/jetstream/thumb"|"/api/jetstream/thumb");
    let ticket_ok = thumb_path && url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
        .filter(|(k, _)| k == "t").map(|(_, v)| v.into_owned()).last()                                                                      
        .and_then(|t| ramjetd::auth_api::wisp::thumb_ticket_user(&st.0.data_dir, &t))
        .filter(|u| st.0.auth_db.user_enabled(u)).is_some();                                                       
    let device_ok = device_ok || ticket_ok;
    if p.starts_with("/api/") && !bridge_socket && !ramjetd::auth_api::deferred(&p,req.method()) && !p.starts_with("/api/lite") && !matches!(p.as_str(),"/api/auth/login"|"/api/auth/signup"|"/api/auth/claim"|"/api/auth/logout") && !open_pair && !open_pfetch && !has_session(&st.0, &req) && !device_ok {
        return axum::http::Response::builder()
            .status(axum::http::StatusCode::UNAUTHORIZED)
            .header(axum::http::header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(axum::http::header::CACHE_CONTROL, "no-store")
            .body(axum::body::Body::from("{\"ok\":false,\"error\":\"not signed in\"}"))
            .unwrap();
    }
    next.run(req).await
}

                                                                                      
                                                                                       
                                                                             
                                                                               
                                                                                    
                                                 
type Shared2 = (std::sync::Arc<AppState>, std::path::PathBuf);

fn has_session(st: &AppState, req: &axum::http::Request<axum::body::Body>) -> bool {
    ramjetd::auth_api::user(st, req.headers()).is_some()
}

fn redirect(loc: &'static str) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut r = axum::http::StatusCode::FOUND.into_response();
    r.headers_mut().insert(axum::http::header::LOCATION, loc.parse().unwrap());
    r
}

async fn page_named(dist: &std::path::Path, name: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    let p = dist.join("pages").join(name).join(format!("{name}.html"));
    match tokio::fs::read(&p).await {
        Ok(bytes) => ([(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
                       (axum::http::header::CACHE_CONTROL, "no-cache")], bytes).into_response(),
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE,
                   [(axum::http::header::CONTENT_TYPE, "text/plain")],
                   "building... check back in a minute").into_response(),
    }
}

macro_rules! gated_page {
    ($f:ident, $name:literal) => {
        async fn $f(axum::extract::State(st): axum::extract::State<Shared2>,
                    req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
            let dist = &st.1;
            if !has_session(&st.0, &req) { return redirect("/login"); }
            page_named(&dist, $name).await
        }
    };
}
gated_page!(page_index, "index");
gated_page!(page_password, "password");
gated_page!(page_claim, "claim");
gated_page!(page_browse, "browse");
gated_page!(page_jetstream, "jetstream");
gated_page!(page_amp, "amp");
gated_page!(page_sage, "sage");
gated_page!(page_banter, "banter");
gated_page!(page_settings, "settings");

async fn page_slash_index(axum::extract::State(st): axum::extract::State<Shared2>,
                        req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
    if !has_session(&st.0, &req) { return redirect("/login"); }
    page_named(&st.1, "index").await
}
async fn page_slash_404(axum::extract::State(st): axum::extract::State<Shared2>,
                        req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
    if !has_session(&st.0, &req) { return redirect("/login"); }
    not_found_plain()
}
fn not_found_plain() -> axum::response::Response {
                                                                          
    axum::response::Response::builder()
        .status(axum::http::StatusCode::NOT_FOUND)
        .header(axum::http::header::CONTENT_TYPE, "text/plain")
        .body(axum::body::Body::from("nothing here")).unwrap()
}
async fn page_login(axum::extract::State(st): axum::extract::State<Shared2>,
                    req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
    if has_session(&st.0, &req) { return redirect("/"); }                             
    page_named(&st.1, "login").await
}

                   
async fn ai_key() -> axum::response::Response {
    use axum::response::IntoResponse;
    ([(axum::http::header::CONTENT_TYPE, "application/json; charset=utf-8"),
      (axum::http::header::CACHE_CONTROL, "no-store")], r#"{"has":false}"#).into_response()
}

                                                                                   
                                                                                
async fn searx_stub(axum::extract::State(st): axum::extract::State<Shared2>,
                    req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
    if !has_session(&st.0, &req) { return redirect("/login"); }
    ramjetd::searx_proxy::handler(axum::extract::State(st), req).await
}

                                                                                     
                                                                                   
                                                                                     
                                                                          
struct WasmShim { js: Vec<u8>, gz: Vec<u8>, etag: String }
static WASM_SHIM: std::sync::OnceLock<Option<WasmShim>> = std::sync::OnceLock::new();

async fn codec_wasm_shim(axum::extract::State(st): axum::extract::State<Shared2>,
                      req: axum::http::Request<axum::body::Body>) -> axum::response::Response {
    use axum::response::IntoResponse;
    use base64::Engine;
    use std::io::Write;
    let shim = WASM_SHIM.get_or_init(|| {
        let wp = st.1.join("assets").join("codec").join("codec.wasm");
        let bytes = std::fs::read(&wp).ok()?;
        let mtime_ms = std::fs::metadata(&wp).and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64).unwrap_or(0);                             
        let js = format!("self.WASM = '{}';", base64::engine::general_purpose::STANDARD.encode(&bytes)).into_bytes();
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
        e.write_all(&js).ok()?;
        let gz = e.finish().ok()?;
        Some(WasmShim { js, gz, etag: format!("W/\"{}-{}\"", bytes.len(), mtime_ms) })
    });
    let Some(w) = shim else {
        return not_found_plain();
    };
    if req.headers().get("if-none-match").and_then(|v| v.to_str().ok()) == Some(w.etag.as_str()) {
        let mut r = axum::http::StatusCode::NOT_MODIFIED.into_response();
        r.headers_mut().insert(axum::http::header::ETAG, w.etag.parse().unwrap());
        return r;
    }
    let gz = req.headers().get("accept-encoding").and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').any(|t| t.trim().starts_with("gzip"))).unwrap_or(false);
    let is_head = req.method() == axum::http::Method::HEAD;
    let body = if gz { &w.gz } else { &w.js };
    let mut r = axum::http::StatusCode::OK.into_response();
    let h = r.headers_mut();
    h.insert(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8".parse().unwrap());
    h.insert(axum::http::header::CACHE_CONTROL, "no-cache".parse().unwrap());
    h.insert(axum::http::header::ETAG, w.etag.parse().unwrap());
    h.insert(axum::http::header::VARY, "Accept-Encoding".parse().unwrap());
    h.insert(axum::http::header::CONTENT_LENGTH, body.len().into());
    if gz { h.insert(axum::http::header::CONTENT_ENCODING, "gzip".parse().unwrap()); }
    if !is_head { *r.body_mut() = axum::body::Body::from(body.clone()); }
    r
}

                                                                                       
                                                                               
                                                                             
                                                                              
                                                                                  
                                                                                 
                                                                              
#[cfg(test)]
mod dl_http_tests;

#[cfg(test)]
mod gate_tests {
    use super::{api_session_gate, Shared2};
    use ramjetd::auth_api::store::{AuthStore, Login};
    use ramjetd::AppState;
    use std::sync::Arc;

    const SUGGEST: &str = "/api/apps/jetstream/suggest?q=hello";
                                                           
    const DEV_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const UNKNOWN_TOKEN: &str = "ffffffffffffffffffffffffffffffffffffffffffffffff";

    fn fixture(user: &str) -> Shared2 {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sugg-gate-{}-{}", user, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("auth.db");
        std::fs::write(&db, b"").unwrap();
        std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
        let auth_db = AuthStore::open(&db).unwrap();
        auth_db.claim(user, "fixture pass", false).unwrap();
        (Arc::new(AppState {
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
        }), dir)
    }

    async fn spawn_gate(st: Shared2) -> String {
        let app = axum::Router::new()
            .route("/api/{*rest}", axum::routing::any(|| async {
                axum::http::Response::builder().status(200).body(axum::body::Body::from("reached")).unwrap()
            }))
            .layer(axum::middleware::from_fn_with_state(st.clone(), api_session_gate))
            .with_state(st);
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(l, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.ok()
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn suggest_without_credentials_is_401_before_routing() {
        let base = spawn_gate(fixture("anon")).await;
        let r = reqwest::get(format!("{base}{SUGGEST}")).await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
        assert_eq!(r.headers().get("cache-control").unwrap(), "no-store");
        assert_eq!(r.text().await.unwrap(), r#"{"ok":false,"error":"not signed in"}"#);
    }

    #[tokio::test]
    async fn suggest_with_malformed_bearer_is_401() {
        let base = spawn_gate(fixture("badbearer")).await;
        let r = reqwest::Client::new().get(format!("{base}{SUGGEST}"))
            .header("authorization", "Bearer abc")                     
            .send().await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
        assert_eq!(r.text().await.unwrap(), r#"{"ok":false,"error":"not signed in"}"#);
    }

    #[tokio::test]
    async fn suggest_with_unknown_bearer_is_401() {
        let base = spawn_gate(fixture("unknownbearer")).await;
        let r = reqwest::Client::new().get(format!("{base}{SUGGEST}"))
            .header("authorization", format!("Bearer {UNKNOWN_TOKEN}"))                             
            .send().await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
        assert_eq!(r.text().await.unwrap(), r#"{"ok":false,"error":"not signed in"}"#);
    }

    #[tokio::test]
    async fn suggest_with_thumb_ticket_param_still_401s() {
                                                                                  
                             
        let base = spawn_gate(fixture("ticket")).await;
        let r = reqwest::get(format!("{base}/api/apps/jetstream/suggest?q=hello&t=whatever")).await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
    }

    #[tokio::test]
    async fn suggest_with_valid_device_bearer_passes_the_gate() {
        let st = fixture("dev");
        st.0.auth_db.device_insert("dev1", "dev", "tv", "roku", DEV_TOKEN).unwrap();
        let base = spawn_gate(st).await;
        let r = reqwest::Client::new().get(format!("{base}{SUGGEST}"))
            .header("authorization", format!("Bearer {DEV_TOKEN}"))
            .send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.text().await.unwrap(), "reached");
    }

    #[tokio::test]
    async fn suggest_with_valid_session_cookie_passes_the_gate() {
        let st = fixture("cookie");
        let id = match st.0.auth_db.login("cookie", "fixture pass").unwrap() {
            Login::Ok(id) => id,
            _ => panic!("fixture login must succeed"),
        };
        let token = st.0.auth_db.issue(&id).unwrap();
        let base = spawn_gate(st).await;
        let r = reqwest::Client::new().get(format!("{base}{SUGGEST}"))
            .header("cookie", format!("rj2_session={token}"))
            .send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.text().await.unwrap(), "reached");
    }

    #[tokio::test]
    async fn pairing_status_stays_open_control() {
                                                                                   
                                                                               
        let base = spawn_gate(fixture("control")).await;
        let r = reqwest::get(format!("{base}/api/devices/pair/status?poll=x")).await.unwrap();
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.text().await.unwrap(), "reached");
    }
}
