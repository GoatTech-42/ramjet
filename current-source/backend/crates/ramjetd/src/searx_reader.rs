                                                                                            
                                                                               
                                                                                 
use scraper::{Html, Selector, ElementRef};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use crate::lite::ssrf;
use crate::AppState;

const MAX: usize = 4_000_000;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure { Blocked, Unavailable, Load, Redirects, Status(u16), NotHtml, TooLarge, Extraction, Unknown }
impl Failure {
    fn copy(self) -> &'static str { match self {
        Self::Blocked => "this address can't open in reader.", Self::Unavailable => "reader isn't available right now.",
        Self::Load => "this page couldn't load.", Self::Redirects => "this page couldn't open in reader.",
        Self::Status(429) => "slow down a bit.", Self::Status(403) => "this device can't do that",
        Self::Status(408 | 500 | 502 | 504) => "this page couldn't load.", Self::Status(_) => "this page isn't available right now.",
        Self::NotHtml => "this file can't open in reader.", Self::TooLarge => "this page is too large for reader.",
        Self::Extraction => "no article text found.", Self::Unknown => "this page couldn't open in reader.",
    }}
    fn retry(self) -> bool { matches!(self, Self::Load | Self::Status(408 | 500 | 502 | 504)) }
}

async fn fetch_page(st: &AppState, target: &str, deadline: Instant) -> Result<(String, String), Failure> {
    let mut t = ssrf::check_url(target).map_err(|_| Failure::Blocked)?;
    for hops in 0..=4 {
        let host = t.host_str().ok_or(Failure::Blocked)?;
                                                                                       
                                                                                       
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), ssrf::pin(host)).await.map_err(|_| Failure::Load)?.map_err(|_| Failure::Blocked)?;
        let eg = st.egress_client.as_ref().ok_or(Failure::Unavailable)?;
        let response = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), eg.get(t.as_str())
            .header("accept", "text/html,application/xhtml+xml").header("accept-encoding", "gzip, br")
            .header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
            .timeout(Duration::from_secs(12)).send()).await.map_err(|_| Failure::Load)?.map_err(|e| if e.is_timeout() || e.is_connect() { Failure::Load } else { Failure::Unknown })?;
        if response.status().is_redirection() {
            if hops == 4 { return Err(Failure::Redirects); }
            let loc = response.headers().get("location").and_then(|v| v.to_str().ok()).ok_or(Failure::Redirects)?;
            let next = t.join(loc).map_err(|_| Failure::Blocked)?;
            t = ssrf::check_url(next.as_str()).map_err(|_| Failure::Blocked)?;
            continue;
        }
        if response.status() != reqwest::StatusCode::OK { return Err(Failure::Status(response.status().as_u16())); }
        let ct = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !ct.to_ascii_lowercase().contains("html") { return Err(Failure::NotHtml); }
        let mut response = response; let mut bytes = Vec::new();
        loop {
            let chunk = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), response.chunk()).await.map_err(|_| Failure::Load)?.map_err(|_| Failure::Load)?;
            let Some(chunk) = chunk else { break; };
            if chunk.len() > MAX - bytes.len() { return Err(Failure::TooLarge); }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((String::from_utf8_lossy(&bytes).into_owned(), t.to_string()));
    }
    Err(Failure::Redirects)
}

const DROP: &[&str] = &["script", "style", "nav", "header", "footer", "aside", "form", "iframe", "noscript", "svg", "button", "select", "input", "textarea", "dialog", "template", "canvas", "video", "audio", "object", "embed"];
const ALLOW: &[&str] = &["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "strong", "b", "em", "i", "br", "hr", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td", "img", "a", "sup", "sub"];

fn junk_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)(comment|sidebar|footer|promo|advert|(^|[\s_-])ad([\s_-]|$)|sponsor|share|social|newsletter|subscribe|related|recommend|cookie|popup|modal|breadcrumb|menu|toolbar|byline-extra|navbox|infobox|reflist|mw-editsection|hatnote|metadata|(^|[\s_-])toc([\s_-]|$)|catlinks|printfooter)").unwrap())
}

