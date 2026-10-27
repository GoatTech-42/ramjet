                                                                            
                                                                                      
use std::time::{Duration, Instant};
use crate::AppState;

                                                                                  
                                                                                  
                                                                               
                                                                              
                                                                                
                          
pub fn cred_principal(st: &AppState, header: Option<&str>) -> Option<String> {
    let h = header?;
    let mut it = h.splitn(2, ' ');
    let (scheme, tok) = match (it.next(), it.next()) { (Some(s), Some(t)) => (s, t.trim()), _ => return None };
    if tok.len() < 3 || tok.len() > 400 { return None; }
    let cred = if scheme.eq_ignore_ascii_case("basic") {
        base64_decode(tok)?
    } else if scheme.eq_ignore_ascii_case("bearer") { tok.to_string() } else { return None };
    if !cred.contains(':') {
        if !crate::auth_api::devices::token_shape(&cred) { return None; }
        return crate::auth_api::devices::resolve_token(st, &cred).map(|(u, _)| u);
    }
    let i = match cred.find(':') { Some(i) if i >= 1 => i, _ => return None };
    let key = hex::sha256_hex(cred.as_bytes());
                                                                                    
                                                                                     
                                                                  
    let mut cache = match st.lite.cred_cache.lock() { Ok(c)=>c, Err(_)=>return None };
    if let Some((u, until)) = cache.get(&key) { if *until > Instant::now() { return Some(u.clone()); } }
    if verify_against_users(&st, &cred[..i], &cred[i + 1..]) {
                                                                                       
                                                                                         
                                                                                        
                                                                                          
        let name = cred[..i].to_lowercase();
        if cache.len() >= 50 { if let Some(k) = cache.keys().next().cloned() { cache.remove(&k); } }
        cache.insert(key, (name.clone(), Instant::now() + Duration::from_secs(300)));
        return Some(name);
    }
    None
}

pub fn cred_ok(st: &AppState, header: Option<&str>) -> bool {
    cred_principal(st, header).is_some()
}

fn verify_against_users(st: &AppState, name: &str, pass: &str) -> bool {
    st.auth_db.verify_lite(name, pass)
}

fn base64_decode(s: &str) -> Option<String> {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
    String::from_utf8(b).ok()
}

mod hex {
    use sha2::{Digest, Sha256};
    pub fn sha256_hex(b: &[u8]) -> String {
        let d = Sha256::digest(b);
        d.iter().map(|x| format!("{x:02x}")).collect()
    }
}

#[cfg(test)]
mod principal_tests {
                                                                                     
                                                                                 
                               
    fn st(name: &str) -> crate::AppState { crate::auth_api::devices::tests::fixture(name) }

    #[test]
    fn principal_is_db_canonical_regardless_of_sent_case() {
                                                                               
                                                                         
                                                                                  
                                                              
        let st = st("prin-case");
        for h in ["Bearer Prin-Case:fixture pass", "Bearer PRIN-CASE:fixture pass", "Bearer prin-case:fixture pass"] {
            assert_eq!(super::cred_principal(&st, Some(h)).as_deref(), Some("prin-case"), "sent case must not change the principal: {h}");
        }
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode("PrIn-CaSe:fixture pass");
        assert_eq!(super::cred_principal(&st, Some(&format!("Basic {b64}"))).as_deref(), Some("prin-case"), "Basic carries the same folding");
    }
    #[test]
    fn forged_userpass_yields_no_principal() {
        let st = st("prin-forge");
        assert_eq!(super::cred_principal(&st, Some("Bearer nobody:wrongpass")), None);
    }
    #[test]
    fn malformed_headers_yield_no_principal() {
        let st = st("prin-mal");
        assert_eq!(super::cred_principal(&st, None), None);
        assert_eq!(super::cred_principal(&st, Some("Bearer ")), None);
        assert_eq!(super::cred_principal(&st, Some("Digest abcd:efgh")), None);
        assert_eq!(super::cred_principal(&st, Some("Bearer nocolonherebutlong")), None);
    }
    #[test]
    fn unknown_device_token_yields_no_principal() {
        let st = st("prin-dev");
                                                                                
        let t = "0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(super::cred_principal(&st, Some(&format!("Bearer {t}"))), None);
    }
    #[test]
    fn expired_cache_entry_falls_through_to_db_and_stays_none() {
        let st = st("prin-stale");
                                                                                   
                                                                   
        for _ in 0..3 {
            assert_eq!(super::cred_principal(&st, Some("Bearer ghost:pw")), None);
        }
    }
}
