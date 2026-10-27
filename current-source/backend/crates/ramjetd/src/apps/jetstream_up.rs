                                                                                       
                                                                          
                                                                                      
                                                                                  
                                                                                      
                                                                                     
                                                                                 
                                              
                                                                                     
                                                                           
use axum::http::StatusCode;
use axum::response::Response;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use crate::lite::{json_err, json_ord, OJ};
use super::jetstream::{user_hist_ids, user_subs, vid_ok};
use super::{io_fail, js_slice16, js_trim, oj_num, read_store, store_mutex, write_json, StoreRead};

                                              
#[derive(Clone, Debug, PartialEq)]
pub enum Jv { Null, Bool(bool), Num(f64), Str(String), Arr(Vec<Jv>), Obj(Vec<(String, Jv)>) }
static NULL: Jv = Jv::Null;
impl<'de> Deserialize<'de> for Jv {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Jv;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("json") }
            fn visit_unit<E>(self) -> Result<Jv, E> { Ok(Jv::Null) }
            fn visit_none<E>(self) -> Result<Jv, E> { Ok(Jv::Null) }
            fn visit_bool<E>(self, b: bool) -> Result<Jv, E> { Ok(Jv::Bool(b)) }
            fn visit_i64<E>(self, n: i64) -> Result<Jv, E> { Ok(Jv::Num(n as f64)) }
            fn visit_u64<E>(self, n: u64) -> Result<Jv, E> { Ok(Jv::Num(n as f64)) }
            fn visit_f64<E>(self, n: f64) -> Result<Jv, E> { Ok(Jv::Num(n)) }
            fn visit_str<E>(self, s: &str) -> Result<Jv, E> { Ok(Jv::Str(s.to_string())) }
            fn visit_string<E>(self, s: String) -> Result<Jv, E> { Ok(Jv::Str(s)) }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut a: A) -> Result<Jv, A::Error> {
                let mut v = vec![]; while let Some(x) = a.next_element()? { v.push(x); } Ok(Jv::Arr(v))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut a: A) -> Result<Jv, A::Error> {
                let mut v: Vec<(String, Jv)> = vec![];
                while let Some((k, x)) = a.next_entry::<String, Jv>()? {
                                                                                     
                    if let Some(p) = v.iter_mut().find(|(kk, _)| *kk == k) { p.1 = x; } else { v.push((k, x)); }
                }
                Ok(Jv::Obj(v))
            }
        }
        d.deserialize_any(V)
    }
}
impl Jv {
    pub fn parse(b: &[u8]) -> Result<Jv, String> { serde_json::from_slice(b).map_err(|_| "bad json".to_string()) }
    pub fn get(&self, k: &str) -> &Jv {
        if let Jv::Obj(m) = self { for (kk, v) in m { if kk == k { return v; } } }
        &NULL
    }
    pub fn at(&self, i: usize) -> &Jv { if let Jv::Arr(a) = self { a.get(i).unwrap_or(&NULL) } else { &NULL } }
    pub fn arr(&self) -> &[Jv] { if let Jv::Arr(a) = self { a } else { &[] } }
    pub fn s(&self) -> Option<&str> { if let Jv::Str(s) = self { Some(s) } else { None } }
    pub fn num(&self) -> Option<f64> { if let Jv::Num(n) = self { Some(*n) } else { None } }
    pub fn truthy(&self) -> bool {
        match self { Jv::Null => false, Jv::Bool(b) => *b, Jv::Num(n) => *n != 0.0 && !n.is_nan(), Jv::Str(s) => !s.is_empty(), _ => true }
    }
                                                                     
    pub fn jstr(&self) -> String {
        match self {
            Jv::Null => "null".into(), Jv::Bool(b) => b.to_string(), Jv::Str(s) => s.clone(),
            Jv::Num(n) => super::js_num_str(*n),
            Jv::Arr(a) => a.iter().map(|x| if matches!(x, Jv::Null) { String::new() } else { x.jstr() }).collect::<Vec<_>>().join(","),
            Jv::Obj(_) => "[object Object]".into(),
        }
    }
    fn children(&self) -> Vec<&Jv> {
        match self { Jv::Arr(a) => a.iter().collect(), Jv::Obj(m) => m.iter().map(|(_, v)| v).collect(), _ => vec![] }
    }
    fn is_node(&self) -> bool { matches!(self, Jv::Arr(_) | Jv::Obj(_)) }
}
                                             
fn or<'a>(xs: &[&'a Jv]) -> &'a Jv { for x in xs { if x.truthy() { return x; } } xs[xs.len() - 1] }

                                                                                            
fn text_sp(t: &Jv) -> String {
    if t.get("runs").truthy() {
        t.get("runs").arr().iter().map(|r| match r.get("text") { Jv::Null => String::new(), x => x.jstr() }).collect::<String>()
    } else { let s = t.get("simpleText"); if s.truthy() { s.jstr() } else { String::new() } }
}
                                                                
