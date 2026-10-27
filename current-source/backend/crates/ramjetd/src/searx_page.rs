                                                                              
                                                                           
use serde_json::Value;
use crate::searx_fetch::enc_component;

pub const SX_CSS: &str = include_str!("../assets/sx.css");
pub const SX_JS: &str = include_str!("../assets/sx.js");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Failure { RateLimited, Forbidden, Unavailable, Retryable, Unknown }
pub fn skin(cookie: Option<&str>) -> &'static str {
    if cookie.unwrap_or("").split(';').any(|p| p.trim() == "rj_skin=paper") { "paper" } else { "dark" }
}
pub fn theme_color(skin: &str) -> &'static str { if skin == "paper" { "#f2f2f2" } else { "#0a0a0a" } }

const SX_CATS: [(&str, &str); 5] = [("general", "all"), ("images", "images"), ("videos", "videos"), ("news", "news"), ("map", "maps")];
const SX_SAFE: [&str; 3] = ["off", "moderate", "strict"];

                                                                                                   
fn percent_decode(b: &str) -> Option<String> {
    let bytes = b.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() { return None; }
            let h = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16).ok()?;
            out.push(h); i += 3;
        } else { out.push(bytes[i]); i += 1; }
        }
    String::from_utf8(out).ok()
}
                        
pub fn sx_esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"), '<' => o.push_str("&lt;"), '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"), '\'' => o.push_str("&#39;"), _ => o.push(c),
        }
    }
    o
}
                                              
fn sx_href(u: &str) -> String {
    let Ok(mut url) = url::Url::parse(u) else { return String::new(); };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() { return String::new(); }
    if url.set_username("").is_err() || url.set_password(None).is_err() { return String::new(); }
    url.to_string()
}

              
fn sx_host(u: &str) -> String {
    url::Url::parse(u).ok().and_then(|p| p.host_str().map(|h| h.to_string())).unwrap_or_default()
}
                                                                            
fn sx_crumb(u: &str) -> String {
    match url::Url::parse(u) {
        Ok(p) => {
            let bits: Vec<String> = p.path().split('/').filter(|b| !b.is_empty()).take(3)
                .map(|b| percent_decode(b).unwrap_or_else(|| b.to_string()))
                .collect();
            let host = p.host_str().map(|h| sx_esc(&format!("{}{}", h, p.port().map(|n| format!(":{}", n)).unwrap_or_default()))).unwrap_or_else(|| sx_esc(u));
            if bits.is_empty() { host } else { format!("{} &rsaquo; {}", host, bits.iter().map(|b| sx_esc(b)).collect::<Vec<_>>().join(" &rsaquo; ")) }
        }
        Err(_) => sx_esc(u),
    }
}
             
fn sx_src(r: &Value) -> String {
    let e = r.get("engine").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
    let s = if e.starts_with("brave") { "brave".into() }
        else if e.contains("cse") { "google cse".into() }
        else if e.starts_with("google") { "google".into() }
        else if e.starts_with("pinterest") { "pinterest".into() }
        else if e.starts_with("wikicommons") { "wikimedia".into() }
        else if e.starts_with("bing") { "bing".into() }
        else { e.trim_end_matches(" images").to_string() };
    s
}
             
fn sx_img(u: &str) -> String {
    if u.is_empty() { String::new() } else { format!("/searx/img?u={}", enc_component(u)) }
}

const SX_BANGS: [(&str, &str); 17] = [
    ("w", "https://en.wikipedia.org/w/index.php?search=%s"), ("yt", "https://www.youtube.com/results?search_query=%s"),
    ("g", "https://www.google.com/search?q=%s"), ("ddg", "https://duckduckgo.com/?q=%s"), ("r", "https://www.reddit.com/search/?q=%s"),
    ("gh", "https://github.com/search?q=%s"), ("a", "https://www.amazon.com/s?k=%s"), ("maps", "https://www.google.com/maps/search/%s"),
    ("imdb", "https://www.imdb.com/find/?q=%s"), ("mdn", "https://developer.mozilla.org/en-US/search?q=%s"), ("so", "https://stackoverflow.com/search?q=%s"),
    ("tw", "https://x.com/search?q=%s"), ("gi", "https://www.google.com/search?tbm=isch&q=%s"), ("wa", "https://www.wolframalpha.com/input?i=%s"),
    ("npm", "https://www.npmjs.com/search?q=%s"), ("tr", "https://translate.google.com/?sl=auto&text=%s"), ("ebay", "https://www.ebay.com/sch/i.html?_nkw=%s"),
];
                                      
