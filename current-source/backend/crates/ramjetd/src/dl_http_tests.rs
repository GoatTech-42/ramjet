                                                                                   
                                                                              
                                                                                    
                                                                                   
                                                                                   
                                                                                 
                                                                              
                                                                                  
                                                                                    
                                                                                   
                                                                                   
                                                                                   

use super::{api_session_gate, Shared2};
use ramjetd::auth_api::store::{AuthStore, Login};
use ramjetd::AppState;
use std::sync::Arc;

static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn fixture(user: &str) -> (Shared2, String, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("dl-http-{}-{}-{}", user, std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("auth.db");
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
    let auth_db = AuthStore::open(&db).unwrap();
    auth_db.claim(user, "fixture-pass-1", false).unwrap();
    let id = match auth_db.login(user, "fixture-pass-1").unwrap() { Login::Ok(id) => id, _ => panic!("fixture login failed") };
    let token = auth_db.issue(&id).unwrap();
    let st: Shared2 = (Arc::new(AppState {
        data_dir: dir.clone(),
        auth_db,
        tickets: Default::default(),
        guard: std::sync::Arc::new(ramjetd::guard::Guard::load(&dir.to_string_lossy())),
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
    }), dir.clone());
    (st, token, dir)
}

fn add_user(st: &Shared2, user: &str) -> String {
    st.0.auth_db.claim(user, "fixture-pass-1", false).unwrap();
    let id = match st.0.auth_db.login(user, "fixture-pass-1").unwrap() { Login::Ok(id) => id, _ => panic!("add_user login failed") };
    st.0.auth_db.issue(&id).unwrap()
}

async fn spawn_dl(st: Shared2) -> String {
    let app = axum::Router::new()
        .route("/api/{*rest}", axum::routing::any(ramjetd::auth_api::dispatch))
        .layer(axum::middleware::from_fn_with_state(st.clone(), api_session_gate))
        .with_state(st);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.ok()
    });
    format!("http://{addr}")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

fn authed(c: &reqwest::Client, base: &str, method: reqwest::Method, path: &str, token: &str) -> reqwest::RequestBuilder {
    c.request(method, format!("{base}{path}"))
        .header("cookie", format!("rj2_session={token}"))
        .header("x-ramjet-js", "")
}

fn sha_hex(b: &[u8]) -> String { use sha2::Digest; format!("{:x}", sha2::Sha256::digest(b)) }

async fn list_items(c: &reqwest::Client, base: &str, token: &str) -> serde_json::Value {
    let r = authed(c, base, reqwest::Method::GET, "/api/apps/downloads/list", token).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "list must be 200");
    r.json().await.unwrap()
}