fn text_of(el: &ElementRef) -> String {
    let mut s = String::new();
    for t in el.text() { s.push_str(t); }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_dropped(el: &ElementRef) -> bool {
    let nm = el.value().name();
    if DROP.contains(&nm) { return true; }
    if !["html", "body", "article", "main"].contains(&nm) {
        let cls = el.value().attr("class").unwrap_or("");
        let id = el.value().attr("id").unwrap_or("");
        if junk_re().is_match(&format!("{} {}", cls, id)) { return true; }
    }
    if el.value().attr("hidden").is_some() { return true; }
    if el.value().attr("aria-hidden") == Some("true") { return true; }
    false
}

                                                                                                   
                                                                                                   
#[derive(Clone, Copy)]
struct Seg { words: usize, bytes: usize, sw: bool, ew: bool, empty: bool }
impl Seg {
    const EMPTY: Seg = Seg { words: 0, bytes: 0, sw: false, ew: false, empty: true };
    fn of(s: &str) -> Seg {
        if s.is_empty() { return Seg::EMPTY; }
        let (mut words, mut bytes) = (0usize, 0usize);
        for w in s.split_whitespace() { words += 1; bytes += w.len(); }
        Seg { words, bytes, sw: s.chars().next().map_or(false, char::is_whitespace), ew: s.chars().next_back().map_or(false, char::is_whitespace), empty: false }
    }
    fn join(self, o: Seg) -> Seg {
        if self.empty { return o; }
        if o.empty { return self; }
        let merge = !self.ew && !o.sw;                                                         
        Seg { words: self.words + o.words - merge as usize, bytes: self.bytes + o.bytes, sw: self.sw, ew: o.ew, empty: false }
    }
    fn norm_len(self) -> usize { self.bytes + self.words.saturating_sub(1) }
}
#[derive(Clone, Copy)]
struct Agg { seg: Seg, p: u64, links: usize }

const CANDIDATES: &[&str] = &["article", "main", "div", "section", "td", "body", "font"];

                                                                                                         
struct Budget { deadline: Instant, n: u32 }
impl Budget {
    fn new(deadline: Instant) -> Self { Budget { deadline, n: 0 } }
    fn over(&mut self) -> bool { self.n = self.n.wrapping_add(1); (self.n == 1 || self.n % 2048 == 0) && Instant::now() >= self.deadline }
}

                                                                                                                
fn score_all(doc: &Html, bud: &mut Budget) -> Result<Vec<(ego_tree::NodeId, f64)>, ()> {
    let order: Vec<_> = doc.tree.root().descendants().collect();                          
    let mut agg: HashMap<ego_tree::NodeId, Agg> = HashMap::with_capacity(order.len() / 2 + 1);
    for n in order.iter().rev() {                                                                            
        if bud.over() { return Err(()); }
        if !n.value().is_element() && n.parent().is_some() { continue; }
        let mut a = Agg { seg: Seg::EMPTY, p: 0, links: 0 };
        for ch in n.children() {
            match ch.value() {
                scraper::node::Node::Text(t) => a.seg = a.seg.join(Seg::of(&t.text)),
                scraper::node::Node::Element(e) => {
                    if let Some(c) = agg.get(&ch.id()) {
                        a.seg = a.seg.join(c.seg);
                        a.p += c.p; a.links += c.links;
                        let l = c.seg.norm_len();
                        if e.name() == "p" && l > 60 { a.p += l.min(400) as u64; }
                        if e.name() == "a" { a.links += l; }
                    }
                }
                _ => {}
            }
        }
        agg.insert(n.id(), a);
    }
    let mut scores = Vec::new();
                                                                                                                                
                                                                                                                             
                                                                                                          
    for n in doc.tree.nodes() {
        if bud.over() { return Err(()); }
        let Some(e) = n.value().as_element() else { continue };
        let name = e.name();
        if !CANDIDATES.contains(&name) { continue; }
        let Some(a) = agg.get(&n.id()) else { continue };
        let mut score = a.p as f64;
        for node in n.children() {
            if let Some(t) = node.value().as_text() {
                let l = Seg::of(&t.text).norm_len();
                if l > 80 { score += l.min(1500) as f64; }
            }
        }
        let all = a.seg.norm_len().max(1) as f64;
        score *= 1.0 - (a.links as f64 / all).min(0.9);
        if name == "article" { score *= 1.3; }
        scores.push((n.id(), score));
    }
    Ok(scores)
}
fn pick_main(doc: &Html, bud: &mut Budget) -> Result<Option<ego_tree::NodeId>, ()> {
    let (mut best, mut best_score) = (None, 0.0f64);
    for (id, score) in score_all(doc, bud)? { if score > best_score { best_score = score; best = Some(id); } }
    Ok(best)
}

enum Work<'a> { Node(ego_tree::NodeRef<'a, scraper::node::Node>), Raw(&'static str) }

fn push_children<'a>(stack: &mut Vec<Work<'a>>, n: ego_tree::NodeRef<'a, scraper::node::Node>) {
    let kids: Vec<_> = n.children().collect();
    for k in kids.into_iter().rev() { stack.push(Work::Node(k)); }
}

                                                                                                                
fn render(el: &ElementRef, base: &url::Url, out: &mut String, imgs: &mut u32, bud: &mut Budget) -> Result<(), ()> {
    let mut stack: Vec<Work> = Vec::new();
    push_children(&mut stack, **el);
    while let Some(w) = stack.pop() {
        if bud.over() { return Err(()); }
        let n = match w { Work::Raw(s) => { out.push_str(s); continue; } Work::Node(n) => n };
        match n.value() {
            scraper::node::Node::Text(t) => out.push_str(&esc(&t.text)),
            scraper::node::Node::Element(_) => {
                let e = match ElementRef::wrap(n) { Some(e) => e, None => continue };
                let nm = e.value().name();
                if nm == "picture" {
                                                                                                                              
                    let im = e.descendants().skip(1).take(200).filter_map(ElementRef::wrap).find(|x| x.value().name() == "img");
                    if let Some(im) = im { render_img(&im, base, out, imgs); }
                    continue;
                }
                if nm == "img" { render_img(&e, base, out, imgs); continue; }
                if !ALLOW.contains(&nm) { push_children(&mut stack, n); continue; }
                if nm == "a" {
                    let abs = e.value().attr("href").and_then(|h| base.join(h).ok()).map(|u| u.as_str().to_string()).unwrap_or_default();
                    if !(abs.starts_with("http://") || abs.starts_with("https://")) { push_children(&mut stack, n); continue; }
                    out.push_str(&format!("<a href=\"{}\">", esc(&abs)));
                    stack.push(Work::Raw("</a>"));
                    push_children(&mut stack, n);
                    continue;
                }
                if nm == "br" || nm == "hr" { out.push_str(&format!("<{}>", nm)); continue; }
                out.push_str(&format!("<{}>", nm));
                stack.push(Work::Raw(close_tag(nm)));
                push_children(&mut stack, n);
            }
            _ => {}
        }
    }
    Ok(())
}
fn close_tag(nm: &str) -> &'static str {
    match nm { "p" => "</p>", "h1" => "</h1>", "h2" => "</h2>", "h3" => "</h3>", "h4" => "</h4>", "ul" => "</ul>", "ol" => "</ol>", "li" => "</li>",
        "blockquote" => "</blockquote>", "pre" => "</pre>", "code" => "</code>", "strong" => "</strong>", "b" => "</b>", "em" => "</em>", "i" => "</i>",
        "figure" => "</figure>", "figcaption" => "</figcaption>", "table" => "</table>", "thead" => "</thead>", "tbody" => "</tbody>", "tr" => "</tr>",
        "th" => "</th>", "td" => "</td>", "sup" => "</sup>", "sub" => "</sub>", _ => "" }
}