pub fn sx_bang(q: &str) -> Option<String> {
    let (k, t) = if let Some(rest) = q.strip_prefix('!') {
        let mut it = rest.splitn(2, |c: char| c.is_whitespace());
        let key = it.next()?;
        let tail = it.next()?;
        if key.is_empty() || key.len() > 5 || !key.chars().all(|c| c.is_ascii_alphabetic()) { return None; }
        (key.to_lowercase(), tail.trim().to_string())
    } else {
                                               
        let bytes = q.as_bytes();
        let mut i = bytes.len();
        while i > 0 && bytes[i - 1].is_ascii_alphabetic() { i -= 1; }
        if i == 0 || i == bytes.len() { return None; }
        if bytes[i - 1] != b'!' { return None; }
        let key = &q[i..];
        if key.len() > 5 { return None; }
                                        
        if i - 1 == 0 || !bytes[i - 2].is_ascii_whitespace() { return None; }
        (key.to_lowercase(), q[..i - 1].trim().to_string())
    };
    if t.is_empty() { return None; }
    SX_BANGS.iter().find(|(bk, _)| *bk == k).map(|(_, tpl)| tpl.replace("%s", &enc_component(&t)))
}

fn js_f64(n: f64, decimals: usize) -> String { format!("{:.*}", decimals, n) }

                                                                                        
fn comma_group(n: f64) -> String {
    if !n.is_finite() { return "0".into(); }
    let neg = n < 0.0;
    let int = n.abs().trunc() as u128;
    let digits = int.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 { out.push(','); }
        out.push(c);
    }
    if neg { format!("-{}", out) } else { out }
}

struct Ctx<'a> { query: &'a str, cat: &'a str, safe: i64 }
impl<'a> Ctx<'a> {
                                                                             
    fn qs(&self, over: &[(&str, String)]) -> String {
        let mut m: Vec<(String, String)> = vec![("q".into(), self.query.into()), ("c".into(), self.cat.into()), ("s".into(), self.safe.to_string())];
        for (k, v) in over {
            if let Some(e) = m.iter_mut().find(|(kk, _)| kk == k) { e.1 = v.clone(); } else { m.push((k.to_string(), v.clone())); }
        }
        let parts: Vec<String> = m.into_iter()
            .filter(|(k, v)| !v.is_empty() && !(k == "c" && v == "general"))
            .map(|(k, v)| format!("{}={}", k, enc_component(&v)))
            .collect();
        format!("/searx/search?{}", parts.join("&"))
    }
}

                                                                                   
                               
pub fn sx_page(query: &str, page: i64, down: bool, data: Option<&Value>, cat: &str, safe: i64, img_data: Option<&Value>) -> String {
    sx_page_state(query, page, if down { Some(Failure::Unavailable) } else { None }, data, cat, safe, img_data, "dark")
}