fn txt(t: &Jv) -> String {
    let r = if t.get("runs").truthy() {
        t.get("runs").arr().iter().map(|r| match r.get("text") { Jv::Null => String::new(), x => x.jstr() }).collect::<String>()
    } else { let x = or(&[t.get("simpleText"), t.get("content")]); if x.truthy() { x.jstr() } else { String::new() } };
    r
}
fn fix_img(u: &str) -> String { if u.starts_with("//") { format!("https:{u}") } else { u.to_string() } }

                                                                         
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SearchItem { pub id: String, pub title: String, pub channel: String, #[serde(rename = "channelId")] pub channel_id: String,
    pub duration: String, pub views: String, pub published: String, pub desc: String }
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct KindChannel { pub id: String, pub name: String, pub handle: String, pub subs: String, pub desc: String, pub avatar: String }
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct KindPlaylist { pub id: String, pub title: String, pub channel: String, pub count: String, #[serde(rename = "thumbVid")] pub thumb_vid: String }
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ChanItem { pub id: String, pub title: String, pub channel: String, #[serde(rename = "channelId")] pub channel_id: String,
    pub duration: String, pub views: String, #[serde(serialize_with = "ser_opt_num")] pub secs: Option<f64> }
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PlItem { pub id: String, pub title: String, pub channel: String, #[serde(rename = "channelId")] pub channel_id: String, pub duration: String, pub views: String }
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ChanPl { pub id: String, pub title: String, pub count: String, #[serde(rename = "thumbVid")] pub thumb_vid: String }
fn ser_opt_num<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v { None => s.serialize_none(), Some(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => s.serialize_i64(*n as i64), Some(n) => s.serialize_f64(*n) }
}

                                     
                                            
pub fn parse_search(data: &Jv, cap: usize) -> Vec<SearchItem> {
    fn walk(node: &Jv, out: &mut Vec<SearchItem>) {
        if !node.is_node() { return; }
        let v = or(&[node.get("videoRenderer"), node.get("compactVideoRenderer")]);
        if v.truthy() {
            let title = text_sp(v.get("title"));
            let dur = text_sp(v.get("lengthText"));
            if v.get("videoId").truthy() && !title.is_empty() && !dur.is_empty() {
                let byline = or(&[v.get("ownerText"), v.get("longBylineText"), v.get("shortBylineText")]);
                let cid = byline.get("runs").at(0).get("navigationEndpoint").get("browseEndpoint").get("browseId");
                out.push(SearchItem { id: v.get("videoId").jstr(), title, channel: text_sp(byline),
                    channel_id: if cid.truthy() { cid.jstr() } else { String::new() },
                    duration: dur, views: text_sp(v.get("viewCountText")), published: text_sp(v.get("publishedTimeText")), desc: text_sp(v.get("descriptionSnippet")) });
            }
            return;
        }
        for c in node.children() { walk(c, out); }
    }
    let mut out = vec![]; walk(data, &mut out);
    let mut seen = std::collections::HashSet::new();
    out.into_iter().filter(|v| seen.insert(v.id.clone())).take(cap).collect()
}
                                 
pub fn search_token(data: &Jv) -> Option<String> {
    let mut lists: Vec<&[Jv]> = vec![];
    let first = data.get("contents").get("twoColumnSearchResultsRenderer").get("primaryContents").get("sectionListRenderer").get("contents");
    if let Jv::Arr(a) = first { lists.push(a); }
    for cmd in data.get("onResponseReceivedCommands").arr() {
        if let Jv::Arr(a) = cmd.get("appendContinuationItemsAction").get("continuationItems") { lists.push(a); }
    }
    let mut tok = None;
    for l in lists { for el in l {
        if let Jv::Str(t) = el.get("continuationItemRenderer").get("continuationEndpoint").get("continuationCommand").get("token") { if !t.is_empty() { tok = Some(t.clone()); } }
    } }
    tok
}
fn re(p: &str) -> regex::Regex { regex::Regex::new(p).unwrap() }
                                                                   
pub fn parse_kind_search(data: &Jv, kind: &str) -> Vec<String> {
    let rc = re(r"^UC[A-Za-z0-9_-]{20,24}$"); let rp = re(r"^(PL|OL|UU|FL|RD)[A-Za-z0-9_-]{8,40}$"); let rv = re(r"/vi/([A-Za-z0-9_-]{11})/");
    let mut out: Vec<(String, String)> = vec![];
    fn walk(node: &Jv, kind: &str, rc: &regex::Regex, rp: &regex::Regex, rv: &regex::Regex, out: &mut Vec<(String, String)>) {
        if !node.is_node() { return; }
        if kind == "channel" && node.get("channelRenderer").truthy() {
            let c = node.get("channelRenderer"); let id = c.get("channelId");
            let ids = if id.truthy() { id.jstr() } else { String::new() };
            if rc.is_match(&ids) {
                let th = c.get("thumbnail").get("thumbnails").arr();
                let last = th.last().map(|t| t.get("url")).unwrap_or(&NULL);
                let sct = c.get("subscriberCountText").get("simpleText");
                let handle = if sct.jstr().starts_with('@') && sct.truthy() { sct.jstr() } else { String::new() };
                let a = txt(c.get("videoCountText")); let subs = if !a.is_empty() { a } else { txt(c.get("subscriberCountText")) };
                let row = KindChannel { id: ids.clone(), name: txt(c.get("title")), handle, subs, desc: txt(c.get("descriptionSnippet")),
                    avatar: if last.truthy() { fix_img(&last.jstr()) } else { String::new() } };
                out.push((ids, serde_json::to_string(&row).unwrap()));
            }
            return;
        }
        if kind == "playlist" && node.get("lockupViewModel").truthy() && regex::Regex::new("PLAYLIST").unwrap().is_match(&{ let ct = node.get("lockupViewModel").get("contentType"); if ct.truthy() { ct.jstr() } else { String::new() } }) {
            let l = node.get("lockupViewModel"); let id = l.get("contentId");
            let ids = if id.truthy() { id.jstr() } else { String::new() };
            if rp.is_match(&ids) {
                let ptv = l.get("contentImage").get("collectionThumbnailViewModel").get("primaryThumbnail").get("thumbnailViewModel");
                let src = ptv.get("image").get("sources").at(0).get("url");
                let srcs = if src.truthy() { src.jstr() } else { String::new() };
                let vid = rv.captures(&srcs).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()).unwrap_or_default();
                let b = ptv.get("overlays").at(0).get("thumbnailOverlayBadgeViewModel").get("thumbnailBadges").at(0).get("thumbnailBadgeViewModel").get("text");
                let lm = l.get("metadata").get("lockupMetadataViewModel");
                let ch = lm.get("metadata").get("contentMetadataViewModel").get("metadataRows").at(0).get("metadataParts").at(0).get("text").get("content");
                let row = KindPlaylist { id: ids.clone(), title: txt(lm.get("title")), channel: if ch.truthy() { ch.jstr() } else { String::new() },
                    count: if b.truthy() { b.jstr() } else { String::new() }, thumb_vid: vid };
                out.push((ids, serde_json::to_string(&row).unwrap()));
            }
            return;
        }
        for c in node.children() { walk(c, kind, rc, rp, rv, out); }
    }
    walk(data, kind, &rc, &rp, &rv, &mut out);
    let mut seen = std::collections::HashSet::new();
    out.into_iter().filter(|(id, _)| seen.insert(id.clone())).map(|(_, j)| j).take(20).collect()
}

fn fmt_dur(v: &Jv) -> String {
    match v.num() { Some(s) if s > 0.0 => format!("{}:{:0>2}", (s / 60.0).floor() as i64, super::js_round(s % 60.0) as i64), _ => String::new() }
}
                                                           
fn locale(n: f64) -> String {
    let neg = n < 0.0; let a = n.abs();
    let mut s = if a.fract() == 0.0 { format!("{}", a as u64) } else { let t = format!("{:.3}", a); t.trim_end_matches('0').trim_end_matches('.').to_string() };
    let (ip, fp) = match s.find('.') { Some(i) => (s[..i].to_string(), s[i..].to_string()), None => (s.clone(), String::new()) };
    let mut g = String::new();
    for (i, ch) in ip.chars().enumerate() { if i > 0 && (ip.len() - i) % 3 == 0 { g.push(','); } g.push(ch); }
    s = format!("{}{g}{fp}", if neg { "-" } else { "" }); s
}
fn fmt_views(v: &Jv) -> String { match v.num() { Some(n) if n > 0.0 => format!("{} views", locale(n)), _ => String::new() } }
fn slice(s: &str, n: usize) -> String { js_slice16(s, n) }
fn s_or(xs: &[&Jv]) -> String { let x = or(xs); if x.truthy() { x.jstr() } else { String::new() } }

pub struct ChanTab { pub at: i64, pub name: String, pub items: Vec<ChanItem> }
                                                                                                                                                                                                 
pub fn build_chan_tab(data: &Jv, id: &str, tab: &str, shorts_ids: &std::collections::HashSet<String>, dead: &std::collections::HashSet<String>, now: i64) -> ChanTab {
    let mut items: Vec<ChanItem> = data.get("entries").arr().iter().filter(|e| e.truthy() && e.get("id").truthy() && e.get("title").truthy()).map(|e| {
        let fallback = s_or(&[data.get("channel"), data.get("uploader")]);
        ChanItem { id: e.get("id").jstr(), title: slice(&s_or(&[e.get("title")]), 300),
            channel: slice(&s_or(&[e.get("channel"), &Jv::Str(fallback)]), 200), channel_id: id.to_string(),
            duration: fmt_dur(e.get("duration")), views: fmt_views(e.get("view_count")), secs: e.get("duration").num() }
    }).collect();
    if tab == "videos" { items.retain(|v| !shorts_ids.contains(&v.id) && v.secs.map(|s| s > 61.0).unwrap_or(true)); }
    else { items.retain(|v| v.secs.map(|s| s <= 61.0).unwrap_or(true)); }
    items.retain(|v| !dead.contains(&v.id)); items.truncate(60);
    let nm = s_or(&[data.get("channel"), data.get("uploader"), data.get("title")]);
    let nm = nm.strip_prefix("Uploads from ").unwrap_or(&nm).to_string();
    ChanTab { at: now, name: slice(&nm, 200), items }
}

pub struct PlPage { pub at: i64, pub name: String, pub channel: String, pub channel_id: String, pub count: Jv, pub items: Vec<PlItem> }
pub fn build_playlist(data: &Jv, dead: &std::collections::HashSet<String>, now: i64) -> PlPage {
    let r11 = re(r"^[A-Za-z0-9_-]{11}$");
    let mut items: Vec<PlItem> = data.get("entries").arr().iter().filter(|e| {
        e.truthy() && r11.is_match(&if e.get("id").truthy() { e.get("id").jstr() } else { String::new() }) && e.get("title").truthy()
            && e.get("title").jstr() != "[Private video]" && e.get("title").jstr() != "[Deleted video]"
            && !(e.get("age_limit").num().map(|n| n >= 18.0).unwrap_or(false))
            && !matches!(e.get("availability").s(), Some("needs_auth" | "premium_only" | "subscriber_only" | "private"))
            && !dead.contains(&e.get("id").jstr())
    }).map(|e| {
        let cid = e.get("channel_id").jstr();
        PlItem { id: e.get("id").jstr(), title: slice(&e.get("title").jstr(), 300), channel: slice(&s_or(&[e.get("channel"), e.get("uploader")]), 200),
            channel_id: if e.get("channel_id").truthy() && cid.starts_with("UC") { cid } else { String::new() },
            duration: fmt_dur(e.get("duration")), views: fmt_views(e.get("view_count")) }
    }).collect();
    let mut seen = std::collections::HashSet::new();
    let mut i = items.len();
    while i > 0 { i -= 1; if !seen.insert(items[i].id.clone()) { items.remove(i); } }
    let cid = data.get("channel_id");
    let count = if data.get("playlist_count").truthy() { data.get("playlist_count").clone() } else { Jv::Num(items.len() as f64) };
    PlPage { at: now, name: slice(&s_or(&[data.get("title")]), 200), channel: slice(&s_or(&[data.get("channel"), data.get("uploader")]), 200),
        channel_id: if cid.truthy() && cid.jstr().starts_with("UC") { cid.jstr() } else { String::new() }, count, items }
}

pub struct ChanPlPage { pub at: i64, pub items: Vec<ChanPl> }
pub struct ChanInfo { pub at: i64, pub id: String, pub name: String, pub desc: String, pub handle: String, pub subs: String, pub videos: String, pub banner: String, pub avatar: String }
                                          
pub fn build_chan_playlists(data: &Jv, now: i64) -> ChanPlPage {
    let rp = re(r"^(PL|OL|FL)[A-Za-z0-9_-]{8,40}$"); let rv = re(r"/vi/([A-Za-z0-9_-]{11})/"); let rvv = re(r"/vi/[A-Za-z0-9_-]{11}/");
    let mut items: Vec<ChanPl> = data.get("entries").arr().iter().filter(|e| {
        e.truthy() && rp.is_match(&if e.get("id").truthy() { e.get("id").jstr() } else { String::new() }) && e.get("title").truthy()
    }).map(|e| {
        let th: String = e.get("thumbnails").arr().iter().map(|t| if t.get("url").truthy() { t.get("url").jstr() } else { String::new() }).find(|u| rvv.is_match(u)).unwrap_or_default();
        ChanPl { id: e.get("id").jstr(), title: slice(&e.get("title").jstr(), 300), count: String::new(),
            thumb_vid: rv.captures(&th).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()).unwrap_or_default() }
    }).collect();
    items.truncate(60);
    ChanPlPage { at: now, items }
}
                               
pub fn build_chan_info(j: &Jv, id: &str, now: i64) -> ChanInfo {
    let meta = j.get("metadata").get("channelMetadataRenderer");
    let vm = j.get("header").get("pageHeaderRenderer").get("content").get("pageHeaderViewModel");
    let parts: Vec<String> = vm.get("metadata").get("contentMetadataViewModel").get("metadataRows").arr().iter()
        .flat_map(|r| r.get("metadataParts").arr().iter().map(|x| { let c = x.get("text").get("content"); if c.truthy() { c.jstr() } else { String::new() } }).collect::<Vec<_>>())
        .filter(|s| !s.is_empty()).collect();
    let handle = parts.iter().find(|x| x.starts_with('@')).cloned().unwrap_or_default();
    let ci = |s: &str| { let l = s.to_lowercase(); l };
    let subs = parts.iter().find(|x| ci(x).contains("subscriber")).cloned().unwrap_or_default();
    let videos = parts.iter().find(|x| ci(x).contains("video")).cloned().unwrap_or_default();
    let bsrc = vm.get("banner").get("imageBannerViewModel").get("image").get("sources").arr();
    let pick = bsrc.iter().find(|x| { let w = x.get("width"); (if w.truthy() { w.num().unwrap_or(f64::NAN) } else { 0.0 }) >= 1000.0 }).or_else(|| bsrc.last());
    let burl = pick.map(|x| x.get("url")).filter(|u| u.truthy()).map(|u| u.jstr()).unwrap_or_default();
    let banner = if burl.is_empty() { String::new() } else if burl.starts_with("https:") { burl } else { fix_img(&burl) };
    let av = meta.get("avatar").get("thumbnails").at(0).get("url");
    ChanInfo { at: now, id: id.to_string(), name: slice(&s_or(&[meta.get("title")]), 200), desc: slice(&s_or(&[meta.get("description")]), 3000),
        handle, subs, videos, banner, avatar: if av.truthy() { av.jstr() } else { String::new() } }
}

                                      
pub trait Up: Sync {
                                                                                                        
    fn innertube<'a>(&'a self, web: bool, endpoint: &'a str, body: Value) -> BoxFuture<'a, Result<Jv, String>>;
                                                                                                   
    fn ytdlp<'a>(&'a self, url: &'a str, playlist_end: Option<u32>) -> BoxFuture<'a, Result<Jv, String>>;
                                                                                                                 
    fn fetch<'a>(&'a self, url: &'a str, max: usize) -> BoxFuture<'a, Result<(u16, Vec<u8>, String), String>>;
    fn track(&self, _user: &str, _n: usize) {}                      
                                                                                                        
                                                                                                                               
    fn want_bg(&self, _kind: BgKind, _user: &str) {}
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BgKind { ForYou, Shorts }

                                                                                      
pub static YTDLP_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
                                                                                              
                                                                               
pub static YTDLP_LANE_MEDIA: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub static YTDLP_LANE_DATA: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub static YTDLP_LANE_AMP: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
                                                                                         
                                                            
pub async fn ytdlp_take(lane: &'static tokio::sync::Semaphore) -> Result<(tokio::sync::SemaphorePermit<'static>, tokio::sync::SemaphorePermit<'static>), ()> {
    let g = match tokio::time::timeout(std::time::Duration::from_secs(20), YTDLP_SLOTS.acquire()).await { Ok(Ok(p)) => p, _ => return Err(()) };
    let l = match tokio::time::timeout(std::time::Duration::from_secs(20), lane.acquire()).await { Ok(Ok(p)) => p, _ => return Err(()) };
    Ok((g, l))
}
pub struct AppUp<'a>(pub &'a crate::AppState, pub Option<std::sync::Arc<crate::AppState>>);
impl<'a> AppUp<'a> { pub fn new(st: &'a crate::AppState) -> Self { Self(st, None) } }
impl<'a> Up for AppUp<'a> {
                                                                                            
                                                                                         
    fn want_bg(&self, kind: BgKind, user: &str) {
        let Some(arc) = self.1.clone() else { return };
        let user = user.to_string();
        tokio::spawn(async move {
            let up = AppUp(arc.as_ref(), None);
            let clock: super::jetstream_feedroutes::Clock = std::sync::Arc::new(|| crate::apps::millis());
            match kind {
                BgKind::ForYou => super::jetstream_feedroutes::background_rec(&up, &arc.data_dir, &user, &clock).await,
                BgKind::Shorts => super::jetstream_feedroutes::background_shorts(&up, &arc.data_dir, &user, &clock).await,
            }
        });
    }

    fn innertube<'b>(&'b self, web: bool, endpoint: &'b str, body: Value) -> BoxFuture<'b, Result<Jv, String>> {
        Box::pin(async move {
            let eg = self.0.egress()?;
            let ctx = if web { serde_json::json!({"client":{"clientName":"WEB","clientVersion":"2.20250925.01.00","hl":"en","gl":"US"}}) }
                      else { serde_json::json!({"client":{"clientName":"ANDROID","clientVersion":"20.10.38","androidSdkVersion":34,"hl":"en","gl":"US"}}) };
            let ua = if web { "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } else { "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" };
            let mut b = serde_json::json!({"context": ctx});
            if let (Some(bo), Some(src)) = (b.as_object_mut(), body.as_object()) { for (k, v) in src { bo.insert(k.clone(), v.clone()); } }
            let r = eg.post(format!("https://www.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false"))
                .header("user-agent", ua).header("content-type", "application/json").timeout(std::time::Duration::from_secs(12))
                .json(&b).send().await.map_err(|_| "upstream error".to_string())?;                                 
            if !r.status().is_success() { return Err(format!("yt {endpoint} {}", r.status())); }
                                                                                      
            if r.content_length().map_or(false, |n| n > (32 << 20)) { return Err("too big".into()); }
            let mut r=r;let mut bytes=Vec::new();while let Some(c)=r.chunk().await.map_err(|_|"upstream error".to_string())?{if bytes.len().saturating_add(c.len())>(32<<20){return Err("too big".into())}bytes.extend_from_slice(&c)}
            Jv::parse(&bytes)
        })
    }
    fn ytdlp<'b>(&'b self, url: &'b str, playlist_end: Option<u32>) -> BoxFuture<'b, Result<Jv, String>> {
        Box::pin(async move {
                                                                                                                 
                                                                                   
            let _slots = match ytdlp_take(&YTDLP_LANE_DATA).await {
                Ok(s) => s, _ => return Err("busy".to_string()),
            };
            use tokio::io::AsyncReadExt;
            let mut cmd = tokio::process::Command::new(&self.0.ytdlp);
            cmd.args(["--flat-playlist", "--dump-single-json"]);
            if let Some(n) = playlist_end { cmd.args(["--playlist-end", &n.to_string()]); }
                                                                                                                  
                                                                                                          
            if !self.0.proxy_url.is_empty() { cmd.args(["--proxy", &self.0.proxy_url]); }
                                                                                                                        
            let limit: u64 = if playlist_end.is_some() { 128 << 20 } else if url.ends_with("/playlists") { 16 << 20 } else { 32 << 20 };
            let secs = if playlist_end.is_some() { 120 } else { 60 };
            let mut child = cmd.arg("--").arg(url).kill_on_drop(true).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::null())
                .spawn().map_err(|_| "spawn failed".to_string())?;
            let mut so = child.stdout.take().ok_or("spawn failed")?;
            let mut se = child.stderr.take().ok_or("spawn failed")?;
                                                                                                      
                                                                                                   
            let err_f = tokio::spawn(async move { let mut b = Vec::new(); let _ = (&mut se).take(4096).read_to_end(&mut b).await; let mut sink = tokio::io::sink(); let _ = tokio::io::copy(&mut se, &mut sink).await; b });
            let out_f = async { let mut b = Vec::new(); (&mut so).take(limit + 1).read_to_end(&mut b).await.map(|_| b) };
            let o = match tokio::time::timeout(std::time::Duration::from_secs(secs), out_f).await { Ok(x) => x, Err(_) => { let _ = child.kill().await; let _ = err_f.await; return Err("timed out".into()); } };
            let o = o.map_err(|_| "read failed".to_string())?;
            if o.len() as u64 > limit { let _ = child.kill().await; let _ = err_f.await; return Err("too big".into()); }
                                                                                               
            let st = match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await { Ok(x) => x.map_err(|_| "wait failed".to_string())?, Err(_) => { let _ = child.kill().await; let _ = err_f.await; return Err("timed out".into()); } };
            let e = err_f.await.unwrap_or_default();
            if !st.success() { return Err(String::from_utf8_lossy(&e).chars().take(400).collect()); }
            Jv::parse(&o)
        })
    }
    fn fetch<'b>(&'b self, url: &'b str, max: usize) -> BoxFuture<'b, Result<(u16, Vec<u8>, String), String>> {
        Box::pin(async move {
            let eg = self.0.egress()?;
            let r = eg.get(url).timeout(std::time::Duration::from_secs(8)).send().await.map_err(|_| "upstream error".to_string())?;
            let st = r.status().as_u16();
            let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            if r.content_length().map_or(false, |n| n > max as u64) { return Err("too big".into()); }
            let mut r = r; let mut b: Vec<u8> = Vec::new();
            while let Some(ch) = r.chunk().await.map_err(|_| "upstream error".to_string())? {
                if b.len() + ch.len() > max { return Err("too big".into()); }
                b.extend_from_slice(&ch);
            }
            Ok((st, b, ct))
        })
    }
}

                              
                                                                                            
pub struct OrdCache<V> { cap: usize, m: Vec<(String, V)> }
impl<V: Clone> OrdCache<V> {
    pub fn new(cap: usize) -> Self { Self { cap, m: vec![] } }
    pub fn get(&self, k: &str) -> Option<V> { self.m.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone()) }
    pub fn set(&mut self, k: &str, v: V) {
        if let Some(p) = self.m.iter_mut().find(|(kk, _)| kk == k) { p.1 = v; } else { self.m.push((k.to_string(), v)); }
        if self.m.len() > self.cap { self.m.remove(0); }
    }
}
const TTL: i64 = 30 * 60 * 1000;
pub struct Js {
    chan: Mutex<OrdCache<std::sync::Arc<ChanTab>>>,
    pl: Mutex<OrdCache<std::sync::Arc<PlPage>>>,
    chan_pl: Mutex<OrdCache<std::sync::Arc<ChanPlPage>>>,
    chan_info: Mutex<OrdCache<std::sync::Arc<ChanInfo>>>,
    avatar: Mutex<OrdCache<std::sync::Arc<(Vec<u8>, String)>>>,
    ok_mem: Mutex<HashMap<String, i64>>,
    blocked: Mutex<Option<HashMap<String, i64>>>,                                       
}
impl Js {
    pub fn new() -> Self {
        Self { chan: Mutex::new(OrdCache::new(60)), pl: Mutex::new(OrdCache::new(60)), chan_pl: Mutex::new(OrdCache::new(60)),
            chan_info: Mutex::new(OrdCache::new(100)), avatar: Mutex::new(OrdCache::new(300)), ok_mem: Mutex::new(HashMap::new()), blocked: Mutex::new(None) }
    }
    fn blocked_map(&self, d: &std::path::Path) -> Result<HashMap<String, i64>, ()> {
        let mut g = self.blocked.lock().map_err(|_| ())?;
        if g.is_none() {
            let f = d.join("jetstream-blocked.json");
            let m = match read_store(&f) {
                StoreRead::Missing => HashMap::new(), StoreRead::Corrupt => return Err(()),
                StoreRead::Ok(v) => v.as_object().unwrap().iter().filter_map(|(k, x)| x.as_f64().map(|n| (k.clone(), n as i64))).collect(),
            };
            *g = Some(m);
        }
        Ok(g.as_ref().unwrap().clone())
    }
                                                                         
    fn load_dead(&self, d: &std::path::Path) -> Result<std::collections::HashSet<String>, ()> {
        let f = d.join("jetstream-dead.json");
        let mut s: std::collections::HashSet<String> = match read_store(&f) {
            StoreRead::Missing => Default::default(), StoreRead::Corrupt => return Err(()),
            StoreRead::Ok(v) => v.get("ids").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        };
        if let Ok(g) = self.blocked.lock() { if let Some(m) = g.as_ref() { s.extend(m.keys().cloned()); } }
        Ok(s)
    }
                                                                                         
    async fn check_playable(&self, up: &dyn Up, d: &std::path::Path, id: &str, now: i64) -> Option<bool> {
        let bm = self.blocked_map(d).ok()?;
        if let Some(b) = bm.get(id) { if now - b < 30 * 86_400_000 { return Some(false); } }
        if let Some(t) = self.ok_mem.lock().ok()?.get(id) { if now - t < 12 * 3_600_000 { return Some(true); } }
        let j = up.innertube(false, "player", serde_json::json!({"videoId": id, "contentCheckOk": false, "racyCheckOk": false})).await.ok()?;
        let st = j.get("playabilityStatus").get("status");
        if !st.truthy() { return None; }
        let st = st.jstr();
        if st == "OK" || st == "LIVE_STREAM_OFFLINE" {
            let mut m = self.ok_mem.lock().ok()?;
            m.insert(id.to_string(), now);
            if m.len() > 20000 { if let Some(k) = m.iter().min_by_key(|(_, v)| **v).map(|(k, _)| k.clone()) { m.remove(&k); } }
            return Some(true);
        }
        if ["LOGIN_REQUIRED", "AGE_CHECK_REQUIRED", "CONTENT_CHECK_REQUIRED", "UNPLAYABLE", "ERROR"].contains(&st.as_str()) {
            let f = d.join("jetstream-blocked.json");
            let mx = store_mutex(&f); let _g = mx.lock().ok()?;
            let mut g = self.blocked.lock().ok()?;
            let m = g.as_mut()?;
            m.insert(id.to_string(), now);
            if m.len() > 5000 {                                                
                let mut ks: Vec<(String, i64)> = m.iter().map(|(k, v)| (k.clone(), *v)).collect();
                ks.sort_by_key(|(_, v)| *v);
                let drop = m.len() - 5000;
                for (k, _) in ks.into_iter().take(drop) { m.remove(&k); }
            }
            let obj: serde_json::Map<String, Value> = m.iter().map(|(k, v)| (k.clone(), serde_json::json!(*v))).collect();
            let _ = write_json(&f, &Value::Object(obj));                                                                                        
            return Some(false);
        }
        None
    }
    async fn check_many(&self, up: &dyn Up, d: &std::path::Path, ids: &[String], conc: usize, deadline_ms: u128, now: i64) -> HashMap<String, Option<bool>> {
        let out = Mutex::new(HashMap::new());
        let i = std::sync::atomic::AtomicUsize::new(0);
        let t0 = std::time::Instant::now();
        let worker = || async {
            loop {
                if t0.elapsed().as_millis() >= deadline_ms { break; }
                let k = i.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if k >= ids.len() { break; }
                let r = self.check_playable(up, d, &ids[k], now).await;
                out.lock().unwrap().insert(ids[k].clone(), r);
            }
        };
        futures::future::join_all((0..conc.min(ids.len())).map(|_| worker())).await;
        out.into_inner().unwrap()
    }

    async fn channel_tab(&self, up: &dyn Up, d: &std::path::Path, id: &str, tab: &str, clock: &super::jetstream_feedroutes::Clock) -> Result<std::sync::Arc<ChanTab>, String> {
        let key = format!("{id}:{tab}");
        if let Some(h) = self.chan.lock().unwrap().get(&key) { if clock() - h.at < TTL { return Ok(h); } }
        let url = if tab == "shorts" { format!("https://www.youtube.com/channel/{id}/shorts") } else { format!("https://www.youtube.com/playlist?list=UU{}", slice_from(id, 2)) };
        let data = up.ytdlp(&url, None).await?;
        if !data.truthy() || matches!(data, Jv::Null) { return Err("channel lookup came back empty".into()); }
        let shorts_ids: std::collections::HashSet<String> = if tab == "videos" {
            match Box::pin(self.channel_tab(up, d, id, "shorts", clock)).await { Ok(t) => t.items.iter().map(|v| v.id.clone()).collect(), Err(_) => Default::default() }
        } else { Default::default() };
        let dead = self.load_dead(d).map_err(|_| "store".to_string())?;
        let out = std::sync::Arc::new(build_chan_tab(&data, id, tab, &shorts_ids, &dead, clock()));
        self.chan.lock().unwrap().set(&key, out.clone());
        Ok(out)
    }
}
fn slice_from(s: &str, n: usize) -> String { s.chars().skip(n).collect() }

                               
type Q<'a> = &'a [(String, String)];
fn qget<'a>(q: Q<'a>, k: &str) -> Option<&'a str> { q.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.as_str()) }                                      
fn qtrim(q: Q, k: &str) -> String { js_trim(qget(q, k).unwrap_or("")).to_string() }
fn rows_raw(rows: &[String]) -> OJ { OJ::Raw(format!("[{}]", rows.join(","))) }
fn items_raw<T: Serialize>(rows: &[T]) -> OJ { OJ::Raw(serde_json::to_string(rows).unwrap()) }
                    
fn parse_int(s: &str) -> Option<i64> {
    let t = js_trim(s); let (neg, r) = match t.strip_prefix('-') { Some(r) => (true, r), None => (false, t.strip_prefix('+').unwrap_or(t)) };
    let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { return None; }
    let n: i64 = digits.parse().unwrap_or(i64::MAX);
    Some(if neg { -n } else { n })
}
fn err502(m: &str) -> Response { json_err(StatusCode::BAD_GATEWAY, m) }
fn bytes_resp(ct: &str, b: Vec<u8>) -> Response {
    use axum::response::IntoResponse;
    let mut r = (StatusCode::OK, b).into_response();
    let h = r.headers_mut();
    if let Ok(v) = ct.parse() { h.insert(axum::http::header::CONTENT_TYPE, v); }
    h.insert(axum::http::header::CACHE_CONTROL, "public, max-age=86400".parse().unwrap());
    r
}

pub fn owns(method: &str, sub: &str) -> bool {
    matches!((method, sub), ("GET", "/for-you" | "/shorts" | "/search" | "/suggest" | "/channel" | "/channel/info" | "/channel/playlists" | "/playlist" | "/subs/new" | "/avatar" | "/thumb"))
}

pub async fn handle_up(js: &Js, up: &dyn Up, d: &std::path::Path, user: &str, method: &str, sub: &str, q: Q<'_>, clock: &super::jetstream_feedroutes::Clock) -> Option<Response> {
    if !owns(method, sub) { return None; }
    Some(match sub {
        "/for-you" => { let (r, bg) = super::jetstream_feedroutes::for_you(up, d, user, qget(q, "offset").unwrap_or(""), clock).await; if bg { up.want_bg(BgKind::ForYou, user); } up.track(user, 8192); r }
        "/shorts" => { let (r, bg) = super::jetstream_feedroutes::shorts(up, d, user, qget(q, "q").unwrap_or(""), qget(q, "fresh") == Some("1"), clock).await; if bg { up.want_bg(BgKind::Shorts, user); } up.track(user, 8192); r }
        "/search" => search(up, user, q).await,
        "/suggest" => suggest(up, user, q, clock).await,
        "/subs/new" => {
            let subs = match user_subs(d, user) { Ok(s) => s, Err(r) => return Some(r) };
            let mine: Vec<_> = subs.into_iter().take(8).collect();
            if mine.is_empty() { return Some(json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", OJ::Arr(vec![]))])); }
            let seen = match user_hist_ids(d, user) { Ok(s) => s, Err(r) => return Some(r) };
            let mut out: Vec<ChanItem> = vec![];
            for sb in &mine {
                match js.channel_tab(up, d, &sb.id, "videos", clock).await {
                    Ok(t) => for v in t.items.iter().take(4) { if !seen.contains(&v.id) { let mut v = v.clone(); if v.channel.is_empty() { v.channel = sb.name.clone(); } out.push(v); } },
                    Err(e) if e == "store" => return Some(io_fail()),
                    Err(_) => {}
                }
            }
            out.truncate(12);
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("items", items_raw(&out))])
        }
        "/channel" => {
            let id = qtrim(q, "id");
            let tab = if qget(q, "tab") == Some("shorts") { "shorts" } else { "videos" };
            if !re(r"^[A-Za-z0-9_-]{2,64}$").is_match(&id) { return Some(json_err(StatusCode::BAD_REQUEST, "bad channel id")); }
            match js.channel_tab(up, d, &id, tab, clock).await {
                Ok(t) => { up.track(user, 4096);
                    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id)), ("name", OJ::Str(t.name.clone())), ("tab", OJ::Str(tab.into())), ("items", items_raw(&t.items))]) }
                Err(e) if e == "store" => io_fail(),
                Err(_) => err502("can't load this channel - try again"),
            }
        }
        "/channel/info" => {
            let id = qtrim(q, "id");
            if !re(r"^UC[A-Za-z0-9_-]{20,24}$").is_match(&id) { return Some(json_err(StatusCode::BAD_REQUEST, "bad channel id")); }
            let hit = js.chan_info.lock().unwrap().get(&id).filter(|h| clock() - h.at < TTL);
            let t = match hit { Some(h) => h, None => {
                match up.innertube(true, "browse", serde_json::json!({"browseId": id})).await {
                    Ok(j) => { let o = std::sync::Arc::new(build_chan_info(&j, &id, clock())); js.chan_info.lock().unwrap().set(&id, o.clone()); o }
                    Err(_) => return Some(err502("no channel info")),
                } } };
            up.track(user, 4096);
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("at", oj_num(t.at as f64)), ("id", OJ::Str(t.id.clone())), ("name", OJ::Str(t.name.clone())), ("desc", OJ::Str(t.desc.clone())),
                ("handle", OJ::Str(t.handle.clone())), ("subs", OJ::Str(t.subs.clone())), ("videos", OJ::Str(t.videos.clone())), ("banner", OJ::Str(t.banner.clone())),
                ("avatar", OJ::Str(t.avatar.clone())), ("country", OJ::Str(String::new()))])
        }
        "/channel/playlists" => {
            let id = qtrim(q, "id");
            if !re(r"^UC[A-Za-z0-9_-]{20,24}$").is_match(&id) { return Some(json_err(StatusCode::BAD_REQUEST, "bad channel id")); }
            let hit = js.chan_pl.lock().unwrap().get(&id).filter(|h| clock() - h.at < TTL);
            let t = match hit { Some(h) => h, None => {
                let url = format!("https://www.youtube.com/channel/{id}/playlists");
                let data = match up.ytdlp(&url, None).await {
                    Ok(x) => Some(x),
                                                                                                                
                    Err(e) if e.to_lowercase().contains("does not have a playlists tab") => None,
                    Err(_) => return Some(err502("can't load playlists - try again")),
                };
                let o = std::sync::Arc::new(match data { Some(x) => build_chan_playlists(&x, clock()), None => ChanPlPage { at: clock(), items: vec![] } });
                js.chan_pl.lock().unwrap().set(&id, o.clone()); o
            } };
            up.track(user, 4096);
            json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id)), ("items", items_raw(&t.items))])
        }
        "/playlist" => playlist(js, up, d, user, q, clock).await,
        "/avatar" => avatar(js, up, user, q).await,
        "/thumb" => thumb(up, d, user, q).await,
        _ => return None,
    })
}

                                                                                                
                                                                                                
                                                                                                 
fn suggest_payload(body: &[u8]) -> Option<&[u8]> {
    let mut b = body;
    while let Some((&c, rest)) = b.split_first() { if c.is_ascii_whitespace() { b = rest } else { break } }
    while let Some((&c, rest)) = b.split_last() { if c.is_ascii_whitespace() { b = rest } else { break } }
    if b.first() == Some(&b'[') { return Some(b) }
    const PRE: &[u8] = b"window.google.ac.h(";
    if b.starts_with(PRE) {
        let inner = &b[PRE.len()..];
        return inner.strip_suffix(b");").or_else(|| inner.strip_suffix(b")"));
    }
    None
}

                                                                                              
                                                                                            
                                                                                            
pub fn parse_suggest(data: &Jv) -> Option<Vec<String>> {
    let Jv::Arr(_) = data else { return None };
    if !matches!(data.at(0), Jv::Str(_)) { return None }                                      
    let Jv::Arr(entries) = data.at(1) else { return None };
    let mut out: Vec<String> = vec![];
    for e in entries {
        let Some(t) = e.at(0).s() else { continue };
        let t = js_trim(t);
        if t.is_empty() || out.iter().any(|x| x == t) { continue; }
        out.push(t.to_string());
        if out.len() >= 10 { break; }
    }
    Some(out)
}

                                                                                              
                                                                                              
                                                                                           
static SUGG_CACHE: std::sync::OnceLock<Mutex<OrdCache<(Vec<String>, i64)>>> = std::sync::OnceLock::new();
fn sugg_cache() -> &'static Mutex<OrdCache<(Vec<String>, i64)>> { SUGG_CACHE.get_or_init(|| Mutex::new(OrdCache::new(256))) }

                                                                                         
                                                                                            
                                                                                                  
async fn suggest(up: &dyn Up, user: &str, q: Q<'_>, clock: &super::jetstream_feedroutes::Clock) -> Response {
    let qq = qtrim(q, "q");
    if qq.is_empty() { return json_err(StatusCode::BAD_REQUEST, "search for something first"); }
    if super::js_len16(&qq) > 120 { return json_err(StatusCode::BAD_REQUEST, "keep searches under 120 characters"); }
    let key = qq.to_lowercase();
    if let Some((hit, _)) = sugg_cache().lock().unwrap().get(&key).filter(|(_, at)| (0..60_000).contains(&(clock() - *at))) {
        return json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("q", OJ::Str(qq)), ("suggestions", OJ::Arr(hit.iter().map(|s| OJ::Str(s.clone())).collect()))]);
    }
    let url = format!("https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=en&gl=US&q={}", crate::lite::urlenc(&qq));
    let (st, body, _ct) = match up.fetch(&url, 64 << 10).await { Ok(x) => x, Err(_) => return err502("can't load suggestions - try again") };
    if st != 200 { return err502("can't load suggestions - try again"); }
    let Some(payload) = suggest_payload(&body) else { return err502("can't load suggestions - try again") };
    let data = match Jv::parse(payload) { Ok(d) => d, Err(_) => return err502("can't load suggestions - try again") };
    let Some(out) = parse_suggest(&data) else { return err502("can't load suggestions - try again") };
    sugg_cache().lock().unwrap().set(&key, (out.clone(), clock()));
    up.track(user, 1024);
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("q", OJ::Str(qq)), ("suggestions", OJ::Arr(out.iter().map(|s| OJ::Str(s.clone())).collect()))])
}