fn render_img(e: &ElementRef, base: &url::Url, out: &mut String, imgs: &mut u32) {
    let a = e.value();
    let mut s = a.attr("src").or_else(|| a.attr("data-src")).unwrap_or("").to_string();
    if s.is_empty() {
        if let Some(ss) = a.attr("srcset") { s = ss.split(',').next().unwrap_or("").trim().split_whitespace().next().unwrap_or("").to_string(); }
    }
    if s.is_empty() || s.starts_with("data:") || *imgs >= 40 { return; }
    let abs = match base.join(&s) { Ok(u) => u, Err(_) => return };
    if !(abs.as_str().starts_with("http://") || abs.as_str().starts_with("https://")) { return; }
    let w: i64 = a.attr("width").and_then(|v| v.parse().ok()).unwrap_or(0);
    let h: i64 = a.attr("height").and_then(|v| v.parse().ok()).unwrap_or(0);
    if w<0||h<0||(w > 0 && w < 80) || (h > 0 && h < 60) { return; }
    *imgs += 1;
    out.push_str(&format!("<img loading=\"lazy\" alt=\"{}\" src=\"/searx/img?u={}\">", esc(a.attr("alt").unwrap_or("")), crate::searx_fetch::enc_component(abs.as_str())));
}

const READER_CSS: &str = include_str!("../assets/reader.css");
const GO: &str = include_str!("../assets/reader-go.js");

fn shell_skin(title: &str, body: &str, skin: &str) -> String {
    format!("<!doctype html><html lang=\"en\" data-skin=\"{}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"theme-color\" content=\"{}\"><link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\"><link rel=\"icon\" href=\"/favicon.ico\" sizes=\"48x48\"><link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.png\"><title>{}</title><style>{}</style></head><body>{}{}</body></html>", skin, crate::searx_page::theme_color(skin), esc(title), READER_CSS, body, GO)
}
fn chrome(page: Option<&str>) -> String {
    let link = page.map(|p| format!("<a href=\"{}\">open the full page</a>", esc(p))).unwrap_or_default();
    format!("<div class=\"bar\"><a class=\"back\" href=\"/\" aria-label=\"back to ramjet\"><svg viewBox=\"0 0 24 24\"><path d=\"M15 5l-7 7 7 7\"/></svg></a><span class=\"mark\">read</span>{}</div>", link)
}
fn failure_page(f: Failure, page: Option<&str>, target: &str, skin: &str) -> String {
    let mut body = format!("{}<div class=\"err\">{}", chrome(None), f.copy());
    if f.retry() { body.push_str(&format!("<br><a data-reader-retry href=\"/searx/reader?u={}\">try again</a>", esc(&crate::searx_fetch::enc_component(target)))); }
    if let Some(page) = page.filter(|_| f != Failure::Blocked) { body.push_str(&format!("<br><a href=\"{}\">open the full page</a>", esc(page))); }
    body.push_str("</div>"); shell_skin("reader", &body, skin)
}

                                                                                                                   
                                                           