async fn wait_not_fetching(c: &reqwest::Client, base: &str, token: &str) {
    for _ in 0..1000 {
        let v = list_items(c, base, token).await;
        if !v["items"].as_array().unwrap().iter().any(|i| i["state"] == "fetching") { return; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("item still fetching after 10s");
}

#[tokio::test]
async fn downloads_http_all_eight_routes_and_stage_flow() {
    let (st, t1, dir) = fixture("dl8flow");
    let t1b = add_user(&st, "dl8flowb");                                             
    let t1s2 = {                                                            
        let id = match st.0.auth_db.login("dl8flow", "fixture-pass-1").unwrap() { Login::Ok(id) => id, _ => panic!() };
        st.0.auth_db.issue(&id).unwrap()
    };
    let base = spawn_dl(st).await;
    let c = client();

                              
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"f.bin","size":6})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "stage/init reachable");
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v["ok"], true); assert_eq!(v["chunk"], 1048576);
    let id = v["id"].as_str().unwrap().to_string();

                                              
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"g.bin"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 429); assert!(r.text().await.unwrap().contains("finish the one"));

                                                             
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/enqueue", &t1)
        .json(&serde_json::json!({"url":"https://9.9.9.9/x"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 429, "enqueue blocked by in-flight stage"); assert!(r.text().await.unwrap().contains("finish the one"));

                                                                                       
    let part = |o: u64, bytes: &'static [u8], sha: String, tok: &str| {
        let c = c.clone(); let base = base.clone(); let id = id.clone(); let tok = tok.to_string();
        async move {
            authed(&c, &base, reqwest::Method::POST, &format!("/api/apps/downloads/stage/part?id={id}"), &tok)
                .header("x-chunk-offset", o.to_string()).header("x-chunk-len", bytes.len().to_string())
                .header("x-chunk-sha256", sha).body(bytes.to_vec()).send().await.unwrap()
        }
    };
    let r = part(0, b"hello!", sha_hex(b"hello!"), &t1).await;
    assert_eq!(r.status().as_u16(), 200); assert_eq!(r.json::<serde_json::Value>().await.unwrap()["size"], 6);
    let r = part(0, b"hello!", sha_hex(b"hello!"), &t1).await;                                                     
    assert_eq!(r.status().as_u16(), 200); assert_eq!(r.json::<serde_json::Value>().await.unwrap()["size"], 6);
    let r = part(10, b"x", sha_hex(b"x"), &t1).await;                  
    assert_eq!(r.status().as_u16(), 409); assert!(r.text().await.unwrap().contains("gap"));
    let r = part(6, b"z", sha_hex(b"y"), &t1).await;                                     
    assert_eq!(r.status().as_u16(), 400); assert!(r.text().await.unwrap().contains("chunk hash mismatch"));
    let r = part(6, b"z", sha_hex(b"z"), &t1s2).await;                                          
    assert_eq!(r.status().as_u16(), 401); assert!(r.text().await.unwrap().contains("session changed"));
    let r = part(6, b"z", sha_hex(b"z"), &t1b).await;                                               
    assert_eq!(r.status().as_u16(), 404);

                                  
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/complete", &t1)
        .json(&serde_json::json!({"id":id})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "stage/complete reachable");

                                              
    let v = list_items(&c, &base, &t1).await;
    let items = v["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["state"], "ready"); assert_eq!(items[0]["size"], 6); assert_eq!(items[0]["name"], "f.bin");
    let left = items[0]["expires_in_ms"].as_i64().unwrap();
    assert!((290_000..=300_500).contains(&left), "expires_in_ms {left} not ~300000");

                                                       
    let r = authed(&c, &base, reqwest::Method::GET, &format!("/api/apps/downloads/file?id={id}"), &t1).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers().get("content-disposition").unwrap(), "attachment; filename=\"f.bin\"");
    assert_eq!(r.headers().get("x-content-type-options").unwrap(), "nosniff");
    let bytes = r.bytes().await.unwrap();
    assert_eq!(&bytes[..], b"hello!", "payload must be byte-exact");

                                                                           
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/cancel", &t1)
        .json(&serde_json::json!({"id":id})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200); assert_eq!(r.json::<serde_json::Value>().await.unwrap()["ok"], true);
    assert_eq!(list_items(&c, &base, &t1).await["items"].as_array().unwrap().len(), 0);
    let udir = dir.join("downloads").join("dl8flow");
    assert!(!udir.exists() || std::fs::read_dir(&udir).unwrap().next().is_none(), "payload files must be gone");

                                                 
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"h.bin","size":1})).send().await.unwrap();
    let id2 = r.json::<serde_json::Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/cancel", &t1)
        .json(&serde_json::json!({"id":id2})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "stage/cancel reachable"); assert_eq!(r.json::<serde_json::Value>().await.unwrap()["ok"], true);
    assert_eq!(list_items(&c, &base, &t1).await["items"].as_array().unwrap().len(), 0);

                                                                                                
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/enqueue", &t1)
        .json(&serde_json::json!({"url":"https://9.9.9.9/x"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "enqueue reachable");
    let eid = r.json::<serde_json::Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    wait_not_fetching(&c, &base, &t1).await;
    let v = list_items(&c, &base, &t1).await;
    assert_eq!(v["items"][0]["state"], "failed", "egress-down enqueue must fail closed");
    let r = authed(&c, &base, reqwest::Method::GET, &format!("/api/apps/downloads/file?id={eid}"), &t1).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 404, "failed item has no file");
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/cancel", &t1)
        .json(&serde_json::json!({"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);                                  
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn downloads_http_auth_csrf_bearer_gates() {
    let (st, t1, dir) = fixture("dlgates");
    st.0.auth_db.device_insert("devdl1", "dlgates", "tv", "roku", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
    let base = spawn_dl(st).await;
    let c = client();
    let init = serde_json::json!({"name":"g.bin","size":1});

                                                          
    let r = c.post(format!("{base}/api/apps/downloads/stage/init")).json(&init).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401); assert_eq!(r.text().await.unwrap(), r#"{"ok":false,"error":"not signed in"}"#);
    let r = c.get(format!("{base}/api/apps/downloads/list")).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401);

                                                               
    let r = c.post(format!("{base}/api/apps/downloads/stage/init")).header("cookie", format!("rj2_session={t1}")).json(&init).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403); assert!(r.text().await.unwrap().contains("forbidden"));
                                           
    let r = c.post(format!("{base}/api/apps/downloads/stage/init")).header("cookie", format!("rj2_session={t1}")).header("sec-fetch-site", "cross-site").json(&init).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403);
                                                                                       
    let r = c.post(format!("{base}/api/apps/downloads/stage/init")).header("cookie", format!("rj2_session={t1}")).header("sec-fetch-site", "same-origin").json(&init).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);

                                                                                                               
    let r = c.get(format!("{base}/api/apps/downloads/list")).header("authorization", "Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403); assert!(r.text().await.unwrap().contains("this device can't do that"));
                                                   
    let r = c.get(format!("{base}/api/apps/downloads/list")).header("authorization", "Bearer cccccccccccccccccccccccccccccccccccccccccccccccc").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn downloads_http_shared_rate_window_31st_429_both_arms() {
    let (st, t1, dir) = fixture("dlrate");
    let base = spawn_dl(st).await;
    let c = client();
    for i in 1..=30 {
        let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/enqueue", &t1)
            .json(&serde_json::json!({"url":"https://9.9.9.9/x"})).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200, "enqueue #{i} must pass inside the 30/hour window");
        wait_not_fetching(&c, &base, &t1).await;                                            
    }
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/enqueue", &t1)
        .json(&serde_json::json!({"url":"https://9.9.9.9/x"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 429, "31st enqueue must 429");
    assert!(r.headers().get("retry-after").is_some());
    assert!(r.text().await.unwrap().contains("slow down a bit"));
                                                  
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"r.bin","size":1})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 429, "stage/init must share the enqueue window");
    assert!(r.text().await.unwrap().contains("slow down a bit"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn downloads_http_rotated_cookie_401() {
    let (st, t_old, dir) = fixture("dlrot");
    let base = spawn_dl(st).await;
    let c = client();
    let r = authed(&c, &base, reqwest::Method::GET, "/api/apps/downloads/list", &t_old).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "pre-rotation session valid");
    let r = authed(&c, &base, reqwest::Method::POST, "/api/auth/password", &t_old)
        .json(&serde_json::json!({"current":"fixture-pass-1","next":"fixture-pass-2"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let sc = r.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
    let t_new = sc.strip_prefix("rj2_session=").unwrap().split(';').next().unwrap().to_string();
    assert_ne!(t_old, t_new, "rotation must mint a new token");
    let r = authed(&c, &base, reqwest::Method::GET, "/api/apps/downloads/list", &t_old).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401, "rotated (old) cookie must be rejected");
    let r = authed(&c, &base, reqwest::Method::GET, "/api/apps/downloads/list", &t_new).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "new cookie works");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn downloads_http_traversal_and_absolute_ids_no_outside_fs() {
    let (st, t1, dir) = fixture("dltrav");
    let base = spawn_dl(st).await;
    let c = client();
    let sentinel = dir.join("sentinel-outside.txt");
    std::fs::write(&sentinel, b"do not touch").unwrap();

    for q in ["id=../../sentinel-outside.txt", "id=/etc/passwd", "id=..%2f..%2fsentinel-outside.txt", "id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] {
        let r = authed(&c, &base, reqwest::Method::GET, &format!("/api/apps/downloads/file?{q}"), &t1).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 404, "file?{q} must 404");
    }
    for path in ["/api/apps/downloads/cancel", "/api/apps/downloads/stage/cancel"] {
        let r = authed(&c, &base, reqwest::Method::POST, path, &t1)
            .json(&serde_json::json!({"id":"../../sentinel-outside.txt"})).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 200, "{path} is an idempotent registry no-op on unknown ids");
    }
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/complete", &t1)
        .json(&serde_json::json!({"id":"../x"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 404);
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"do not touch", "sentinel outside the downloads dir must be untouched");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn downloads_http_cross_kind_enqueue_inflight_blocks_stage_init() {
                                                                                    
                                                                           
    let hang = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let hang_addr = hang.local_addr().unwrap();
    tokio::spawn(async move { loop { let (s, _) = hang.accept().await.unwrap(); std::mem::forget(s); } });
    let (st, t1, dir) = fixture("dlcross");
    let mut st = st;
                                                                                      
    let old = Arc::try_unwrap(st.0).ok().expect("single ref");
    st.0 = Arc::new(AppState {
        egress_client: Some(reqwest::Client::builder().proxy(reqwest::Proxy::all(&format!("socks5h://{hang_addr}")).unwrap()).build().unwrap()),
        ..old
    });
    let base = spawn_dl(st).await;
    let c = client();
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/enqueue", &t1)
        .json(&serde_json::json!({"url":"https://9.9.9.9/x"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let eid = r.json::<serde_json::Value>().await.unwrap()["id"].as_str().unwrap().to_string();
                                                                                      
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"x.bin","size":1})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 429, "stage/init blocked by in-flight enqueue");
    assert!(r.text().await.unwrap().contains("finish the one"));
                                                                                          
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/cancel", &t1)
        .json(&serde_json::json!({"id":eid})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"x.bin","size":1})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn downloads_http_body_cap_exact_1mib_accepted_1mib_plus_1_413() {
    let (st, t1, dir) = fixture("dlcap");
    let base = spawn_dl(st).await;
    let c = client();
    let chunk = vec![7u8; 1 << 20];                                                
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"big.bin","size":chunk.len()})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let id = r.json::<serde_json::Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let r = authed(&c, &base, reqwest::Method::POST, &format!("/api/apps/downloads/stage/part?id={id}"), &t1)
        .header("x-chunk-offset", "0").header("x-chunk-len", chunk.len().to_string())
        .header("x-chunk-sha256", sha_hex(&chunk)).body(chunk.clone()).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "exact 1 MiB body must be accepted");
    assert_eq!(r.json::<serde_json::Value>().await.unwrap()["size"], (1u64 << 20));
    let r = authed(&c, &base, reqwest::Method::POST, &format!("/api/apps/downloads/stage/part?id={id}"), &t1)
        .header("x-chunk-offset", "0").header("x-chunk-len", "1").header("x-chunk-sha256", sha_hex(b"x"))
        .body(vec![8u8; (1 << 20) + 1]).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 413, "1 MiB + 1 body must hit the dispatch ceiling");
    let _ = std::fs::remove_dir_all(&dir);
}

                                                                                      
                                                                            
#[tokio::test]
#[ignore = "real 5-minute TTL wallclock; the rig packet owns this evidence"]
async fn downloads_http_ttl_ready_purge_real() {
    let (st, t1, dir) = fixture("dlttl");
    let base = spawn_dl(st).await;
    let c = client();
    let r = authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/init", &t1)
        .json(&serde_json::json!({"name":"t.bin","size":1})).send().await.unwrap();
    let id = r.json::<serde_json::Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    authed(&c, &base, reqwest::Method::POST, &format!("/api/apps/downloads/stage/part?id={id}"), &t1)
        .header("x-chunk-offset", "0").header("x-chunk-len", "1").header("x-chunk-sha256", sha_hex(b"z"))
        .body(b"z".to_vec()).send().await.unwrap();
    authed(&c, &base, reqwest::Method::POST, "/api/apps/downloads/stage/complete", &t1)
        .json(&serde_json::json!({"id":id})).send().await.unwrap();
    assert_eq!(list_items(&c, &base, &t1).await["items"].as_array().unwrap().len(), 1);
    tokio::time::sleep(std::time::Duration::from_secs(310)).await;
    assert_eq!(list_items(&c, &base, &t1).await["items"].as_array().unwrap().len(), 0, "item must be gone after TTL");
    let udir = dir.join("downloads").join("dlttl");
    assert!(!udir.exists() || std::fs::read_dir(&udir).unwrap().next().is_none(), "payload must be physically gone");
    let _ = std::fs::remove_dir_all(&dir);
}
