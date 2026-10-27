                                                                                
                                                                                         
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use futures::StreamExt;
use scraper::{Html, Selector};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use super::{json_err_x, json_ord, qparam, urlenc, OJ, Shared};

const MAX_HTML: usize = 4_000_000;

const DROP: &[&str] = &["script", "style", "nav", "header", "footer", "aside", "form", "iframe", "noscript", "svg", "button", "select", "input", "textarea", "dialog", "template", "canvas"];

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn abs(base: &str, s: &str) -> String {
    if s.is_empty() { return String::new(); }
    url::Url::parse(base).ok().and_then(|b| b.join(s).ok())
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.to_string()).unwrap_or_default()
}

fn tx(el: &scraper::ElementRef) -> String {
    el.text().collect::<Vec<_>>().join("").split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone)]
struct Block { t: String, x: String, i: usize }

struct PageData {
    title: String, url: String, text: String,
    links: Vec<(String, String)>, images: Vec<String>, videos: Vec<String>,
    blocks: Vec<Block>, imgs: Vec<(String, String)>,
}

async fn page_data(st: &crate::AppState, u: &str) -> Result<PageData, String> {
    let permit=crate::searx_reader::slots().clone().try_acquire_owned().map_err(|_|"page busy".to_string())?;
    let (resp, final_url) = super::ssrf::safe_get(st, u, "text/html,application/xhtml+xml").await?;
    if resp.status().as_u16() != 200 { return Err(format!("the site answered {}", resp.status())); }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !ct.to_lowercase().contains("html") { return Err("not a web page".into()); }
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(c) = stream.next().await {
        let c = c.map_err(|e| if e.is_timeout() { "timed out".to_string() } else { "upstream error".to_string() })?;
        if buf.len() + c.len() > MAX_HTML { return Err("page too large".into()); }
        buf.extend_from_slice(&c);
    }
    if !crate::apps::browse_render::memory_ok(&st.data_dir){return Err("page busy".into())}
    tokio::task::spawn_blocking(move||{let _permit=permit;parse_page(&String::from_utf8_lossy(&buf),&final_url.to_string())}).await.map_err(|_|"page failed".to_string())?
}
                                                                                
                                                                                   
const PAGE_MAX_TOKENS:usize=20000;
fn parser_work_exceeds(html:&str)->bool{
    crate::searx_reader::too_deep(html,1500)||html.as_bytes().iter().filter(|b|**b==b'<').take(PAGE_MAX_TOKENS+1).count()>PAGE_MAX_TOKENS
}
fn parse_page(html:&str,final_url:&str)->Result<PageData,String>{
    if parser_work_exceeds(html){return Err("page too large".into())}
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);
    let doc = Html::parse_document(html);
    if std::time::Instant::now()>=deadline{return Err("timed out".into())}
    if doc.tree.root().descendants().count()>50000{return Err("page too large".into())}
    let base = final_url.to_string();
    let title = Selector::parse("title").ok().and_then(|s| doc.select(&s).next()).map(|el| tx(&el)).unwrap_or_default();
    let title: String = title.chars().take(300).collect();
                                                                  
    let mut vids: Vec<String> = vec![];
    let mut vset: HashSet<String> = HashSet::new();
    for sel_s in ["video", "video source"] {
        if let Ok(sel) = Selector::parse(sel_s) {
            for e in doc.select(&sel) {
                let s = abs(&base, e.value().attr("src").unwrap_or(""));
                if !s.is_empty() && vset.insert(s.clone()) { vids.push(s); }
            }
        }
    }
    if let Ok(sel) = Selector::parse("meta") {
        for e in doc.select(&sel) {
            let p = e.value().attr("property").unwrap_or("");
            if p.contains("og:video") {
                let s = abs(&base, e.value().attr("content").unwrap_or(""));
                if !s.is_empty() && vset.insert(s.clone()) { vids.push(s); }
            }
        }
    }
    let yt_re = regex_lite_yt();
    if let Ok(sel) = Selector::parse("iframe") {
        for e in doc.select(&sel) {
            if let Some(m) = yt_re.captures(e.value().attr("src").unwrap_or("")) {
                let s = format!("https://www.youtube.com/watch?v={}", &m[1]);
                if vset.insert(s.clone()) { vids.push(s); }
            }
        }
    }
                    
    let mut imgs: Vec<(String, String)> = vec![];
    let mut seen_img: HashSet<String> = HashSet::new();
    if let Ok(sel) = Selector::parse("meta") {
        for e in doc.select(&sel) {
            if e.value().attr("property") == Some("og:image") {
                let s = abs(&base, e.value().attr("content").unwrap_or(""));
                if !s.is_empty() && seen_img.insert(s.clone()) { imgs.push((s, String::new())); }
            }
        }
    }
                                           
    let mut out: Vec<Block> = vec![];
    let mut links: Vec<(String, String)> = vec![];
    let mut pcount = 0usize;
    fn walk(el: scraper::ElementRef, base: &str, out: &mut Vec<Block>, links: &mut Vec<(String, String)>, imgs: &mut Vec<(String, String)>, seen_img: &mut HashSet<String>, pcount: &mut usize,deadline:std::time::Instant) {
        let mut stack=vec![el];
        while let Some(el)=stack.pop(){
        if std::time::Instant::now()>=deadline{break}
        let tag = el.value().name();
        if DROP.contains(&tag) { continue; }
        if tag == "img" {
            let v = el.value();
            let raw = v.attr("src").or_else(|| v.attr("data-src"))
                .or_else(|| v.attr("srcset").and_then(|s| s.split(',').next()).and_then(|s| s.split_whitespace().next()))
                .unwrap_or("");
            let s = abs(base, raw);
            let w: u32 = v.attr("width").and_then(|x| x.parse().ok()).unwrap_or(0);
            let h: u32 = v.attr("height").and_then(|x| x.parse().ok()).unwrap_or(0);
            if !s.is_empty() && !seen_img.contains(&s) && !(w > 0 && w < 80) && !(h > 0 && h < 60) && imgs.len() < 40 {
                seen_img.insert(s.clone());
                imgs.push((s, v.attr("alt").unwrap_or("").chars().take(200).collect()));
                out.push(Block { t: "img".into(), x: String::new(), i: imgs.len() - 1 });
            }
            continue;
        }
        if tag == "a" {
            let h = abs(base, el.value().attr("href").unwrap_or(""));
            let t: String = tx(&el).chars().take(160).collect();
            if !h.is_empty() && !t.is_empty() && links.len() < 100 { links.push((t, h)); }
        }
        if matches!(tag, "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "blockquote" | "pre" | "figcaption") {
            let t = tx(&el);
            if !t.is_empty() && *pcount < 30000 {
                *pcount += t.len();
                let bt = if tag.starts_with('h') && tag.len() == 2 { "h" } else if tag == "li" { "li" } else { "p" };
                out.push(Block { t: bt.into(), x: t.chars().take(2000).collect(), i: 0 });
            }
                                                                
            for c in el.children().rev() {
                if let Some(ce) = scraper::ElementRef::wrap(c) {
                    if ce.value().name() == "img" || ce.value().name() == "a" { stack.push(ce); }
                }
            }
            continue;
        }
        for c in el.children().rev() {
            if let Some(ce) = scraper::ElementRef::wrap(c) { stack.push(ce); }
        }
        }
    }
    if let Ok(sel) = Selector::parse("body") {
        for root in doc.select(&sel) { walk(root, &base, &mut out, &mut links, &mut imgs, &mut seen_img, &mut pcount,deadline); }
    }
    if std::time::Instant::now()>=deadline{return Err("timed out".into())}
    let text = out.iter().filter(|x| x.t != "img")
        .map(|x| if x.t == "h" { format!("\n{}\n", x.x) } else if x.t == "li" { format!("- {}", x.x) } else { x.x.clone() })
        .collect::<Vec<_>>().join("\n");
    let mut clean = String::with_capacity(text.len());
    let mut run = 0;
    for c in text.chars() { if c == '\n' { run += 1; if run > 2 { continue; } } else { run = 0; } clean.push(c); }
    let text: String = clean.trim().chars().take(60000).collect();
    Ok(PageData {
        title, url: base, text, links,
        images: imgs.iter().map(|(u, _)| u.clone()).collect(),
        videos: vids.into_iter().take(10).collect(),
        blocks: out, imgs,
    })
}