async fn search(up: &dyn Up, user: &str, q: Q<'_>) -> Response {
    let qq = qtrim(q, "q");
    if qq.is_empty() { return json_err(StatusCode::BAD_REQUEST, "search for something first"); }
    if super::js_len16(&qq) > 120 { return json_err(StatusCode::BAD_REQUEST, "keep searches under 120 characters"); }
    let kind = qget(q, "type");
    let ok = |extra: Vec<(&str, OJ)>| { let mut v = vec![("ok", OJ::Bool(true)), ("q", OJ::Str(qq.clone()))]; v.extend(extra); json_ord(StatusCode::OK, v) };
    if kind == Some("channel") || kind == Some("playlist") {
        let k = kind.unwrap();
        return match up.innertube(true, "search", serde_json::json!({"query": qq, "params": if k == "channel" { "EgIQAg==" } else { "EgIQAw==" }})).await {
            Ok(data) => { up.track(user, 4096); ok(vec![("type", OJ::Str(k.into())), ("results", rows_raw(&parse_kind_search(&data, k)))]) }
            Err(_) => err502("search timed out - try again"),
        };
    }
    let tok = qtrim(q, "token");
    if !tok.is_empty() && !re(r"^[A-Za-z0-9_%=.-]{20,4000}$").is_match(&tok) { return json_err(StatusCode::BAD_REQUEST, "bad page token"); }
    let web = if !tok.is_empty() { up.innertube(true, "search", serde_json::json!({"continuation": tok})).await }
              else { up.innertube(true, "search", serde_json::json!({"query": qq, "params": "EgIQAQ=="})).await };
    if let Ok(data) = web {
        up.track(user, 4096);
        let results = parse_search(&data, 40);
        if !(results.is_empty() && tok.is_empty()) {
            return ok(vec![("results", items_raw(&results)), ("next", match search_token(&data) { Some(t) => OJ::Str(t), None => OJ::Null })]);
        }
    }
    if !tok.is_empty() { return err502("search timed out - try again"); }
    match up.innertube(false, "search", serde_json::json!({"query": qq})).await {
        Ok(data) => { up.track(user, 4096); ok(vec![("results", items_raw(&parse_search(&data, 20))), ("next", OJ::Null)]) }
        Err(_) => err502("search timed out - try again"),
    }
}