pub const READER_SLOTS: usize = 2;
const READER_WAIT: Duration = Duration::from_secs(5);

pub(crate) fn slots() -> &'static Arc<tokio::sync::Semaphore> {
    static S: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    S.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(READER_SLOTS)))
}
fn fetch_slots()->&'static Arc<tokio::sync::Semaphore>{static S:OnceLock<Arc<tokio::sync::Semaphore>>=OnceLock::new();S.get_or_init(||Arc::new(tokio::sync::Semaphore::new(8)))}
pub fn reader_slots_available() -> usize { slots().available_permits() }

                                                                                    
                                                                                          
                                                                                  
pub const MAX_TAG_DEPTH: usize = 1_500;
pub fn too_deep(html: &str, limit: usize) -> bool {
    const VOID: &[&str] = &["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"];
    let b = html.as_bytes(); let (mut count, mut i) = (0, 0);
    while i + 1 < b.len() {
        if b[i] == b'<' && b[i+1].is_ascii_alphabetic() {
            let start = i+1; let mut end = start;
            while end < b.len() && !matches!(b[end], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>') { end += 1; }
            let name = String::from_utf8_lossy(&b[start..end]).to_ascii_lowercase();
                                                                                     
            let bad_slash = b.get(end) == Some(&b'/') && b.get(end+1) != Some(&b'>');
            if !VOID.contains(&name.as_str()) || bad_slash { count += 1; if count > limit { return true; } }
            i = end;
        } else { i += 1; }
    }
    false
}

                                                                                                
pub fn extract(html: &str, page_url: &str, deadline: Instant) -> Result<String, Failure> { extract_skin(html, page_url, deadline, "dark") }
fn extract_skin(html: &str, page_url: &str, deadline: Instant, skin: &str) -> Result<String, Failure> {
    let mut bud = Budget::new(deadline);
    if Instant::now() >= deadline { return Err(Failure::Load); }
    if too_deep(html, MAX_TAG_DEPTH) { return Err(Failure::TooLarge); }
    let mut doc = Html::parse_document(html);
    if doc.tree.root().descendants().count() > 50_000 { return Err(Failure::TooLarge); }
    let title_sel = Selector::parse("title").unwrap();
    let og_sel = Selector::parse("meta[property='og:title']").unwrap();
    let title = doc.select(&og_sel).next().and_then(|m| m.value().attr("content")).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty())
        .or_else(|| doc.select(&title_sel).next().map(|t| text_of(&t)))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| url::Url::parse(page_url).ok().and_then(|u| u.host_str().map(|h| h.to_string())).unwrap_or_default());
                                                                      
    let mut drop_ids = Vec::new();
    for n in doc.tree.root().descendants() {
        if bud.over() { return Err(Failure::Load); }
        if let Some(el) = ElementRef::wrap(n) { if is_dropped(&el) { drop_ids.push(n.id()); } }
    }
    for id in drop_ids { if let Some(mut n) = doc.tree.get_mut(id) { n.detach(); } }
    let Some(main_id) = pick_main(&doc, &mut bud).map_err(|_| Failure::Load)? else { return Ok(failure_page(Failure::Extraction, Some(page_url), page_url, skin)); };
    {
        let main = ElementRef::wrap(doc.tree.get(main_id).unwrap()).unwrap();
        if text_of(&main).len() < 300 { return Ok(failure_page(Failure::Extraction, Some(page_url), page_url, skin)); }
                                                 
        let h1_sel = Selector::parse("h1").unwrap();
        let h1_ids: Vec<_> = main.select(&h1_sel).take(1).filter(|h| text_of(h).chars().take(30).collect::<String>() == title.chars().take(30).collect::<String>()).map(|h| h.id()).collect();
        for id in h1_ids { if let Some(mut n) = doc.tree.get_mut(id) { n.detach(); } }
    }
    let base = url::Url::parse(page_url).unwrap_or_else(|_| url::Url::parse("http://x/").unwrap());
    let main = ElementRef::wrap(doc.tree.get(main_id).unwrap()).unwrap();
    let mut out = String::new();
    let mut imgs = 0u32;
    render(&main, &base, &mut out, &mut imgs, &mut bud).map_err(|_| Failure::Load)?;
    let host = base.host_str().unwrap_or("").strip_prefix("www.").unwrap_or(base.host_str().unwrap_or("")).to_string();
    Ok(shell_skin("reader", &format!("{}<main><div class=\"src\">{}</div><h1 class=\"t\">{}</h1>{}</main>", chrome(Some(page_url)), esc(&host), esc(&title), out), skin))
}

