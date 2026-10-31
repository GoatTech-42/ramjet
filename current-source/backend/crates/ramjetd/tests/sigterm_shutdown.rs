//! Causal shutdown tests for the SIGTERM/SIGINT graceful-shutdown path.
//!
//! Causality, stated honestly:
//!  - Without a handler, a non-PID1 Unix process is KILLED by SIGTERM with NO
//!    exit status (ExitStatus::code() == None). Asserting code() == Some(0)
//!    distinguishes handler-driven graceful exit from default-disposition
//!    signal death, without needing a PID namespace.
//!  - PID-1 semantics (kernel drops handlerless signals for a PID-namespace
//!    init) were verified on the live host by Box. The pid1 tests below
//!    reproduce them off-host inside a user+PID namespace, gated on unshare
//!    availability. RAMJETD_OLD_BIN (a pre-shutdown binary, bit-identical to
//!    the live ELF) drives the contrast case; skipped when unset.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Fixture { dir: std::path::PathBuf, port: u16, child: Option<Child> }

impl Fixture {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("rj-sigterm-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.join("auth.db"), b"").unwrap();
        std::fs::set_permissions(dir.join("auth.db"), std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        Fixture { dir, port: free_port(), child: None }
    }

    fn spawn(&mut self, bin: &str, drain_secs: u64, pid_ns: bool) {
        let mut c = if pid_ns {
            let mut u = Command::new("unshare");
            u.args(["-U", "-r", "-p", "-f", "--kill-child", "--mount-proc"]).arg(bin);
            u
        } else {
            Command::new(bin)
        };
        c.env("RJ_DATA", &self.dir)
            .env("RJ_AUTH_DB", self.dir.join("auth.db"))
            .env("RJ_DIST", self.dir.join("dist"))
            .env("RJ_HOST", "127.0.0.1")
            .env("RJ_PORT", self.port.to_string())
            .env("RJ_SHUTDOWN_DRAIN_SECS", drain_secs.to_string())
            .env("RJ_PROXY", "")
            .env("SEARXNG_URL", "http://127.0.0.1:1")
            .env("YTDLP", "/bin/false")
            .stdout(Stdio::null()).stderr(Stdio::null());
        self.child = Some(c.spawn().unwrap());
    }

    fn signal(&self, sig: i32) {
        let pid = self.child.as_ref().unwrap().id() as i32;
        unsafe { libc::kill(pid, sig); }
    }

    /// With --kill-child, signalling the unshare supervisor kills the
    /// namespace init; here we signal the supervisor's child (the ns init,
    /// i.e. PID 1 inside) directly to reproduce PID-1 delivery semantics.
    fn signal_ns_init(&self, sig: i32) {
        let sup = self.child.as_ref().unwrap().id();
        let path = format!("/proc/{sup}/task/{sup}/children");
        let t0 = Instant::now();
        let init_pid: i32 = loop {
            if let Ok(s) = std::fs::read_to_string(&path) {
                if let Some(first) = s.split_whitespace().next() {
                    if let Ok(p) = first.parse() { break p; }
                }
            }
            assert!(t0.elapsed() < Duration::from_secs(5), "namespace init never appeared");
            std::thread::sleep(Duration::from_millis(20));
        };
        unsafe { libc::kill(init_pid, sig); }
    }

    fn wait_exit(&mut self, within: Duration) -> std::process::ExitStatus {
        let t0 = Instant::now();
        loop {
            if let Some(st) = self.child.as_mut().unwrap().try_wait().unwrap() { return st; }
            assert!(t0.elapsed() < within, "process did not exit within {within:?} after signal");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            unsafe { libc::kill(c.id() as i32, libc::SIGKILL); }
            let _ = c.wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn wait_health(port: u16, timeout: Duration) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < timeout {
        if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) {
            s.set_read_timeout(Some(Duration::from_secs(2))).ok();
            if s.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").is_ok() {
                let mut buf = [0u8; 512];
                if let Ok(n) = s.read(&mut buf) {
                    if n > 0 && buf[..n].windows(6).any(|w| w == b"200 OK") { return true; }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[test]
fn sigterm_clean_exit_fast_when_idle() {
    let mut fx = Fixture::new("idle");
    fx.spawn(env!("CARGO_BIN_EXE_ramjetd"), 8, false);
    assert!(wait_health(fx.port, Duration::from_secs(30)), "server did not come up");
    let t0 = Instant::now();
    fx.signal(libc::SIGTERM);
    let st = fx.wait_exit(Duration::from_secs(10));
    let el = t0.elapsed();
    assert_eq!(st.code(), Some(0), "expected clean exit(0), got {st:?} (signal death would be code None)");
    assert!(el < Duration::from_secs(4), "idle drain should be near-instant, took {el:?}");
}

#[test]
fn sigterm_held_incomplete_request_still_exits_promptly() {
    // A connection held mid-request (incomplete head) must not hang shutdown:
    // hyper drops incomplete requests at drain start, so exit is fast; the
    // drain deadline remains the backstop for long in-flight responses and
    // is reviewed in source (spawned sleep -> exit(0)), not exercised here
    // because no stock endpoint streams slowly without auth/egress fixtures.
    let mut fx = Fixture::new("held");
    fx.spawn(env!("CARGO_BIN_EXE_ramjetd"), 2, false);
    assert!(wait_health(fx.port, Duration::from_secs(30)), "server did not come up");
    let mut s = std::net::TcpStream::connect(("127.0.0.1", fx.port)).unwrap();
    s.write_all(b"POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 999\r\n\r\n").unwrap();
    let t0 = Instant::now();
    fx.signal(libc::SIGTERM);
    let st = fx.wait_exit(Duration::from_secs(12));
    let el = t0.elapsed();
    assert_eq!(st.code(), Some(0), "expected clean exit(0), got {st:?}");
    assert!(el < Duration::from_secs(12), "must not hang on a held connection, took {el:?}");
}

#[test]
fn sigint_clean_exit_fast_when_idle() {
    let mut fx = Fixture::new("sigint");
    fx.spawn(env!("CARGO_BIN_EXE_ramjetd"), 8, false);
    assert!(wait_health(fx.port, Duration::from_secs(30)), "server did not come up");
    fx.signal(libc::SIGINT);
    let st = fx.wait_exit(Duration::from_secs(10));
    assert_eq!(st.code(), Some(0), "expected clean exit(0) on SIGINT, got {st:?}");
}

#[test]
fn sigterm_pid1_namespace_exits_zero() {
    if Command::new("unshare").args(["-U", "-r", "-p", "-f", "--kill-child", "--mount-proc", "true"])
        .status().map(|s| !s.success()).unwrap_or(true) {
        eprintln!("unshare PID namespace unavailable; skipping");
        return;
    }
    let mut fx = Fixture::new("pid1");
    fx.spawn(env!("CARGO_BIN_EXE_ramjetd"), 8, true);
    assert!(wait_health(fx.port, Duration::from_secs(30)), "server did not come up in namespace");
    fx.signal_ns_init(libc::SIGTERM);
    let st = fx.wait_exit(Duration::from_secs(10));
    assert_eq!(st.code(), Some(0), "PID 1 WITH handler must exit(0) on SIGTERM, got {st:?}");
}

/// Contrast: the pre-shutdown binary (bit-identical to the live ELF) as PID 1
/// must IGNORE SIGTERM - this is the exact mechanism Box observed live. Gated
/// on RAMJETD_OLD_BIN so CI without the artifact skips it.
#[test]
fn old_binary_pid1_ignores_sigterm_contrast() {
    let Ok(old) = std::env::var("RAMJETD_OLD_BIN") else {
        eprintln!("RAMJETD_OLD_BIN unset; skipping contrast");
        return;
    };
    if Command::new("unshare").args(["-U", "-r", "-p", "-f", "--kill-child", "--mount-proc", "true"])
        .status().map(|s| !s.success()).unwrap_or(true) {
        eprintln!("unshare PID namespace unavailable; skipping");
        return;
    }
    let mut fx = Fixture::new("contrast");
    fx.spawn(&old.clone(), 8, true);
    assert!(wait_health(fx.port, Duration::from_secs(30)), "old server did not come up in namespace");
    fx.signal_ns_init(libc::SIGTERM);
    let t0 = Instant::now();
    let mut exited = false;
    while t0.elapsed() < Duration::from_secs(3) {
        if fx.child.as_mut().unwrap().try_wait().unwrap().is_some() { exited = true; break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!exited, "old PID-1 binary must IGNORE SIGTERM (that is the live failure mode), but it exited");
    // drop(guard) SIGKILLs the supervisor; --kill-child reaps the ns init.
}