async fn playlist(js: &Js, up: &dyn Up, d: &std::path::Path, user: &str, q: Q<'_>, clock: &super::jetstream_feedroutes::Clock) -> Response {
    let id = qtrim(q, "id");
    if !re(r"^(PL|OL|UU|FL|LL)[A-Za-z0-9_-]{8,40}$").is_match(&id) { return json_err(StatusCode::BAD_REQUEST, "bad playlist id"); }
    let hit = js.pl.lock().unwrap().get(&id).filter(|h| clock() - h.at < TTL);
    let t = match hit { Some(h) => h, None => {
        let data = match up.ytdlp(&format!("https://www.youtube.com/playlist?list={id}"), Some(3000)).await { Ok(x) => x, Err(_) => return err502("can't load this playlist - it may be private or gone") };
        if matches!(data, Jv::Null) { return err502("can't load this playlist - it may be private or gone"); }
        let dead = match js.load_dead(d) { Ok(s) => s, Err(_) => return io_fail() };
        let o = std::sync::Arc::new(build_playlist(&data, &dead, clock()));
        js.pl.lock().unwrap().set(&id, o.clone()); o
    } };
    up.track(user, 4096);
    let mut list: Vec<PlItem> = t.items.clone();
    let qq: String = slice(&js_trim(qget(q, "q").unwrap_or("")).to_lowercase(), 100);
    if !qq.is_empty() { list.retain(|v| format!("{} {}", v.title, v.channel).to_lowercase().contains(&qq)); }
    if qget(q, "rev") == Some("1") { list.reverse(); }
    let bm = match js.blocked_map(d) { Ok(m) => m, Err(_) => return io_fail() };
    let now = clock();
    let is_blocked = |v: &PlItem| bm.get(&v.id).map(|t| now - t < 30 * 86_400_000).unwrap_or(false);
    let all = qget(q, "all") == Some("1");
    let off = parse_int(qget(q, "offset").unwrap_or("0")).filter(|n| *n != 0).unwrap_or(0).max(0) as usize;
    let lim = parse_int(qget(q, "limit").unwrap_or("50")).filter(|n| *n != 0).unwrap_or(50).clamp(1, 200) as usize;
    let mut items: Vec<PlItem> = vec![];
    let mut cur = if all { 0 } else { off };
    let target = if all { usize::MAX } else { lim };
    while cur < list.len() && items.len() < target {
        let take = if all { 400 } else { 8usize.max(target - items.len() + 4) };
        let batch = &list[cur..list.len().min(cur + take)];
        let ids: Vec<String> = batch.iter().filter(|v| !is_blocked(v)).map(|v| v.id.clone()).collect();
        let res = js.check_many(up, d, &ids, 8, if all { 20000 } else { 12000 }, now).await;
        let mut used = 0;
        for v in batch {
            if items.len() >= target { break; }
            used += 1;
            if is_blocked(v) || res.get(&v.id) == Some(&Some(false)) { continue; }
            items.push(v.clone());
        }
        cur += used;
    }
                                                                                        
    let bm2 = match js.blocked_map(d) { Ok(m) => m, Err(_) => return io_fail() };
    let blocked_known = list.iter().filter(|v| bm2.get(&v.id).map(|t| now - t < 30 * 86_400_000).unwrap_or(false)).count();
    let total = list.len() - blocked_known;
    up.track(user, 4096);
    let count = match &t.count { Jv::Num(n) => oj_num(*n), other => OJ::Str(other.jstr()) };
    json_ord(StatusCode::OK, vec![("ok", OJ::Bool(true)), ("id", OJ::Str(id)), ("name", OJ::Str(t.name.clone())), ("channel", OJ::Str(t.channel.clone())),
        ("channelId", OJ::Str(t.channel_id.clone())), ("count", count), ("total", OJ::U64(total as u64)), ("next", OJ::U64(cur as u64)),
        ("done", OJ::Bool(cur >= list.len())), ("hidden", OJ::U64(blocked_known as u64)), ("items", items_raw(&items))])
}

