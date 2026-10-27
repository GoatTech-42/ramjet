                                                                                        
                                                                                      
                                                                                        
                                                                   
use std::time::Duration;

pub struct Egress {
    pub client: reqwest::Client,                                                           
    pub proxy_url: String,
}

pub const UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";


                                                                                
                                                                               
                                                                             
                                                                            
#[cfg(any(test, feature = "qa-hooks"))]
fn extra_ca() -> (Vec<reqwest::Certificate>, bool) {
    let Ok(path) = std::env::var("RJ_EXTRA_CA_FILE") else { return (vec![], false) };
    if path.trim().is_empty() { return (vec![], false) }
    let test = std::env::var("RJ_TEST_MODE").map(|v| !v.trim().is_empty()).unwrap_or(false);
    if !test {
        tracing::warn!("RJ_EXTRA_CA_FILE set but RJ_TEST_MODE is NOT set - IGNORING extra CA bundle (double-gate, test-only override)");
        return (vec![], false);
    }
                                                                                            
    let fatal = |why: String| -> ! {
        tracing::error!("RJ_EXTRA_CA_FILE {path}: {why} - REFUSING TO BOOT (test-mode extra CA must be a readable PEM bundle with at least one valid certificate)");
        std::process::exit(1);
    };
    let pem = std::fs::read(&path).unwrap_or_else(|e| fatal(format!("unreadable: {e}")));
    let certs = reqwest::Certificate::from_pem_bundle(&pem).unwrap_or_else(|e| fatal(format!("bad bundle: {e}")));
    if certs.is_empty() { fatal("zero valid certificates in a non-empty file".to_string()); }
    tracing::warn!("EXTRA CA ACTIVE - TEST MODE: {} extra root(s) from {} (additive to webpki-roots)", certs.len(), path);
    (certs, true)
}
                                                                                                   
                                                                                                          
                                                                                                      
                                                                                                             
#[cfg(not(any(test, feature = "qa-hooks")))]
fn extra_ca() -> (Vec<reqwest::Certificate>, bool) { (vec![], false) }

                                                                                   
                                                                         
fn finish_build(b: reqwest::ClientBuilder, ca_active: bool) -> reqwest::Client {
    match b.build() {
        Ok(c) => c,
        Err(e) => {
            if ca_active { tracing::error!("RJ_EXTRA_CA_FILE bundle rejected at client build: {e} - REFUSING TO BOOT"); }
            else { tracing::error!("client build failed: {e}"); }
            std::process::exit(1);
        }
    }
}

pub fn build(proxy_url: &str) -> Result<Egress, String> {
    let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("bad RJ_PROXY: {e}"))?;
    let (ca, ca_active) = extra_ca();
    let mut b = reqwest::Client::builder();
    for c in ca { b = b.add_root_certificate(c); }
    let client = finish_build(b
        .proxy(proxy)
        .user_agent(UA)
        .redirect(reqwest::redirect::Policy::none())
                                                                                         
                                                                                      
                                                                                       
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30)), ca_active);
    Ok(Egress { client, proxy_url: proxy_url.to_string() })
}

                                                                                            
                                                                                                 
pub fn build_stream(proxy_url: &str) -> Result<reqwest::Client, String> {
    let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("bad RJ_PROXY: {e}"))?;
    let (ca, ca_active) = extra_ca();
    let mut b = reqwest::Client::builder();
    for c in ca { b = b.add_root_certificate(c); }
    Ok(finish_build(b
        .proxy(proxy)
        .gzip(false).brotli(false)                                                          
        .user_agent(UA)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)), ca_active))
}

                                                                                                
                                                                                           
                                                                                          
                                                                                          
                                                                                   
pub fn build_pfetch(proxy_url: &str) -> Result<reqwest::Client, String> {
    let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("bad RJ_PROXY: {e}"))?;
    let (ca, ca_active) = extra_ca();
    let mut b = reqwest::Client::builder();
    for c in ca { b = b.add_root_certificate(c); }
    Ok(finish_build(b
        .proxy(proxy)
        .gzip(false).brotli(false)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(8), ca_active))
}

                                                                              
                                                                                     
                                                                                       
pub async fn probe(e: &Egress) -> Result<String, String> {
                                                                                  
                                                                                   
                                                                              
                                                                        
    let eps: Vec<String> = std::env::var("RJ_PROBE_URLS").ok()
        .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .filter(|v: &Vec<String>| !v.is_empty())
        .unwrap_or_else(|| ["https://ifconfig.me/ip", "https://icanhazip.com", "https://api.ipify.org"].iter().map(|s| s.to_string()).collect());
    let mut errs = vec![];
    for url in &eps {
        let url = url.as_str();
        match probe_one(e, url).await {
            Ok(ip) => return Ok(ip),
            Err(err) => { tracing::warn!("egress probe {url} failed: {err}"); errs.push(format!("{url}: {err}")); }
        }
    }
    Err(errs.join("; "))
}

async fn probe_one(e: &Egress, url: &str) -> Result<String, String> {
    let r = e.client.get(url).timeout(Duration::from_secs(10)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() { return Err(format!("status {}", r.status())); }
    let ip = r.text().await.map_err(|e| e.to_string())?;
    let ip = ip.trim();
    if ip.len() > 45 || !ip.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':') {
        return Err("implausible probe answer".into());
    }
    Ok(ip.to_string())
}

                                                            
pub fn local_client() -> reqwest::Client {
    let (ca, ca_active) = extra_ca();
    let mut b = reqwest::Client::builder();
    for c in ca { b = b.add_root_certificate(c); }
    finish_build(b
        .user_agent(UA)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(15)), ca_active)
}