pub fn sx_page_state(query: &str, page: i64, failure: Option<Failure>, data: Option<&Value>, cat: &str, safe: i64, img_data: Option<&Value>, skin: &str) -> String {
    let cat = if SX_CATS.iter().any(|(c, _)| *c == cat) { cat } else { "general" };
    let safe = if [0, 1, 2].contains(&safe) { safe } else { 0 };
    let cx = Ctx { query, cat, safe };
    let empty = Value::Object(serde_json::Map::new());
    let data = data.unwrap_or(&empty);
    let results: Vec<&Value> = data.get("results").and_then(|r| r.as_array()).map(|a| a.iter().collect()).unwrap_or_default();
    let answers: Vec<String> = data.get("answers").and_then(|a| a.as_array()).map(|a| {
        a.iter().map(|x| if x.is_string() { x.as_str().unwrap_or("").to_string() } else { x.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string() })
            .filter(|s| !s.is_empty()).take(2).collect()
    }).unwrap_or_default();
    let corrections: Vec<&str> = data.get("corrections").and_then(|c| c.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).filter(|s| !s.is_empty()).take(1).collect()).unwrap_or_default();
    let total = data.get("number_of_results").and_then(|n| n.as_f64()).unwrap_or(0.0);

    let mut strip = String::new();
    if cat == "general" && page == 1 {
        if let Some(arr) = img_data.and_then(|d| d.get("results")).and_then(|r| r.as_array()) {
            let ims: Vec<(String, String, String)> = arr.iter().map(|r| {
                let get = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("");
                let th = get("thumbnail_src"); let th = if th.is_empty() { get("thumbnail") } else { th };
                let t = { let h = sx_href(th); if h.is_empty() { sx_href(get("img_src")).to_string() } else { h.to_string() } };
                let f = sx_href(get("img_src")).to_string();
                let a = r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                (t, f, a)
            }).filter(|(t, _, _)| !t.is_empty()).take(9).collect();
            if ims.len() >= 4 {
                let href = format!("/searx/search?q={}&c=images", enc_component(query));
                let tiles: String = ims.iter().map(|(t, f, a)| {
                    let mut s = format!("<a href=\"{}\"><img loading=\"lazy\" referrerpolicy=\"no-referrer\" alt=\"{}\" src=\"{}\"", sx_esc(&href), sx_esc(&a.chars().take(80).collect::<String>()), sx_esc(&sx_img(t)));
                    if !f.is_empty() && f != t { s.push_str(&format!(" data-full=\"{}\"", sx_esc(&sx_img(f)))); }
                    s.push_str(" /></a>"); s
                }).collect();
                strip = format!("<li class=\"strip\"><div class=\"strip-row\">{}</div><a class=\"strip-more\" href=\"{}\">more images &rarr;</a></li>", tiles, sx_esc(&href));
            }
        }
    }

    let mut cards: Vec<String> = Vec::new();
    for r in &results {
        let get = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let href = sx_href(get("url")).to_string();
        if href.is_empty() { continue; }
        let engines = r.get("engines").and_then(|e| e.as_array()).map(|a| {
            let mut seen = Vec::new();
            for v in a { if let Some(s) = v.as_str() { if !seen.contains(&s) { seen.push(s); } } }
            seen.into_iter().take(3).collect::<Vec<_>>().join(" \u{b7} ")
        }).unwrap_or_else(|| get("engine").to_string());
        let date = get("publishedDate").chars().take(10).collect::<String>();
        let meta = [engines.as_str(), date.as_str()].iter().filter(|s| !s.is_empty()).map(|s| s.to_string()).collect::<Vec<_>>().join(" \u{b7} ");
        let th = { let t = get("thumbnail_src"); let t = if t.is_empty() { get("thumbnail") } else { t }; sx_href(t).to_string() };
        if cat == "images" {
            let full = sx_href(get("img_src")).to_string();
            let mut s = format!("<li class=\"tile\"><a rel=\"noreferrer noopener\" href=\"{}\" title=\"{}\"><img loading=\"lazy\" referrerpolicy=\"no-referrer\" alt=\"{}\" src=\"{}\"",
                sx_esc(&href), sx_esc(get("title")), sx_esc(get("title")), sx_esc(&sx_img(if th.is_empty() { &full } else { &th })));
            if !th.is_empty() && !full.is_empty() { s.push_str(&format!(" data-alt=\"{}\"", sx_esc(&sx_img(&full)))); }
            if !th.is_empty() && !full.is_empty() { s.push_str(&format!(" data-full=\"{}\"", sx_esc(&sx_img(&full)))); }
            s.push_str(&format!(" /><span class=\"src-chip\">{}</span></a><div class=\"tile-cap\">{}</div></li>", sx_esc(&sx_src(r)), sx_esc(&get("title").chars().take(60).collect::<String>())));
            cards.push(s); continue;
        }
        let thumb_html = if !th.is_empty() && (cat == "videos" || cat == "news") {
            format!("<img class=\"hit-th {}\" loading=\"lazy\" referrerpolicy=\"no-referrer\" alt=\"\" src=\"{}\" />", cat, sx_esc(&sx_img(&th)))
        } else { String::new() };
        let extra = if cat == "map" && r.get("latitude").is_some() {
            let lat = r.get("latitude").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let lon = r.get("longitude").and_then(|v| v.as_f64()).unwrap_or(0.0);
            format!(" &middot; {}", sx_esc(&format!("{}, {}", js_f64(lat, 3), js_f64(lon, 3))))
        } else { String::new() };
        let dur = if cat == "videos" && !get("length").is_empty() { format!(" &middot; {}", sx_esc(get("length"))) } else { String::new() };
        let host1 = sx_host(&href);
        let host1 = host1.strip_prefix("www.").unwrap_or(&host1).to_string();
        let fav = host1.chars().next().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        let content = get("content");
        let mut s = format!("<li class=\"hit{}\">{}{}<div class=\"hit-body\">", if thumb_html.is_empty() { "" } else { " has-th" }, thumb_html, "");
        s.push_str(&format!("<div class=\"hit-site\"><span class=\"fav\" aria-hidden=\"true\">{}</span><div class=\"hit-crumb\">{}</div></div>", sx_esc(&fav), sx_crumb(&href)));
        s.push_str(&format!("<a class=\"hit-title\" rel=\"noreferrer noopener\" href=\"{}\">{}</a>", sx_esc(&href), sx_esc(if get("title").is_empty() { &href } else { get("title") })));
        if !content.is_empty() { s.push_str(&format!("<p class=\"hit-snip\">{}</p>", sx_esc(&content.chars().take(320).collect::<String>()))); }
        if !meta.is_empty() { s.push_str(&format!("<div class=\"hit-meta\">{}{}{}</div>", sx_esc(&meta), extra, dur)); }
        s.push_str("</div></li>");
        cards.push(s);
    }

    let q_attr = sx_esc(query);
    let home = query.is_empty();
    let mut body = String::new();
    if let Some(failure) = failure {
        let copy = match failure {
            Failure::RateLimited => "slow down a bit.", Failure::Forbidden => "this site blocked the request.",
            Failure::Unavailable => "search isn't available right now.", Failure::Retryable | Failure::Unknown => "search couldn't load.",
        };
        body.push_str(&format!("<div class=\"notice\">{}</div>", copy));
        if failure == Failure::Retryable { body.push_str(&format!("<a class=\"pill\" href=\"{}\">try again</a>", sx_esc(&cx.qs(&[("p",page.to_string())])))); }
    } else if !query.is_empty() && cards.is_empty() {
        body.push_str(&format!("<div class=\"notice\">no results for &quot;{}&quot;. try different words.</div>", q_attr));
    }
    if failure.is_none() && !answers.is_empty() {
        for a in &answers { body.push_str(&format!("<div class=\"answer\">{}</div>", sx_esc(a))); }
    }
    if failure.is_none() && !corrections.is_empty() {
        body.push_str(&format!("<div class=\"correction\">did you mean <a href=\"/searx/search?q={}\">{}</a>?</div>", enc_component(corrections[0]), sx_esc(corrections[0])));
    }
    if failure.is_none() && !cards.is_empty() {
        body.push_str(&format!("<div class=\"count\">{}</div>", if total != 0.0 { format!("about {} results", comma_group(total)) } else { format!("{} results", cards.len()) }));
        if !strip.is_empty() { let pos = std::cmp::min(2, cards.len()); cards.insert(pos, strip); }
        body.push_str(&format!("<ol class=\"{}\">{}</ol>", if cat == "images" { "grid" } else { "hits" }, cards.join("")));
        body.push_str("<div class=\"pager\">");
        if page > 1 { body.push_str(&format!("<a class=\"pill\" href=\"{}\">&larr; back</a>", cx.qs(&[("p", (page - 1).to_string())]))); }
        body.push_str(&format!("<a class=\"pill\" href=\"{}\">show more &rarr;</a>", cx.qs(&[("p", (page + 1).to_string())])));
        body.push_str("</div>");
    }

    let svg_s = "<svg class=\"ic\" viewBox=\"0 0 24 24\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-3.5-3.5\"/></svg>";
    let form_html = format!(
        "<form class=\"box\" action=\"/searx/search\" method=\"get\">{}<input type=\"text\" name=\"q\" value=\"{}\" placeholder=\"search the web\" aria-label=\"search the web\" autocomplete=\"off\" enterkeyhint=\"search\" list=\"sxdl\"{} /><datalist id=\"sxdl\"></datalist><input type=\"hidden\" name=\"c\" value=\"{}\" /><input type=\"hidden\" name=\"s\" value=\"{}\" /><button type=\"submit\" aria-label=\"search\"><svg viewBox=\"0 0 24 24\"><path d=\"M5 12h14M13 6l6 6-6 6\"/></svg></button></form>",
        svg_s, q_attr, if home { " autofocus" } else { "" }, cat, safe);
    let tabs_html = format!("<div class=\"tabsrow\"><nav class=\"tabs\" aria-label=\"search type\"><span class=\"tabset\">{}</span><span class=\"safe\" role=\"group\" aria-label=\"safe search\">{}</span></nav></div>",
        SX_CATS.iter().map(|(c, n)| format!("<a class=\"tab{}\" href=\"{}\"{}>{}</a>", if *c == cat { " on" } else { "" }, cx.qs(&[("c", c.to_string()), ("p", String::new())]), if *c == cat { " aria-current=\"page\"" } else { "" }, n)).collect::<Vec<_>>().join(""),
        SX_SAFE.iter().enumerate().map(|(i, n)| format!("<a class=\"sf{}\" href=\"{}\">{}</a>", if i as i64 == safe { " on" } else { "" }, cx.qs(&[("s", i.to_string()), ("p", String::new())]), n)).collect::<Vec<_>>().join(""));
    let back = "<a class=\"back\" href=\"/\" aria-label=\"back to ramjet\"><svg viewBox=\"0 0 24 24\"><path d=\"M15 5l-7 7 7 7\"/></svg></a>";
    let head_q = format!("<span class=\"head-q\">{}</span>", q_attr);
    let head_bar = format!("<header class=\"bar\"><div class=\"bar-in\">{}<span class=\"mark\">search</span>{}</div></header>", back, head_q);

    format!("<!doctype html><html lang=\"en\" data-skin=\"{}\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>{}ramjet search</title><meta name=\"theme-color\" content=\"{}\" /><link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\"><link rel=\"icon\" href=\"/favicon.ico\" sizes=\"48x48\"><link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.png\"><style>{}</style></head><body>{}<script>{}</script></body></html>",
        skin, if query.is_empty() { String::new() } else { format!("{} - ", q_attr) },
        theme_color(skin), SX_CSS,
        if home {
            format!("<header class=\"bar\"><div class=\"bar-in\">{}</div></header><main class=\"home-hero\"><div class=\"mark\">search</div>{}<div class=\"recent\" id=\"sxrecent\"></div></main>", back, form_html)
        } else {
            format!("{}{}<main class=\"wrap{}\"><div class=\"col\">{}<div class=\"foot\">served from your own box &middot; queries go straight from the box to the engines<span id=\"sxlite\"></span></div></div></main>",
                head_bar, if query.is_empty() { String::new() } else { tabs_html }, if cat == "images" { " wide" } else { "" }, body)
        },
        SX_JS)
}