async fn avatar(js: &Js, up: &dyn Up, user: &str, q: Q<'_>) -> Response {
    let u = qtrim(q, "u");
    let host = url::Url::parse(&u).ok().and_then(|x| x.host_str().map(|h| h.to_string())).unwrap_or_default();
    if !u.starts_with("https://") || !(host == "yt3.ggpht.com" || host == "yt3.googleusercontent.com") { return json_err(StatusCode::BAD_REQUEST, "bad image"); }
    let cached = js.avatar.lock().unwrap().get(&u);
    let a = match cached { Some(a) => a, None => {
        match up.fetch(&u, 1_500_001).await {
            Ok((200..=299, b, ct)) if b.len() <= 1_500_000 => {
                let v = std::sync::Arc::new((b, if ct.is_empty() { "image/jpeg".to_string() } else { ct }));
                js.avatar.lock().unwrap().set(&u, v.clone()); v
            }
            _ => return err502("no image"),
        } } };
    up.track(user, a.0.len());
    bytes_resp(&a.1, a.0.clone())
}

                                                                                               
const THUMB_CAP: u64 = 50 * 1024 * 1024;
fn evict_thumbs(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = rd.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".jpg"))
        .filter_map(|e| e.metadata().ok().map(|m| (e.path(), m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)))).collect();
    files.sort_by_key(|f| f.2);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    for (p, sz, _) in files { if total <= THUMB_CAP { break; } if std::fs::remove_file(&p).is_ok() { total -= sz; } }
}
async fn thumb(up: &dyn Up, d: &std::path::Path, user: &str, q: Q<'_>) -> Response {
    let id = qtrim(q, "id");
    if !vid_ok(&id) { return json_err(StatusCode::BAD_REQUEST, "bad id"); }
    let lite = qget(q, "lite") == Some("1");
    let dir = d.join("thumb-cache");
    let tp = dir.join(format!("{id}{}.jpg", if lite { ".l" } else { "" }));
    if let Ok(b) = std::fs::read(&tp) {                             
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&tp) { let _ = f.set_modified(std::time::SystemTime::now()); }
        up.track(user, b.len());
        return bytes_resp("image/jpeg", b);
    }
    let names: &[&str] = if lite { &["hqdefault", "mqdefault"] } else { &["maxresdefault", "sddefault", "hqdefault", "mqdefault"] };
    let mut buf: Option<Vec<u8>> = None;
    for name in names {
        match up.fetch(&format!("https://i.ytimg.com/vi/{id}/{name}.jpg"), 8 << 20).await {
            Ok((200..=299, b, _)) => { if *name != "mqdefault" && b.len() < 6000 { continue; } buf = Some(b); break; }                                         
            _ => continue,
        }
    }
    let Some(b) = buf else { return err502("no thumb") };
    let _ = std::fs::create_dir(&dir);                                                      
    let tmp = dir.join(format!("{id}{}.jpg.part", if lite { ".l" } else { "" }));
    if std::fs::write(&tmp, &b).is_ok() { if std::fs::rename(&tmp, &tp).is_ok() { evict_thumbs(&dir); } else { let _ = std::fs::remove_file(&tmp); } }
    up.track(user, b.len());
    bytes_resp("image/jpeg", b)
}

                                                                                             
                                                                                                
                                                                                                   
                                                                                   
                                                                                               
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[derive(Deserialize, Default)]
    struct Fx {
        #[serde(default, deserialize_with = "some_jv")] json: Option<Jv>,
        #[serde(default)] status: Option<u16>,
        #[serde(default)] error: Option<String>,
        #[serde(default)] b64: Option<String>,
        #[serde(default)] rep: Option<(u8, usize)>,
        #[serde(default)] ct: Option<String>,
        #[serde(default)] throw: bool,
    }
    fn some_jv<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Jv>, D::Error> { Jv::deserialize(d).map(Some) }

    struct Mock { fx: HashMap<String, Fx>, calls: Mutex<Vec<String>> }
    impl Mock { fn log(&self, k: &str) { self.calls.lock().unwrap().push(k.to_string()); } }
    impl Up for Mock {
        fn innertube<'a>(&'a self, web: bool, endpoint: &'a str, body: Value) -> BoxFuture<'a, Result<Jv, String>> {
            Box::pin(async move {
                let k = format!("IT|{}|{}|{}", if web { "web" } else { "android" }, endpoint, serde_json::to_string(&body).unwrap());
                self.log(&k);
                match self.fx.get(&k) {
                    Some(f) if !f.throw && (200..300).contains(&f.status.unwrap_or(200)) => Ok(f.json.clone().unwrap()),
                    _ => Err("upstream".into()),
                }
            })
        }
        fn ytdlp<'a>(&'a self, url: &'a str, end: Option<u32>) -> BoxFuture<'a, Result<Jv, String>> {
            Box::pin(async move {
                let k = format!("YD|{}{}", url, end.map(|n| format!("|end={n}")).unwrap_or_default());
                self.log(&k);
                match self.fx.get(&k) { Some(Fx { error: Some(e), .. }) => Err(e.clone()), Some(f) => Ok(f.json.clone().unwrap()), None => Err("ERROR: no fixture".into()) }
            })
        }
        fn fetch<'a>(&'a self, url: &'a str, _max: usize) -> BoxFuture<'a, Result<(u16, Vec<u8>, String), String>> {
            Box::pin(async move {
                let k = format!("GET|{url}");
                self.log(&k);
                match self.fx.get(&k) {
                    Some(f) if !f.throw => {
                        let b = if let Some((byte, n)) = f.rep { vec![byte; n] } else { use base64::Engine; base64::engine::general_purpose::STANDARD.decode(f.b64.as_deref().unwrap_or("")).unwrap() };
                        Ok((f.status.unwrap_or(200), b, f.ct.clone().unwrap_or_default()))
                    }
                    _ => Err("upstream".into()),
                }
            })
        }
    }
    fn norm(v: &Value) -> Value {
        match v {
            Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
            Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
            x => x.clone(),
        }
    }

    #[test]
    fn upstream_routes_match_real_r32_on_fixtures() {
        let fx: HashMap<String, Fx> = serde_json::from_str(include_str!("jetstream_up_fixtures.json")).unwrap();
        let gold: Vec<Value> = serde_json::from_str(include_str!("jetstream_up_golden.json")).unwrap();
        assert!(gold.len() >= 79);
        let mock = Mock { fx, calls: Mutex::new(vec![]) };
        let d = std::env::temp_dir().join(format!("rjup-{}", super::super::hex_id(6).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        let js = Js::new();
        let stores = ["jetstream-history.json", "jetstream-subs.json", "jetstream-dead.json", "jetstream-blocked.json"];
        let mut binary = 0;
        for (i, g) in gold.iter().enumerate() {
            let st = &g["step"];
            let sub_full = st["sub"].as_str().unwrap();
            let now = st["now"].as_i64().unwrap();
            if let Some(setup) = st.get("setup") { for (f, v) in setup.as_object().unwrap() { std::fs::write(d.join(f), serde_json::to_string(v).unwrap()).unwrap(); } }
            let (path, qs) = sub_full.split_once('?').unwrap_or((sub_full, ""));
            let q: Vec<(String, String)> = url::form_urlencoded::parse(qs.as_bytes()).map(|(a, b)| (a.into_owned(), b.into_owned())).collect();
            mock.calls.lock().unwrap().clear();
            let clock: crate::apps::jetstream_feedroutes::Clock = std::sync::Arc::new(move || now);
            let r = futures::executor::block_on(handle_up(&js, &mock, &d, st["user"].as_str().unwrap(), st["method"].as_str().unwrap(), path, &q, &clock)).expect("owned route");
            let ctx = format!("step {i}: {sub_full}");
            assert_eq!(r.status().as_u16() as i64, g["status"].as_i64().unwrap(), "{ctx}");
            let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
            let cc = r.headers().get("cache-control").and_then(|v| v.to_str().ok()).map(String::from);
            let bytes = futures::executor::block_on(axum::body::to_bytes(r.into_body(), 1 << 24)).unwrap();
            if g["sha"].is_null() {
                assert_eq!(String::from_utf8(bytes.to_vec()).unwrap(), g["body"].as_str().unwrap(), "{ctx}");
            } else {
                binary += 1;
                let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(sha, g["sha"].as_str().unwrap(), "{ctx}");
                assert_eq!(bytes.len() as i64, g["len"].as_i64().unwrap(), "{ctx}");
                assert_eq!(ct, g["ct"].as_str().map(String::from), "{ctx} content-type");
                assert_eq!(cc, g["cc"].as_str().map(String::from), "{ctx} cache-control");
            }
            let mut calls = mock.calls.lock().unwrap().clone(); calls.sort();
            let want: Vec<String> = g["calls"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            assert_eq!(calls, want, "{ctx} upstream calls");
            for f in stores {
                let want = g["stores"].get(f);
                let got = std::fs::read_to_string(d.join(f)).ok().map(|s| serde_json::from_str::<Value>(&s).unwrap());
                assert_eq!(got.as_ref().map(norm), want.map(norm), "{ctx} store {f}");
            }
        }
        assert!(binary >= 10);
        std::fs::remove_dir_all(&d).ok();
    }

    #[cfg(test)]
    fn sugg_cache_reset() { *sugg_cache().lock().unwrap() = OrdCache::new(256); }

    fn sugg_fx(body: &[u8], q: &str) -> Mock {
        let b64 = { use base64::Engine; base64::engine::general_purpose::STANDARD.encode(body) };
        let url = format!("https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=en&gl=US&q={}", crate::lite::urlenc(q));
        let mut fx = HashMap::new();
        fx.insert(format!("GET|{url}"), Fx { b64: Some(b64), ..Default::default() });
        Mock { fx, calls: Mutex::new(vec![]) }
    }

    #[test]
    fn suggest_payload_plain_exact_wrapper_only() {
        assert_eq!(suggest_payload(br#"["a",[]]"#), Some(&br#"["a",[]]"#[..]));
        assert_eq!(suggest_payload(br#"window.google.ac.h(["a",[]])"#), Some(&br#"["a",[]]"#[..]));
        assert_eq!(suggest_payload(br#"window.google.ac.h(["a",[]]);"#), Some(&br#"["a",[]]"#[..]));
        assert_eq!(suggest_payload(b"  window.google.ac.h([\"a\",[]])  "), Some(&br#"["a",[]]"#[..]));
        assert_eq!(suggest_payload(br#"foo(["a",[]])"#), None, "arbitrary prefix rejected");
        assert_eq!(suggest_payload(br#"window.google.ac.h(["a",[]]) trailing"#), None);
        assert_eq!(suggest_payload(b""), None);
    }

    #[test]
    fn parse_suggest_envelope_validation() {
        let d = Jv::parse(br#"["a",[["alpha",0],["beta",0],["beta",0],["  ",0],[42],null,["gamma",0]]]"#).unwrap();
        assert_eq!(parse_suggest(&d).unwrap(), vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()], "entry[0] text only, trimmed, deduped");
        assert_eq!(parse_suggest(&Jv::parse(br#"["q",[]]"#).unwrap()), Some(vec![]), "valid empty envelope is Some([]), not an error");
        assert!(parse_suggest(&Jv::parse(br#"{"not":"the shape"}"#).unwrap()).is_none(), "non-array envelope malformed");
        assert!(parse_suggest(&Jv::parse(br#"["q"]"#).unwrap()).is_none(), "missing suggestions slot malformed");
        assert!(parse_suggest(&Jv::parse(br#"["q","notarray"]"#).unwrap()).is_none(), "non-array suggestions slot malformed");
        assert!(parse_suggest(&Jv::parse(br#"[0,[]]"#).unwrap()).is_none(), "slot 0 must be the query string");
        assert!(parse_suggest(&Jv::parse(br#"[null,[]]"#).unwrap()).is_none(), "slot 0 must be a string");
        let many = serde_json::json!(["q", (0..15).map(|i| serde_json::json!([format!("s{i}"), 0])).collect::<Vec<_>>()]);
        assert_eq!(parse_suggest(&Jv::parse(&serde_json::to_vec(&many).unwrap()).unwrap()).unwrap().len(), 10, "cap 10");
    }

    #[tokio::test]
    async fn suggest_route_happy_cache_expiry_and_failures() {
        sugg_cache_reset();
        let now = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(1_000_000));
        let clock: crate::apps::jetstream_feedroutes::Clock = {
            let n = now.clone();
            std::sync::Arc::new(move || n.load(std::sync::atomic::Ordering::Relaxed))
        };
        let d = std::env::temp_dir().join(format!("rjsug-{}", super::super::hex_id(6).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        let js = Js::new();
                                                                                                   
                                                       
        let live: &[u8] = br##"window.google.ac.h(["how to",[["how to draw",0,[512,433]],["how to cook",0,[512]],["how to draw",0,[512,433]],["",0],[123],["how to tie a tie",0,[512,433,131],{"zae":"/m/123"}]],{"k":1}])"##;
        let mock = sugg_fx(live, "how to");
        let q: Vec<(String, String)> = vec![("q".into(), "how to".into())];
        let r = handle_up(&js, &mock, &d, "u", "GET", "/suggest", &q, &clock).await.expect("owned route");
        assert_eq!(r.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        assert_eq!(String::from_utf8(bytes.to_vec()).unwrap(), r#"{"ok":true,"q":"how to","suggestions":["how to draw","how to cook","how to tie a tie"]}"#, "exact body, fixed key order");
        assert_eq!(mock.calls.lock().unwrap().len(), 1, "one upstream GET");
                                               
        let r2 = handle_up(&js, &mock, &d, "u", "GET", "/suggest", &q, &clock).await.expect("owned route");
        assert_eq!(r2.status(), StatusCode::OK);
        assert_eq!(mock.calls.lock().unwrap().len(), 1, "cache hit must not refetch");
                                
        now.store(1_000_000 + 61_000, std::sync::atomic::Ordering::Relaxed);
        let r3 = handle_up(&js, &mock, &d, "u", "GET", "/suggest", &q, &clock).await.expect("owned route");
        assert_eq!(r3.status(), StatusCode::OK);
        assert_eq!(mock.calls.lock().unwrap().len(), 2, "expired entry refetches");
                                                                             
        now.store(1_000_000, std::sync::atomic::Ordering::Relaxed);
        let r3b = handle_up(&js, &mock, &d, "u", "GET", "/suggest", &q, &clock).await.expect("owned route");
        assert_eq!(r3b.status(), StatusCode::OK);
        assert_eq!(mock.calls.lock().unwrap().len(), 3, "negative age must not hit the cache");
        now.store(1_122_000, std::sync::atomic::Ordering::Relaxed);
                                                                               
        let mock2 = sugg_fx(b"this is not the payload", "zzuniq-a");
        let q2: Vec<(String, String)> = vec![("q".into(), "zzuniq-a".into())];
        let r4 = handle_up(&js, &mock2, &d, "u", "GET", "/suggest", &q2, &clock).await.expect("owned route");
        assert_eq!(r4.status(), StatusCode::BAD_GATEWAY);
        let r5 = handle_up(&js, &mock2, &d, "u", "GET", "/suggest", &q2, &clock).await.expect("owned route");
        assert_eq!(r5.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(mock2.calls.lock().unwrap().len(), 2, "malformed must not be cached as an empty 200");
                                                
        let mock3 = sugg_fx(br##"window.google.ac.h({"q":1})"##, "zzuniq-b");
        let q3: Vec<(String, String)> = vec![("q".into(), "zzuniq-b".into())];
        let r6 = handle_up(&js, &mock3, &d, "u", "GET", "/suggest", &q3, &clock).await.expect("owned route");
        assert_eq!(r6.status(), StatusCode::BAD_GATEWAY, "malformed envelope");
                                                              
        let mock4 = sugg_fx(br##"window.google.ac.h(["zzuniq-c", []])"##, "zzuniq-c");
        let q4: Vec<(String, String)> = vec![("q".into(), "zzuniq-c".into())];
        let r7 = handle_up(&js, &mock4, &d, "u", "GET", "/suggest", &q4, &clock).await.expect("owned route");
        assert_eq!(r7.status(), StatusCode::OK, "valid empty envelope is a 200, not a 502");
                
        let q5: Vec<(String, String)> = vec![];
        let r8 = handle_up(&js, &mock4, &d, "u", "GET", "/suggest", &q5, &clock).await.expect("owned route");
        assert_eq!(r8.status(), StatusCode::BAD_REQUEST, "empty q");
        let q6: Vec<(String, String)> = vec![("q".into(), "x".repeat(121))];
        let r9 = handle_up(&js, &mock4, &d, "u", "GET", "/suggest", &q6, &clock).await.expect("owned route");
        assert_eq!(r9.status(), StatusCode::BAD_REQUEST, "over 120 chars");
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod r13_lane_tests {
    use super::*;

                                                                                                 
                                           
                                                                                                 
                                                                                                 
                                                                                                 
    async fn take2(sem: &'static tokio::sync::Semaphore) -> (tokio::sync::SemaphorePermit<'static>, tokio::sync::SemaphorePermit<'static>) {
        for _ in 0..200 {
            if let Ok(a) = sem.try_acquire() {
                if let Ok(b) = sem.try_acquire() { return (a, b); }
                drop(a);
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("could not reserve 2 permits within 5s - a sibling test is wedged");
    }
    #[tokio::test]
    async fn ytdlp_lanes_cannot_starve_each_other() {
        let (_m1, _m2) = take2(&YTDLP_LANE_MEDIA).await;
        assert!(YTDLP_LANE_MEDIA.try_acquire().is_err(), "media lane is full at its reservation");
        let (_g1, _g2) = take2(&YTDLP_SLOTS).await;
        let (_g, _l) = ytdlp_take(&YTDLP_LANE_AMP).await.expect("amp lane still runs while the media lane is full");
        assert!(YTDLP_LANE_DATA.try_acquire().is_ok(), "data lane unaffected");
    }
}
