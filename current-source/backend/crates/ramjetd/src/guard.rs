                                                                                      
                                                                                        
                                                                                     
                                                                           
                                                                     
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

const WINDOW_MS: i64 = 3600 * 1000;                               
const BYTE_BUDGET: i64 = 1024 * 1024 * 1024;                         
const REQ_BUDGET: i64 = 5000;                                        
const LOGIN_TRIES: i64 = 10;                                              
const LOGIN_WINDOW: i64 = 600 * 1000;
pub const BYTE_EXEMPT: &[&str] = &["luke"];                                               

#[derive(Default)]
struct State {
    users: HashMap<String, GuardRow>,
    login_tries: HashMap<String, (i64, i64)>,
    dirty_at: i64,
}

#[derive(Default, Clone)]
pub struct GuardRow { pub window_start: i64, pub bytes: i64, pub requests: i64 }

pub struct Guard { st: Mutex<State> }

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 }

impl Guard {
                                                                                               
    pub fn load(data_dir: &str) -> Self {
        let g = Guard { st: Mutex::new(State::default()) };
        let path = format!("{}/guard.json", data_dir);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = v.as_object() {
                    let mut s = g.st.lock().unwrap();
                    for (user, row) in obj {
                        s.users.insert(user.clone(), GuardRow {
                            window_start: row.get("windowStart").and_then(|x| x.as_i64()).unwrap_or(0),
                            bytes: row.get("bytes").and_then(|x| x.as_i64()).unwrap_or(0),
                            requests: row.get("requests").and_then(|x| x.as_i64()).unwrap_or(0),
                        });
                    }
                }
            }
        }
        g
    }
    pub fn snapshot(&self) -> Value {
        Self::snapshot_state(&self.st.lock().unwrap())
    }
    fn snapshot_state(s: &State) -> Value {
        let mut o = serde_json::Map::new();
        for (user, r) in s.users.iter() {
            o.insert(user.clone(), json!({"windowStart": r.window_start, "bytes": r.bytes, "requests": r.requests}));
        }
        Value::Object(o)
    }
                                                                                                
    fn bucket<'a>(st: &'a mut State, user: &str) -> &'a mut GuardRow {
        let now = now_ms();
        let roll = match st.users.get(user) { None => true, Some(b) => now - b.window_start > WINDOW_MS };
        if roll { st.users.insert(user.to_string(), GuardRow { window_start: now, bytes: 0, requests: 0 }); }
        st.users.get_mut(user).unwrap()
    }
                                                                          
    pub fn allow_request(&self, data_dir: &str, user: &str) -> bool {
        let mut s = self.st.lock().unwrap();
        let b = Self::bucket(&mut s, user);
        b.requests += 1;
        let ok = b.requests <= REQ_BUDGET;
        self.persist_soon(&mut s, data_dir);
        ok
    }
                                                                                          
    pub fn track_bytes(&self, data_dir: &str, user: &str, n: i64) {
        let mut s = self.st.lock().unwrap();
        Self::bucket(&mut s, user).bytes += n;
        self.persist_soon(&mut s, data_dir);
    }
                                                                         
    pub fn bytes_left(&self, user: &str) -> i64 {
        if BYTE_EXEMPT.contains(&user) { return i64::MAX; }
        let mut s = self.st.lock().unwrap();
        BYTE_BUDGET - Self::bucket(&mut s, user).bytes
    }
                                                             
    pub fn allow_login(&self, key: &str, limit: Option<i64>) -> bool {
        let limit = limit.unwrap_or(LOGIN_TRIES);
        let now = now_ms();
        let mut s = self.st.lock().unwrap();
        let roll = match s.login_tries.get(key) { None => true, Some((start, _)) => now - start > LOGIN_WINDOW };
        if roll { s.login_tries.insert(key.to_string(), (now, 0)); }
        let t = s.login_tries.get_mut(key).unwrap();
        t.1 += 1;
        t.1 <= limit
    }
                                                 
    fn persist_soon(&self, s: &mut State, data_dir: &str) {
        let now = now_ms();
        if now - s.dirty_at > 15000 {
            s.dirty_at = now;
            let snap = Self::snapshot_state(s);
            let _ = std::fs::write(format!("{}/guard.json", data_dir), snap.to_string());
        }
    }
                   
    pub fn flush(&self, data_dir: &str) {
        let _ = std::fs::write(format!("{}/guard.json", data_dir), self.snapshot().to_string());
    }
}