#[cfg(test)]
mod style_tests {
    use super::*;
    #[test] fn result_urls_strip_credentials() {
        assert_eq!(sx_href("https://user:secret@example.com/path"), "https://example.com/path");
        assert_eq!(sx_href("javascript:alert(1)"), "");
    }
    #[test] fn skins_failures_and_external_case() {
        assert_eq!(skin(Some("a=1; rj_skin=paper")), "paper");
        assert_eq!(skin(Some("rj_skin=evil")), "dark");
        for (f, text) in [(Failure::RateLimited,"slow down a bit."),(Failure::Forbidden,"this site blocked the request."),(Failure::Unavailable,"search isn't available right now."),(Failure::Unknown,"search couldn't load.")] {
            let page = sx_page_state("Mixed CASE", 2, Some(f), None, "images", 2, None, "paper");
            assert!(page.contains(&format!("<div class=\"notice\">{text}</div>")));
            assert!(!page.contains(">try again<")); assert!(page.contains("data-skin=\"paper\""));
            assert!(page.contains("Mixed CASE") && page.contains("aria-current=\"page\""));
            assert!(!page.contains("theme-boot.js") && !page.contains("walls.css"));
        }
        let forbidden = sx_page_state("q", 1, Some(Failure::Forbidden), None, "general", 0, None, "dark");
        assert!(forbidden.contains("this site blocked the request.") && !forbidden.contains("this device"), "403 copy blames the origin, not the device");
        let stale = serde_json::json!({"results":[{"url":"https://example.com","title":"STALE SENTINEL"}],"answers":["STALE ANSWER"],"corrections":["STALE CORRECTION"]});
        let page = sx_page_state("q",1,Some(Failure::Unavailable),Some(&stale),"general",0,None,"dark");
        assert!(!page.contains("STALE SENTINEL") && !page.contains("STALE ANSWER") && !page.contains("STALE CORRECTION"));
        let empty = sx_page_state("q",1,None,None,"general",0,None,"paper");
        assert!(!empty.contains("class=\"pager\"") && !empty.contains("show more &rarr;"));
        assert!(!empty.contains("<form class=\"box\"") && empty.contains("<span class=\"head-q\">q</span>"));
        let home = sx_page_state("",1,None,None,"general",0,None,"dark");
        assert!(home.contains("<div class=\"recent\" id=\"sxrecent\"></div>"));
        assert!(home.contains("<form class=\"box\"") && home.contains("autofocus"));
        let results_page = sx_page_state("goats",1,None,None,"images",0,None,"dark");
        assert!(!results_page.contains("<form class=\"box\"") && results_page.contains("<span class=\"head-q\">goats</span>"));
        let retry = sx_page_state("Mixed CASE", 2, Some(Failure::Retryable), None, "images", 2, None, "dark");
        assert!(retry.contains(">try again</a>") && retry.contains("p=2"));
    }
}
