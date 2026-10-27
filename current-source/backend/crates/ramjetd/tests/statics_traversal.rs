                                                                             
                                                       
use ramjetd::statics::resolve_safe;

#[test]
fn rejects_traversal() {
    let dist = std::env::temp_dir().join("rj-test-dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("ok.txt"), b"hi").unwrap();
    assert!(resolve_safe(&dist, "ok.txt").is_some());
    assert!(resolve_safe(&dist, "../data/users.json").is_none());
    assert!(resolve_safe(&dist, "a/../../b").is_none());
    assert!(resolve_safe(&dist, "/absolute").is_none());
    assert!(resolve_safe(&dist, "./ok.txt").is_none());
    assert!(resolve_safe(&dist, "").is_none());
    std::fs::remove_dir_all(&dist).ok();
}
