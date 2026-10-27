                                                                        
use std::collections::HashMap;
use super::yt::YtVideo;

                                                                               
                                                                              
                                                                                   
                                                             
struct SheetItem { n: usize, title: String, duration: String, thumb: std::path::PathBuf }

const F: &str = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FR: &str = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const TW: i64 = 296; const TH: i64 = 167; const CH: i64 = 227; const M: i64 = 14; const G: i64 = 12;

                                                                                  
                                                                                 
fn ra(w: i64, h: i64, r: i64) -> String {
    let (w2, h2) = (w as f64 / 2.0, h as f64 / 2.0);
    format!("a='255*clip({r}+0.5-hypot(max(abs(X-{w2}+0.5)-{},0),max(abs(Y-{h2}+0.5)-{},0)),0,1)'", w2 - r as f64, h2 - r as f64)
}
fn rnd(w: i64, h: i64, r: i64) -> String {
    format!("format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':{}", ra(w, h, r))
}
                                                                    
fn esc(s: &str) -> String {
    let bad = regex::Regex::new(r"[^\p{L}\p{N} .,!?&'()\-:|#%+]").unwrap();
    let ws = regex::Regex::new(r"\s+").unwrap();
    ws.replace_all(&bad.replace_all(s, " "), " ").trim().to_string()
}
                                                                               
fn wrap(t: &str) -> (String, String) {
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= 29 { return (t.to_string(), String::new()); }
    let cut = match chars[..=29].iter().rposition(|&c| c == ' ') { Some(p) if p >= 14 => p, _ => 29 };
    let l2raw: String = chars[cut..].iter().collect::<String>().trim().to_string();
    let l2 = if l2raw.chars().count() > 29 { l2raw.chars().take(27).collect::<String>().trim_end().to_string() + "..." } else { l2raw };
    (chars[..cut].iter().collect::<String>().trim().to_string(), l2)
}

                                                                             
                                                                              
                                                                             
                                                                             
                                                             
fn thumb_url(src: &str) -> Option<String> {
    if src.starts_with("https://") {
        let t = url::Url::parse(src).ok()?;
        let h = t.host_str().unwrap_or("");
        if h == "imgs.search.brave.com" { return Some(src.to_string()); }
        if let Some(m) = h.strip_prefix("encrypted-tbn").and_then(|m| m.strip_suffix(".gstatic.com")) {
            if m.len() == 1 && m.as_bytes()[0].is_ascii_digit() { return Some(src.to_string()); }
        }
        None
    } else {
        Some(format!("https://i.ytimg.com/vi/{src}/mqdefault.jpg"))
    }
}

pub async fn fetch_thumb(st: &crate::AppState, src: &str) -> Option<std::path::PathBuf> {
    let url = thumb_url(src)?;
    let fut = async {
        let mut resp = super::ssrf::get_once(st, &url, "image/*,*/*;q=0.5").await.ok()?;                                                    
        if resp.status().as_u16() != 200 { return None; }
        let mut buf = Vec::new();
        loop {                                    
            match resp.chunk().await {
                Ok(Some(c)) => { if buf.len() + c.len() > 400_000 { return None; } buf.extend_from_slice(&c); }
                Ok(None) => break,
                Err(_) => return None,
            }
        }
        let tmp = super::tmp_path("thumb");
        std::fs::write(&tmp, &buf).ok()?;
        Some(tmp)
    };
    tokio::time::timeout(std::time::Duration::from_secs(8), fut).await.ok().flatten()
}


pub async fn make_sheet(st: &crate::AppState, rs: &[YtVideo]) -> Result<Vec<u8>, String> {
                                                                                      
                                                                           
    let fetched = futures::future::join_all(rs.iter().map(|v| async move {
        fetch_thumb(st, &v.id).await                                                  
    })).await;
    let mut items: Vec<SheetItem> = vec![];
    for (i, (v, p)) in rs.iter().zip(fetched).enumerate() {
        if let Some(path) = p { items.push(SheetItem { n: i, title: v.title.clone(), duration: v.duration.clone(), thumb: path }); }
    }
    render_sheet(items).await
}

pub async fn make_sheet_images(st: &crate::AppState, rs: &[super::imgsearch::Img]) -> Result<Vec<u8>, String> {
    let fetched = futures::future::join_all(rs.iter().map(|im| async move { fetch_thumb(st, &im.thumb_src).await })).await;
    let mut items: Vec<SheetItem> = vec![];
    for (i, (im, p)) in rs.iter().zip(fetched).enumerate() {
        if let Some(path) = p { items.push(SheetItem { n: i, title: im.title.clone(), duration: String::new(), thumb: path }); }                                
    }
    render_sheet(items).await
}

