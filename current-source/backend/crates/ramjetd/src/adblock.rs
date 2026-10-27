                                                                                        
                                                                                          
                                                                               
                                                                                       
                                                                                          

use std::collections::{HashMap, HashSet};

const EXTRA: &[&str] = &[
    "ads.pubmatic.com", "securepubads.g.doubleclick.net", "doubleclick.net", "adsystem.com",
    "amazon-adsystem.com", "taboola.com", "outbrain.com", "criteo.com", "criteo.net", "adnxs.com",
    "rubiconproject.com", "openx.net", "casalemedia.com", "scorecardresearch.com", "quantserve.com",
    "moatads.com", "adsrvr.org", "adform.net", "smartadserver.com", "media.net", "pubmatic.com",
    "zedo.com", "advertising.com", "yieldmo.com", "sharethrough.com", "teads.tv", "connatix.com",
    "hotjar.com", "fullstory.com", "mixpanel.com", "segment.io", "branch.io", "app-measurement.com",
    "ads-twitter.com", "analytics.tiktok.com", "ads.linkedin.com",
];
const SAFE: &[&str] = &[
    "google.com", "gstatic.com", "googleapis.com", "youtube.com", "ytimg.com", "cloudflare.com",
    "cloudfront.net", "jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "github.com",
    "githubusercontent.com", "wikipedia.org", "wikimedia.org", "reddit.com", "redd.it",
    "redditstatic.com", "redditmedia.com",
];

fn safe(h: &str) -> bool { SAFE.contains(&h) }

                                                                                  
fn parse(text: &str) -> HashSet<String> {
    let mut s: HashSet<String> = EXTRA.iter().map(|h| h.to_string()).collect();
    for line in text.split('\n') {
        let h = line.trim().to_lowercase();
        if h.is_empty() || h.starts_with('#') || !h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-') || safe(&h) { continue; }
        s.insert(h);
    }
    s
}

#[derive(Default)]
pub struct AdStats { pub blocked: i64, pub by_user: HashMap<String, i64> }

pub struct Adblock { hosts: HashSet<String>, stats: std::sync::Mutex<AdStats> }

impl Adblock {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let mut hosts = parse(&std::fs::read_to_string(data_dir.join("adblock-hosts.txt")).unwrap_or_default());
                                                                                            
                                                                                   
        if let Ok(ubo) = std::fs::read_to_string(data_dir.join("ubo-hosts.txt")) {
            for line in ubo.split('\n') { let h = line.trim().to_lowercase(); if h.is_empty() || safe(&h) { continue; } hosts.insert(h); }
        }
        Adblock { hosts, stats: Default::default() }
    }

                                                                                             
    pub fn is_ad_host(&self, host: &str) -> bool {
        let mut h = host.to_lowercase();
        if h.ends_with('.') { h.pop(); }                                
        if h.is_empty() || h.bytes().all(|b| b.is_ascii_digit() || b == b'.' || b == b':') { return false; }
        loop {
            if safe(&h) { return false; }
            if self.hosts.contains(&h) { return true; }
            let Some(i) = h.find('.') else { return false; };
            h = h[i + 1..].to_string();
            if !h.contains('.') { return false; }
        }
    }

    pub fn note_blocked(&self, user: &str) {
        let mut s = self.stats.lock().unwrap();
        s.blocked += 1;
        *s.by_user.entry(user.to_string()).or_insert(0) += 1;
    }

    pub fn list_size(&self) -> usize { self.hosts.len() }
    pub fn blocked_for(&self, user: &str) -> i64 { *self.stats.lock().unwrap().by_user.get(user).unwrap_or(&0) }

                                                                                                     
    pub fn stats_handler(&self, user: &str) -> axum::response::Response {
        crate::lite::json_ord(axum::http::StatusCode::OK, vec![
            ("ok", crate::lite::OJ::Bool(true)),
            ("hosts", crate::lite::OJ::Raw(format!("{}", self.list_size()))),
            ("blocked", crate::lite::OJ::Raw(format!("{}", self.blocked_for(user)))),
        ])
    }
    #[cfg(test)] pub fn stats_for(&self, user: &str) -> (i64, i64) { let s = self.stats.lock().unwrap(); (s.blocked, *s.by_user.get(user).unwrap_or(&0)) }
}

#[cfg(test)]
mod adblock_tests {
    #[test]
    fn ubo_parse_is_crlf_safe_and_lowercased() {
        let dir = std::env::temp_dir().join(format!("ad-ubo-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ubo-hosts.txt"), "ADS.Fixture\r\nPlain.Example\n\r\n").unwrap();
        std::fs::write(dir.join("adblock-hosts.txt"), "Main-Host.com\n").unwrap();
        let ad = super::Adblock::load(&dir);
        assert!(ad.is_ad_host("ads.fixture"), "CRLF + case");
        assert!(ad.is_ad_host("sub.ads.fixture"));
        assert!(ad.is_ad_host("plain.example"));
        assert!(ad.is_ad_host("main-host.com"));
        assert!(!ad.is_ad_host("google.com"));             
        assert!(!ad.is_ad_host("example.com"));
        assert_eq!(ad.list_size(), 36 + 2 + 1);                            
    }
}