fn regex_lite_yt() -> regex::Regex {
    regex::Regex::new(r"youtube(?:-nocookie)?\.com/embed/([\w-]{11})").unwrap()
}

fn media_url(u: &str, kind: &str) -> String {
    format!("/api/lite/media?kind={kind}&u={}", urlenc(u))
}

fn page_html(d: &PageData) -> String {
    let b: Vec<String> = d.blocks.iter().map(|x| {
        if x.t == "img" {
            let im = &d.imgs[x.i];
            format!("<p><img src=\"{}\" alt=\"{}\" style=\"max-width:100%\"></p>", esc(&media_url(&im.0, "image")), esc(&im.1))
        } else if x.t == "h" { format!("<h2>{}</h2>", esc(&x.x)) }
        else if x.t == "li" { format!("<li>{}</li>", esc(&x.x)) }
        else { format!("<p>{}</p>", esc(&x.x)) }
    }).collect();
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font:17px/1.6 -apple-system,system-ui,sans-serif;margin:16px;max-width:680px}}</style></head><body><h1>{}</h1>{}<hr><p><small>{}</small></p></body></html>",
        esc(&d.title), esc(&d.title), b.join("\n"), esc(&d.url))
}

pub async fn handler(State((st, _)): State<Shared>, Query(params): Query<HashMap<String, String>>) -> Response {
    let u = qparam(&params, "u");
    if let Err(e) = super::ssrf::check_url(&u) { return json_err_x(StatusCode::BAD_REQUEST, json!({"error": e})); }
    let d = match tokio::time::timeout(std::time::Duration::from_secs(15),page_data(&st,&u)).await.unwrap_or_else(|_|Err("timed out".into())) {
        Ok(d) => d,
        Err(e) => return json_err_x(StatusCode::BAD_GATEWAY, json!({"error": e.chars().take(160).collect::<String>()})),
    };
    if qparam(&params, "format") == "html" {
        let h = page_html(&d);
        return Response::builder()
            .header(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(axum::http::header::CONTENT_LENGTH, h.len())
            .header(axum::http::header::CACHE_CONTROL, "no-store")
            .header("content-security-policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
            .body(axum::body::Body::from(h))
            .unwrap();
    }
                                                                                
                                                                                    
    json_ord(StatusCode::OK, vec![
        ("ok", OJ::Bool(true)),
        ("title", OJ::Str(d.title)),
        ("url", OJ::Str(d.url)),
        ("text", OJ::Str(d.text)),
        ("links", OJ::Arr(d.links.iter().map(|(t, u)| OJ::Obj(vec![("text".into(), OJ::Str(t.clone())), ("url".into(), OJ::Str(u.clone()))])).collect())),
        ("images", OJ::Arr(d.images.iter().map(|x| OJ::Str(media_url(x, "image"))).collect())),
        ("videos", OJ::Arr(d.videos.iter().map(|v| OJ::Str(v.clone())).collect())),
    ])
}

#[cfg(test)]mod hardening_tests{use super::*;
 #[test]fn huge_depth_rejected_before_parse(){let h="<div>".repeat(20000);assert!(parse_page(&h,"https://example.com").is_err());}
 #[test]fn shallow_3000_tag_lite_fallback_is_rejected(){let h=format!("<body>{}</body>","<div>article</div>".repeat(3000));assert!(parse_page(&h,"https://example.com").is_err());}
                                                                               
                                                                              
 fn adversarial(h:String){let start=std::time::Instant::now();let job=std::thread::Builder::new().stack_size(2*1024*1024).spawn(move||parse_page(&h,"https://example.com").is_err()).unwrap();assert!(job.join().unwrap());assert!(start.elapsed()<std::time::Duration::from_secs(10));}
 #[test]fn adversarial_nested_10000_divs(){adversarial(format!("{}text{}","<div>".repeat(10000),"</div>".repeat(10000)));}
 #[test]fn adversarial_nested_tables(){adversarial(format!("{}text{}","<table><tr><td>".repeat(3000),"</td></tr></table>".repeat(3000)));}
 #[test]fn adversarial_deep_misnested_formatting(){adversarial(format!("{}text{}","<b><i>".repeat(4000),"</b></i>".repeat(4000)));}
 #[test]fn adversarial_void_bomb(){adversarial("<br>".repeat(999999));}
 #[test]fn cumulative_boundary_cannot_be_reset(){assert!(!parser_work_exceeds(&"<div>x</div>".repeat(1500)));assert!(parser_work_exceeds(&"<div>x</div>".repeat(1501)));assert!(parser_work_exceeds(&"<div/>".repeat(1501)));}
 #[test]fn quoted_attribute_fake_close_cannot_reset_work(){adversarial("<div title='</div>'>".repeat(1501));}
 #[test]fn commented_fake_close_cannot_reset_work(){adversarial("<div><!-- </div> -->".repeat(1501));}
 #[test]fn iterative_walk_preserves_order(){let d=parse_page("<html><body><div><p>first</p><p>second <a href='/a'>link</a></p><img src='/i.png'></div></body></html>","https://example.com").unwrap();assert!(d.text.find("first").unwrap()<d.text.find("second").unwrap());assert_eq!(d.links[0].1,"https://example.com/a");assert_eq!(d.images[0],"https://example.com/i.png");}
}
