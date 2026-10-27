                                                                                    
                                                                                 
                                                                                  
pub mod render_config;
pub mod render_connect;
pub mod auth_api;
pub mod egress;
pub mod guard;
pub mod searx_fetch;
pub mod searx_page;
pub mod searx_proxy;
pub mod searx_reader;
pub mod lite;
pub mod apps;
pub mod statics;
pub mod jetstream_media;
pub mod adblock;
pub mod pfetch;
pub mod sys;

use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub data_dir: PathBuf,
    pub auth_db: auth_api::store::AuthStore,
    pub tickets: auth_api::wisp::Tickets,
    pub guard: std::sync::Arc<guard::Guard>,
    pub rates: auth_api::rate::Rates,
    pub egress_client: Option<reqwest::Client>,                                                       
    pub pfetch_client: Option<reqwest::Client>,                                                                
    pub adblock: adblock::Adblock,
    pub started: std::time::Instant,
    pub local_http: reqwest::Client,                                                              
    pub searx_url: String,
    pub ytdlp: PathBuf,
    pub proxy_url: String,
    pub lite: lite::LiteState,
    pub jetstream_js: apps::jetstream_up::Js,                                                 

}

#[derive(Clone, serde::Deserialize)]
pub struct SessionRec {
    pub user: String,
    pub expires: i64,
}

pub struct EgressDown;

impl AppState {
    pub fn egress(&self) -> Result<&reqwest::Client, String> {
        self.egress_client.as_ref().ok_or_else(|| "egress unavailable".to_string())
    }
}

pub type Shared = (Arc<AppState>, PathBuf);