pub async fn reader_page(st: &AppState, target: &str) -> String { reader_page_skin(st, target, "dark").await }
pub async fn reader_page_skin(st: &AppState, target: &str, skin: &str) -> String {
    let skin = if skin == "paper" { "paper" } else { "dark" };
    let permit = match tokio::time::timeout(READER_WAIT, fetch_slots().clone().acquire_owned()).await {
        Ok(Ok(p)) => p, _ => return failure_page(Failure::Unavailable, None, target, skin),
    };
                                                                                           
    let deadline = Instant::now() + Duration::from_secs(20);
    let (html, page_url) = match fetch_page(st, target, deadline).await {
        Ok(page) => page,
                                                                                               
                                                                          
        Err(f) => return failure_page(f, None, target, skin),
    };
    let fetch_permit=permit;
    let permit=match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline),slots().clone().acquire_owned()).await{Ok(Ok(p))=>p,_=>return failure_page(Failure::Unavailable,Some(&page_url),target,skin)};
    drop(fetch_permit);
    if !crate::apps::browse_render::memory_ok(&st.data_dir){return failure_page(Failure::Unavailable,Some(&page_url),target,skin)}
    let pu = page_url.clone();
    let job = tokio::task::spawn_blocking(move || { let _permit = permit; extract_skin(&html, &pu, deadline, skin) });
    match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline + Duration::from_secs(2)), job).await {
        Ok(Ok(Ok(page))) => page,
        Ok(Ok(Err(f))) => failure_page(f, Some(&page_url), target, skin),
        Ok(Err(_)) => failure_page(Failure::Unknown, Some(&page_url), target, skin),
        _ => failure_page(Failure::Load, Some(&page_url), target, skin),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
                                                                                             
    mod reference {
        use super::super::*;
        use scraper::{Html, Selector, ElementRef};
        fn pick_main_ref(doc: &Html) -> Option<ego_tree::NodeId> {
            let sel = Selector::parse("article, main, div, section, td, body, font").unwrap();
            let p_sel = Selector::parse("p").unwrap();
            let a_sel = Selector::parse("a").unwrap();
            let mut best: Option<ego_tree::NodeId> = None;
            let mut best_score = 0.0f64;
            for c in doc.select(&sel) {
                let mut score = 0.0f64;
                for p in c.select(&p_sel) {
                    let t = text_of(&p);
                    if t.len() > 60 { score += t.len().min(400) as f64; }
                }
                                       
                for node in c.children() {
                    if let Some(t) = node.value().as_text() {
                        let t = t.text.split_whitespace().collect::<Vec<_>>().join(" ");
                        if t.len() > 80 { score += t.len().min(1500) as f64; }
                    }
                }
                let links: usize = c.select(&a_sel).map(|a| text_of(&a).len()).sum();
                let all = text_of(&c).len().max(1) as f64;
                score *= 1.0 - (links as f64 / all).min(0.9);
                if c.value().name() == "article" { score *= 1.3; }
                if score > best_score { best_score = score; best = Some(c.id()); }
            }
            best
        }

        fn render_ref(el: &ElementRef, base: &url::Url, out: &mut String, imgs: &mut u32) {
            for child in el.children() {
                match child.value() {
                    scraper::node::Node::Text(t) => out.push_str(&esc(&t.text)),
                    scraper::node::Node::Element(_) => {
                        let e = match ElementRef::wrap(child) { Some(e) => e, None => continue };
                        let nm = e.value().name();
                        if nm == "picture" {
                            if let Some(im) = e.select(&Selector::parse("img").unwrap()).next() { render_img(&im, base, out, imgs); }
                            continue;
                        }
                        if nm == "img" { render_img(&e, base, out, imgs); continue; }
                        if !ALLOW.contains(&nm) { render_ref(&e, base, out, imgs); continue; }
                        if nm == "a" {
                            let abs = e.value().attr("href").and_then(|h| base.join(h).ok()).map(|u| u.as_str().to_string()).unwrap_or_default();
                            if !(abs.starts_with("http://") || abs.starts_with("https://")) { render_ref(&e, base, out, imgs); continue; }
                            out.push_str(&format!("<a href=\"{}\">", esc(&abs)));
                            render_ref(&e, base, out, imgs);
                            out.push_str("</a>");
                            continue;
                        }
                        if nm == "br" || nm == "hr" { out.push_str(&format!("<{}>", nm)); continue; }
                        out.push_str(&format!("<{}>", nm));
                        render_ref(&e, base, out, imgs);
                        out.push_str(&format!("</{}>", nm));
                    }
                    _ => {}
                }
            }
        }

        pub fn pick(doc: &Html) -> Option<ego_tree::NodeId> { pick_main_ref(doc) }
        pub fn rend(el: &ElementRef, base: &url::Url, out: &mut String, imgs: &mut u32) { render_ref(el, base, out, imgs) }
    }
    fn far() -> Instant { Instant::now() + Duration::from_secs(60) }
    fn lcg(seed: &mut u64) -> u64 { *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); *seed >> 33 }
    fn prune(doc: &mut Html) {
        let ids: Vec<_> = doc.tree.root().descendants().filter_map(|n| { let el = ElementRef::wrap(n)?; if is_dropped(&el) { Some(n.id()) } else { None } }).collect();
        for id in ids { if let Some(mut n) = doc.tree.get_mut(id) { n.detach(); } }
    }
    const WORDS: &[&str] = &["alpha", "be", "gamma-ray", "x", "lorem", "ipsum dolor", "  ", " ", "\n", "a\u{a0}b", "é", "tail ", " lead", "supercalifragilistic"];
    fn gen(seed: &mut u64, depth: u32, out: &mut String) {
        let n = 1 + lcg(seed) % 5;
        for _ in 0..n {
            match lcg(seed) % 11 {
                0 | 1 => { for _ in 0..(1 + lcg(seed) % 6) { out.push_str(WORDS[(lcg(seed) % WORDS.len() as u64) as usize]); } }
                2 if depth < 7 => { out.push_str("<div>"); gen(seed, depth + 1, out); out.push_str("</div>"); }
                3 if depth < 7 => { out.push_str("<p>"); for _ in 0..(1 + lcg(seed) % 14) { out.push_str(WORDS[(lcg(seed) % WORDS.len() as u64) as usize]); out.push(' '); } out.push_str("</p>"); }
                4 if depth < 7 => { out.push_str("<a href=\"/l\">"); gen(seed, depth + 1, out); out.push_str("</a>"); }
                5 if depth < 7 => { out.push_str("<article>"); gen(seed, depth + 1, out); out.push_str("</article>"); }
                6 if depth < 7 => { out.push_str("<section><b>"); gen(seed, depth + 1, out); out.push_str("</b>glued</section>"); }
                7 if depth < 7 => { out.push_str("<td>"); gen(seed, depth + 1, out); out.push_str("</td>"); }
                8 => out.push_str("<img src=\"/i.png\" width=\"200\">"),
                9 if depth < 7 => { out.push_str("<ul><li>"); gen(seed, depth + 1, out); out.push_str("</li></ul>"); }
                _ => out.push_str("<font>word</font>"),
            }
        }
    }
    fn doc_of(body: &str) -> Html { Html::parse_document(&format!("<html><head><title>T</title></head><body>{}</body></html>", body)) }

    #[test] fn seg_normalised_length_matches_text_of_across_text_boundaries() {
        for (a, b) in [("ab", "cd"), ("ab ", "cd"), ("ab", " cd"), (" ", "x"), ("x", " "), ("", "x y"), ("x y", ""), ("  ", "  "), ("a\u{a0}", "b"), ("é", "é ")] {
            let joined = format!("{}{}", a, b);
            let want = joined.split_whitespace().collect::<Vec<_>>().join(" ").len();
            assert_eq!(Seg::of(a).join(Seg::of(b)).norm_len(), want, "{a:?}+{b:?}");
        }
    }
    fn attached(doc: &Html, id: ego_tree::NodeId) -> bool { doc.tree.root().descendants().any(|n| n.id() == id) }
                                                                                                                        
                                                                                                                         
                                                                                                                       
    fn consistent(doc: &Html) -> bool {
        doc.tree.root().descendants().all(|n| n.children().all(|c| c.parent().map(|p| p.id()) == Some(n.id()))
            && n.descendants().count() == { fn cnt(n: ego_tree::NodeRef<scraper::node::Node>) -> usize { 1 + n.children().map(cnt).sum::<usize>() } cnt(n) })
    }
    #[test] fn pick_main_matches_the_recursive_reference_on_generated_pages() {
        let mut seed = 12345u64; let (mut cmp, mut skipped, mut detached) = (0, 0, 0);
        for i in 0..400 {
            let mut body = String::new(); gen(&mut seed, 0, &mut body);
            let d = doc_of(&body);
            if !consistent(&d) { skipped += 1; continue; }
            assert_eq!(pick_main(&d, &mut Budget::new(far())).unwrap(), reference::pick(&d), "unpruned page {i}: {body}");
            let mut d = doc_of(&body); prune(&mut d);                                                                                           
            let (new, old) = (pick_main(&d, &mut Budget::new(far())).unwrap(), reference::pick(&d));
            match old { Some(o) if !attached(&d, o) => detached += 1, _ => assert_eq!(new, old, "pruned page {i}: {body}") }
            cmp += 1;
        }
        assert!(cmp >= 150, "compared {cmp} (skipped {skipped} inconsistent trees, old picked a removed node on {detached})");
    }
    #[test] fn render_matches_the_recursive_reference_on_generated_pages() {
        let mut seed = 777u64; let base = url::Url::parse("https://ex.test/a/b").unwrap();
        for i in 0..300 {
            let mut body = String::new(); gen(&mut seed, 0, &mut body);
            body.push_str("<picture><source srcset=\"/s.webp\"><img src=\"/p.png\"></picture><a href=\"javascript:x\">js <i>in</i></a><a href=\"/ok\">ok</a><br><hr>&amp;&lt;");
            let mut d = doc_of(&body); prune(&mut d);
            let main = ElementRef::wrap(d.tree.get(reference::pick(&d).unwrap_or(d.tree.root().first_child().unwrap().id())).unwrap());
            let Some(main) = main else { continue };
            let (mut o1, mut o2, mut i1, mut i2) = (String::new(), String::new(), 0u32, 0u32);
            reference::rend(&main, &base, &mut o1, &mut i1);
            render(&main, &base, &mut o2, &mut i2, &mut Budget::new(far())).unwrap();
            assert_eq!(o1, o2, "page {i}"); assert_eq!(i1, i2);
        }
    }
    #[test] fn render_image_limit_and_order_are_kept() {
        let base = url::Url::parse("https://ex.test/").unwrap(); let mut body = String::new();
        for i in 0..60 { body.push_str(&format!("<p>t{i}</p><img src=\"/i{i}.png\">")); }
        let d = doc_of(&body); let main = ElementRef::wrap(d.tree.root().descendants().find(|n| n.value().as_element().map_or(false, |e| e.name() == "body")).unwrap()).unwrap();
        let (mut o1, mut o2, mut i1, mut i2) = (String::new(), String::new(), 0, 0);
        reference::rend(&main, &base, &mut o1, &mut i1); render(&main, &base, &mut o2, &mut i2, &mut Budget::new(far())).unwrap();
        assert_eq!(o1, o2); assert_eq!(i2, 40);
    }

                          
    fn on_small_stack<F: FnOnce() + Send + 'static>(f: F) {
                                                                                                                       
        std::thread::Builder::new().stack_size(256 * 1024).spawn(f).unwrap().join().expect("must not overflow the stack");
    }
                                                                                                               
    fn chain(tag: &str, n: usize, text: &str) -> Html {
        let mut d = Html::parse_document(&format!("<html><body><{tag}>x</{tag}></body></html>"));
        let el = d.tree.root().descendants().find(|x| x.value().as_element().map_or(false, |e| e.name() == tag)).unwrap();
        let (proto, text_proto) = (el.value().clone(), el.first_child().unwrap().value().clone());
        let body_id = el.parent().unwrap().id();
        { let mut b = d.tree.get_mut(body_id).unwrap(); while let Some(mut c) = b.first_child() { c.detach(); } }
        let mut cur = body_id;
        for _ in 0..n { cur = d.tree.get_mut(cur).unwrap().append(proto.clone()).id(); }
        let mut t = text_proto; if let scraper::node::Node::Text(x) = &mut t { x.text = text.into(); }
        d.tree.get_mut(cur).unwrap().append(t);
        d
    }
    #[test] fn render_and_pick_main_survive_200k_nested_divs_on_a_tiny_stack() {
        on_small_stack(|| {
            let d = chain("div", 200_000, &"word ".repeat(120));
            let base = url::Url::parse("https://ex.test/").unwrap();
            let t = Instant::now();
            let id = pick_main(&d, &mut Budget::new(far())).unwrap().expect("a container is picked");
            let main = ElementRef::wrap(d.tree.get(id).unwrap()).unwrap();
            let (mut out, mut imgs) = (String::new(), 0u32);
            render(&main, &base, &mut out, &mut imgs, &mut Budget::new(far())).unwrap();
            assert!(out.contains("word word"), "text at the bottom of 200k levels is rendered");
            assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        });
    }
    #[test] fn render_survives_100k_nested_allowed_tags_and_closes_them_all() {
        on_small_stack(|| {
            let d = chain("b", 100_000, "deep");
            let body = ElementRef::wrap(d.tree.root().descendants().find(|n| n.value().as_element().map_or(false, |e| e.name() == "body")).unwrap()).unwrap();
            let (mut out, mut imgs) = (String::new(), 0u32);
            render(&body, &url::Url::parse("https://ex.test/").unwrap(), &mut out, &mut imgs, &mut Budget::new(far())).unwrap();
            assert_eq!(out.matches("<b>").count(), 100_000); assert_eq!(out.matches("</b>").count(), 100_000);
            assert!(out.contains("deep"));
        });
    }
    #[test] fn markup_nested_beyond_the_tag_depth_limit_is_refused_before_parsing() {
        on_small_stack(|| {
            for n in [100_000usize, 5_000, 1_600] {
                let html = format!("<html><body>{}<p>{}</p>{}</body></html>", "<div>".repeat(n), "word ".repeat(120), "</div>".repeat(n));
                let t = Instant::now(); assert!(extract(&html, "https://ex.test/", far()).is_err(), "n={n}"); assert!(t.elapsed() < Duration::from_secs(1), "refusal is a cheap scan: {:?}", t.elapsed());
            }
        });
    }
    #[test] fn markup_at_realistic_depth_still_extracts() {
        on_small_stack(|| {
            let n = 1_000;
            let html = format!("<html><head><title>Deep</title></head><body>{}<p>{}</p>{}</body></html>", "<div>".repeat(n), "word ".repeat(120), "</div>".repeat(n));
            let t = Instant::now(); let out = extract(&html, "https://ex.test/", far()).expect("depth 1000 is allowed"); assert!(out.contains("word word"));
            assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        });
    }
    #[test] fn conservative_parser_admission() {
        for text in ["<div/>", "<div></bogus>", "<td>", "<p>", "<li>", "<tr>", "<br_>", "<img.x>", "<input=foo>", "<br/x>"] { assert!(too_deep(&text.repeat(100_000), 50), "{text}"); }
        assert!(!too_deep(&"<br><img src=x><input>".repeat(100), 5));
        assert!(!too_deep("<div><p>words</p></div>", 5));
    }
    #[test] fn expired_deadline_aborts_instead_of_running_on() {
        let html = format!("<html><body>{}</body></html>", "<p>some words here and there</p>".repeat(20_000));
        assert!(extract(&html, "https://ex.test/", Instant::now() - Duration::from_secs(1)).is_err());
        assert!(extract("<html><body><p>tiny</p></body></html>", "https://ex.test/", Instant::now() - Duration::from_secs(1)).is_err());
    }
    #[test] fn extract_end_to_end_basic_article_and_non_article() {
        let para = "A reasonably long sentence about nothing in particular that keeps going for a while. ";
        let html = format!("<html><head><title>My Title</title></head><body><nav>menu</nav><article><h1>My Title</h1><p>{}</p><p>{}</p><img src=\"/a.png\"></article></body></html>", para.repeat(3), para.repeat(2));
        let out = extract(&html, "https://www.ex.test/p", far()).unwrap();
        assert!(out.contains("<h1 class=\"t\">My Title</h1>") && out.contains("<p>A reasonably long") && out.contains("/searx/img?u=") && !out.contains("menu"));
        assert!(extract("<html><body><p>short</p></body></html>", "https://ex.test/", far()).unwrap().contains("no article text found."));
    }
    #[test] fn slots_are_two_and_start_free() { assert_eq!(READER_SLOTS, 2); assert!(reader_slots_available() <= 2); }
    #[tokio::test] async fn only_reader_slots_pages_at_once_and_the_blocking_task_owns_its_permit() {
        let (a, b) = (slots().clone().try_acquire_owned().unwrap(), slots().clone().try_acquire_owned().unwrap());
        assert!(slots().clone().try_acquire_owned().is_err(), "a third page waits");
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let job = tokio::task::spawn_blocking(move || { let _p = a; rx.recv().ok(); });                                                                       
        assert!(slots().clone().try_acquire_owned().is_err(), "still held while the blocking work runs, even if the awaiter gave up");
        tx.send(()).unwrap(); job.await.unwrap();
        assert!(slots().clone().try_acquire_owned().is_ok(), "released when the work really ends");
        drop(b);
        assert_eq!(reader_slots_available(), READER_SLOTS);
    }
    #[test] fn fixed_error_copy_and_retry() {
        let blocked = failure_page(Failure::Blocked, Some("https://bad.test/"), "bad", "paper");
        assert!(!blocked.contains("https://bad.test/") && !blocked.contains(">try again<"));
        let retry = failure_page(Failure::Load, Some("https://ok.test/"), "https://ok.test/?a=1&b=2", "paper");
        assert!(retry.contains(">try again</a>") && retry.contains("data-skin=\"paper\""));
        for f in [Failure::Status(429), Failure::Status(403), Failure::Unavailable, Failure::Extraction, Failure::Unknown] {
            assert!(!failure_page(f, None, "https://ok.test", "dark").contains(">try again<"));
        }
    }
}
