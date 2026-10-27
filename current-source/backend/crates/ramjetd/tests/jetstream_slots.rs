                                                                                                      
use ramjetd::apps::jetstream_up::YTDLP_SLOTS;
use ramjetd::jetstream_media::*;
use std::time::{Duration, Instant};

const HD: &str = r#"{"formats":[{"url":"vv","protocol":"https","vcodec":"avc1.1","acodec":"none","width":1920,"height":1080,"fps":30,"format_note":"1080p"},{"url":"aa","protocol":"https","vcodec":"none","acodec":"mp4a.40.2","abr":128,"ext":"m4a"}]}"#;

fn fake(dir: &std::path::Path, sleep: &str) -> ResolveCfg {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::create_dir_all(dir);
    let log = dir.join("ev.log");
    let script = dir.join("yt-dlp");
                                                                          
    let sh = format!("#!/bin/sh\necho s >> {l}\nsleep {sleep}\necho e >> {l}\ncat <<'JSON'\n{HD}\nJSON\n", l = log.display());
    std::fs::write(&script, sh).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    ResolveCfg { ytdlp: script, proxy: String::new() }
}
fn peak(dir: &std::path::Path) -> (usize, usize) {
    let (mut cur, mut max, mut n) = (0i32, 0i32, 0usize);
    for l in std::fs::read_to_string(dir.join("ev.log")).unwrap_or_default().lines() {
        if l == "s" { cur += 1; n += 1; max = max.max(cur); } else { cur -= 1; }
    }
    (max as usize, n)
}
fn tmp(n: &str) -> std::path::PathBuf { let d = std::env::temp_dir().join(format!("rj-slots-{n}-{}", std::process::id())); let _ = std::fs::remove_dir_all(&d); d }

#[tokio::test]
async fn distinct_resolves_never_exceed_the_shared_slot_cap() {
    let d = tmp("cap");
    let cfg = fake(&d, "0.4");
    let ids: Vec<String> = (0..9).map(|i| format!("slotcap{i:04}")).collect();
    let t = Instant::now();
    let rs = futures::future::join_all(ids.iter().map(|i| resolve_stream(&cfg, i, false))).await;
    assert!(rs.iter().all(|r| r.is_ok()));
    let (max, n) = peak(&d);
    assert_eq!(n, 9);
    assert!(max <= 3, "peak concurrent yt-dlp was {max}, cap is 3");
    assert!(max >= 2, "should still run in parallel up to the cap (peak {max})");
    assert!(t.elapsed() >= Duration::from_millis(1100), "9 jobs / 3 slots x 0.4s must take >= 3 waves, took {:?}", t.elapsed());
}

#[tokio::test]
async fn resolve_waits_for_a_slot_held_by_another_lane_then_proceeds() {
    let d = tmp("held");
    let cfg = fake(&d, "0");
    let held = YTDLP_SLOTS.acquire_many(3).await.unwrap();                              
    let c2 = cfg.clone();
    let job = tokio::spawn(async move { resolve_stream(&c2, "heldslot001", false).await.is_ok() });
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(peak(&d).1, 0, "no child may spawn while every slot is held");
    assert!(!job.is_finished());
    drop(held);
    assert!(tokio::time::timeout(Duration::from_secs(10), job).await.unwrap().unwrap());
    assert_eq!(peak(&d).1, 1);
}

#[tokio::test]
async fn a_failed_or_timed_out_resolve_releases_its_slot() {
    let bad = ResolveCfg { ytdlp: "/nonexistent/yt-dlp".into(), proxy: String::new() };
    for i in 0..6 { assert!(resolve_stream(&bad, &format!("slotfail{i:04}"), false).await.is_err()); }
    assert_eq!(YTDLP_SLOTS.available_permits(), 3, "failures must not leak slots");
}
