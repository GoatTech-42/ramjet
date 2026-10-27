                                                                  
                                                                                          
                                                                                     
                                                                          
                                                                                           

use axum::http::StatusCode;
use axum::response::Response;
use crate::lite::{json_ord, OJ};

fn load1() -> f64 {
    std::fs::read_to_string("/proc/loadavg").ok()
        .and_then(|s| s.split_whitespace().next().and_then(|t| t.parse::<f64>().ok())).unwrap_or(0.0)
}

fn mem_free_mb() -> i64 {
    std::fs::read_to_string("/proc/meminfo").ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("MemFree:")).and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse::<i64>().ok())))
        .map(|kb| kb / 1024).unwrap_or(0)
}

fn cache_mb(data_dir: &std::path::Path) -> i64 {
                                                                 
    static CACHE: std::sync::OnceLock<std::sync::Mutex<(std::time::Instant, i64)>> = std::sync::OnceLock::new();
    let m = CACHE.get_or_init(|| std::sync::Mutex::new((std::time::Instant::now() - std::time::Duration::from_secs(61), 0)));
    let mut g = m.lock().unwrap();
    if g.0.elapsed() > std::time::Duration::from_secs(60) {
        let mut bytes = 0i64;
        if let Ok(rd) = std::fs::read_dir(data_dir.join("stream-cache")) {
            for e in rd.flatten() { if let Ok(meta) = e.metadata() { bytes += meta.len() as i64; } }
        }
        *g = (std::time::Instant::now(), bytes);
    }
    g.1 / 1048576
}

pub fn handle(st: &crate::AppState) -> Response {
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)),
        ("version", OJ::Str(env!("CARGO_PKG_VERSION").into())),
        ("node", OJ::Str("rust".into())),
        ("uptime", OJ::Raw(format!("{}", st.started.elapsed().as_secs()))),
        ("load", OJ::Raw(format!("{:.2}", load1()))),
        ("cpus", OJ::Raw(format!("{}", std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)))),
        ("memFreeMB", OJ::Raw(format!("{}", mem_free_mb()))),
        ("cacheMB", OJ::Raw(format!("{}", cache_mb(&st.data_dir)))),
        ("apps", OJ::Arr(vec!["browse", "jetstream", "amp", "sage", "banter"].into_iter().map(|a| OJ::Str(a.into())).collect())),
    ])
}