async fn render_sheet(items: Vec<SheetItem>) -> Result<Vec<u8>, String> {
    if items.is_empty() { return Err("no thumbnails".into()); }                 
    let dir = std::env::temp_dir().join(format!("rjsheet-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).map_err(|_| "sheet render failed".to_string())?;
    let r = render_sheet_in(&dir, &items).await;
    for it in &items { let _ = std::fs::remove_file(&it.thumb); }
    let _ = std::fs::remove_dir_all(&dir);
    r
}

async fn render_sheet_in(dir: &std::path::Path, items: &[SheetItem]) -> Result<Vec<u8>, String> {
    let cols: i64 = 2;                          
    let rows = (items.len() as i64 + cols - 1) / cols;
    let w = M * 2 + TW * cols + G * (cols - 1);
    let h = M * 2 + CH * rows + G * (rows - 1);
    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-f".into(), "lavfi".into(), "-i".into(), format!("color=c=0x0d0e12:s={w}x{h}")];
    let dur_re = regex::Regex::new(r"^[0-9:]{3,9}$").unwrap();
    let mut parts: Vec<String> = vec![];
    let mut last = "0:v".to_string();
    for (k, it) in items.iter().enumerate() {
        args.push("-i".into());
        args.push(it.thumb.to_string_lossy().into_owned());
        let inp = k + 1;
        let (l1, l2) = wrap(&esc(&it.title));
        let wf = |n: &str, txt: &str| std::fs::write(dir.join(format!("{n}{k}.txt")), txt).map_err(|_| "sheet render failed".to_string());
        wf("n", &(it.n + 1).to_string())?; wf("a", &l1)?; wf("b", &l2)?;
        let dur = if dur_re.is_match(&it.duration) { it.duration.clone() } else { String::new() };
        if !dur.is_empty() { wf("d", &dur)?; }
        let dt = |file: &str, font: &str, size: i64, x: String, y: String, col: &str|
            format!("drawtext=fontfile={font}:textfile={}:fontsize={size}:fontcolor={col}:x={x}:y={y}", dir.join(format!("{file}{k}.txt")).display());
        let pw = if dur.is_empty() { 0 } else { 18 + (dur.len() as f64 * 13.2).round() as i64 };
        let ph: i64 = 30; let px = TW - pw - 10; let py = TH - ph - 10;
        let mut c = format!("[{inp}:v]scale={TW}:{TH}:force_original_aspect_ratio=increase,crop={TW}:{TH},setsar=1,format=yuv420p,split={}[b{k}][t{k}]", if dur.is_empty() { 2 } else { 3 });
        if !dur.is_empty() { c.push_str(&format!("[u{k}]")); }
        c.push(';');
                              
        c.push_str(&format!("[b{k}]crop=44:44:10:10,gblur=sigma=10,eq=brightness=-0.32:contrast=0.85:saturation=1.1,{}[gc{k}];", rnd(44, 44, 22)));
        c.push_str(&format!("[t{k}][gc{k}]overlay=10:10,{}", dt("n", F, 24, "10+(44-text_w)/2".into(), "10+(44-text_h)/2-1".into(), "white")));
        if !dur.is_empty() {
            c.push_str(&format!("[m{k}];[u{k}]crop={pw}:{ph}:{px}:{py},gblur=sigma=10,eq=brightness=-0.38:contrast=0.85:saturation=1.1,{}[gd{k}];", rnd(pw, ph, 15)));
            c.push_str(&format!("[m{k}][gd{k}]overlay={px}:{py},{}", dt("d", F, 18, format!("{px}+({pw}-text_w)/2"), format!("{py}+({ph}-text_h)/2-1"), "white")));
        }
        c.push_str(&format!(",pad={TW}:{CH}:0:0:color=0x1b1c23,{},{},{}[card{k}]",
            dt("a", FR, 16, "12".into(), (TH + 11).to_string(), "0xf4f4f7"),
            dt("b", FR, 16, "12".into(), (TH + 33).to_string(), "0x9a9ba6"),
            rnd(TW, CH, 16)));
        parts.push(c);
        let x = M + (k as i64 % cols) * (TW + G);
        let y = M + (k as i64 / cols) * (CH + G);
        parts.push(format!("[{last}][card{k}]overlay={x}:{y}:format=auto[o{k}]"));
        last = format!("o{k}");
    }
    let out = dir.join("out.jpg");
    args.extend(["-filter_complex".into(), parts.join(";"), "-map".into(), format!("[{last}]"),
                 "-frames:v".into(), "1".into(), "-q:v".into(), "3".into(), "-f".into(), "mjpeg".into(), out.to_string_lossy().into_owned()]);
                                                                                   
    let mut cmd = tokio::process::Command::new("nice");
    cmd.args(["-n", "10", "ffmpeg", "-y"]).args(&args).kill_on_drop(true);
    let o = match tokio::time::timeout(std::time::Duration::from_secs(25), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("sheet render failed: {e}")),
        Err(_) => return Err("sheet render failed".into()),
    };
                                                                                                                  
    if !o.status.success() {
        let se = String::from_utf8_lossy(&o.stderr);
        return Err(format!("ffmpeg {}", se.chars().take(300).collect::<String>()));
    }
    std::fs::read(&out).map_err(|_| "sheet render failed".to_string())
}

pub async fn message_image(text: &str) -> Result<Vec<u8>, String> {
                                                                                          
                                                                                     
    let clean: String = text.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | ',')).collect();
    let out = tokio::process::Command::new("ffmpeg")
        .args(["-v", "error", "-f", "lavfi", "-i", "color=c=0x0d0e12:s=632x220",
               "-vf", &format!("drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='{}':fontsize=30:fontcolor=0xffa028:x=(w-text_w)/2:y=(h-text_h)/2", clean),
               "-frames:v", "1", "-q:v", "4", "-f", "mjpeg", "pipe:1"]).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() || out.stdout.is_empty() { return Err("msg image".into()); }                   
    Ok(out.stdout)
}

pub fn unused(_: &HashMap<String, String>) {}
