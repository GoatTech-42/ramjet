                                                                                                      
                                                                                                            
                                                                                                                   
                                                                                                                   
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

pub const REC_CAP: usize = 14;
pub const REC_TTL_MS: i64 = 10 * 60 * 1000;
pub const SHORTS_TTL_MS: i64 = 4 * 60 * 1000;
const FEED_CAP: usize = 200;                                                 
const SERVED_CAP: usize = 60;

                                                                                                         
#[derive(Clone, Debug, Default)]
pub struct Ranked { pub id: String, pub title: String, pub channel: String, pub channel_id: String, pub duration: String, pub views: String, pub published: String, pub desc: String, pub secs: Option<f64>, pub score: f64, pub ws: Option<f64> }
#[derive(Clone, Debug, Default)]
pub struct RecEntry { pub at: i64, pub n: u32, pub gen: u64, pub inflight: bool, pub ranked: Vec<Ranked> }
                                                                                                
                                                                                              
                                                                                                
static REC_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn next_rec_gen() -> u64 { REC_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) }
                                                 
#[derive(Clone, Debug, Default)]
pub struct ShortsEntry { pub at: i64, pub gen: u64, pub n: u32, pub served: VecDeque<String>, pub ranked: Vec<Ranked>, pub inflight: Option<u64> }

#[derive(Default)]
pub struct Feeds { rec: Vec<(String, RecEntry)>, shorts: Vec<(String, ShortsEntry)> }
fn ent<'a, T: Default>(m: &'a mut Vec<(String, T)>, u: &str) -> &'a mut T {
    if let Some(p) = m.iter().position(|(k, _)| k == u) { return &mut m[p].1; }
    m.push((u.to_string(), T::default()));
    if m.len() > FEED_CAP { m.remove(0); }
    let l = m.len() - 1; &mut m[l].1
}
impl Feeds {
    pub fn rec_entry(&mut self, u: &str) -> &mut RecEntry {
        if !self.rec.iter().any(|(k, _)| k == u) {
            self.rec.push((u.to_string(), RecEntry { gen: next_rec_gen(), ..Default::default() }));
            if self.rec.len() > FEED_CAP { self.rec.remove(0); }
            let l = self.rec.len() - 1; return &mut self.rec[l].1;
        }
        ent(&mut self.rec, u)
    }
                                                                                                       
    pub fn rec_claim(&mut self, u: &str) -> Option<(u64, usize)> {
        let h = self.rec_entry(u);
        if h.inflight { return None; }
        h.inflight = true; h.n += 1; Some((h.gen, h.n as usize))
    }
                                                                                                 
    pub fn rec_commit(&mut self, u: &str, gen: u64, r: Option<Vec<Ranked>>, at: i64) {
        let Some(p) = self.rec.iter().position(|(k, _)| k == u) else { return };
        let h = &mut self.rec[p].1;
        if h.gen != gen { return; }                                                            
        if let Some(r) = r { if !r.is_empty() { h.ranked = r; h.at = at; } }
        h.inflight = false;
    }
    pub fn shorts_entry(&mut self, u: &str) -> &mut ShortsEntry { ent(&mut self.shorts, u) }
    pub fn rec_peek(&self, u: &str) -> Option<&RecEntry> { self.rec.iter().find(|(k, _)| k == u).map(|x| &x.1) }
    pub fn shorts_peek(&self, u: &str) -> Option<&ShortsEntry> { self.shorts.iter().find(|(k, _)| k == u).map(|x| &x.1) }
                                 
    pub fn rec_delete(&mut self, u: &str) { self.rec.retain(|(k, _)| k != u); }
    pub fn rec_stale(&mut self, u: &str) { if let Some(p) = self.rec.iter().position(|(k, _)| k == u) { self.rec[p].1.at = 0; } }                                              
    pub fn rec_clear(&mut self) { self.rec.clear(); }
                                   
    fn bump(h: &mut ShortsEntry) { h.gen += 1; h.at = 0; }
                                                                                          
    pub fn shorts_invalidate(&mut self, u: &str) { if let Some(p) = self.shorts.iter().position(|(k, _)| k == u) { let h = &mut self.shorts[p].1; Self::bump(h); h.ranked.clear(); } }
                                                                               
    pub fn shorts_touch(&mut self, u: &str) { if let Some(p) = self.shorts.iter().position(|(k, _)| k == u) { Self::bump(&mut self.shorts[p].1); } }
                                                                          
    pub fn shorts_reset(&mut self, u: &str) { self.shorts.retain(|(k, _)| k != u); }
    pub fn shorts_clear(&mut self) { for (_, h) in self.shorts.iter_mut() { Self::bump(h); h.ranked.clear(); } }
    pub fn shorts_serve(&mut self, u: &str, ids: &[String]) {
        let Some(p) = self.shorts.iter().position(|(k, _)| k == u) else { return };
        let h = &mut self.shorts[p].1;
        let mut have: HashSet<String> = h.served.iter().cloned().collect();
        for id in ids { if have.insert(id.clone()) { h.served.push_back(id.clone()); } }
        while h.served.len() > SERVED_CAP { h.served.pop_front(); }
    }
}
pub static FEEDS: Mutex<Option<Feeds>> = Mutex::new(None);
fn with<R>(f: impl FnOnce(&mut Feeds) -> R) -> R { let mut g = FEEDS.lock().unwrap_or_else(|e| e.into_inner()); f(g.get_or_insert_with(Feeds::default)) }

                                                                        
                                                                 
pub fn on_outcome(u: &str) { with(|f| { f.rec_stale(u); f.shorts_touch(u); }) }
                                                                                    
pub fn on_taste_change(u: &str) { with(|f| { f.rec_delete(u); f.shorts_invalidate(u); }) }
                        
pub fn on_clear_all(u: &str) { with(|f| { f.rec_delete(u); f.shorts_reset(u); }) }
                                                                              
pub fn on_dead() { with(|f| { f.rec_clear(); f.shorts_clear(); }) }
pub fn with_feeds<R>(f: impl FnOnce(&mut Feeds) -> R) -> R { with(f) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hooks_follow_r32_semantics() {
        let mut f = Feeds::default();
        f.rec_entry("u").at = 5; f.rec_entry("v").at = 6;
        { let h = f.shorts_entry("u"); h.at = 9; h.ranked = vec![Ranked::default()]; h.served.push_back("s1".into()); }
        f.shorts_serve("u", &["s2".into(), "s1".into()]);
        assert_eq!(f.shorts_peek("u").unwrap().served.iter().cloned().collect::<Vec<_>>(), vec!["s1", "s2"]);
        f.rec_stale("u"); assert_eq!(f.rec_peek("u").unwrap().at, 0); assert_eq!(f.rec_peek("v").unwrap().at, 6);
        f.shorts_touch("u"); { let h = f.shorts_peek("u").unwrap(); assert_eq!((h.gen, h.at, h.ranked.len()), (1, 0, 1)); }                          
        f.shorts_invalidate("u"); { let h = f.shorts_peek("u").unwrap(); assert_eq!((h.gen, h.ranked.len(), h.served.len()), (2, 0, 2)); }                                             
        f.rec_delete("u"); assert!(f.rec_peek("u").is_none());
        f.shorts_reset("u"); assert!(f.shorts_peek("u").is_none());
                                      
        f.shorts_entry("w"); let ids: Vec<String> = (0..70).map(|i| format!("i{i}")).collect(); f.shorts_serve("w", &ids);
        let h = f.shorts_peek("w").unwrap(); assert_eq!((h.served.len(), h.served.front().unwrap().as_str()), (60, "i10"));
                                         
        for i in 0..201 { f.rec_entry(&format!("x{i}")); }
        assert!(f.rec_peek("x0").is_none() && f.rec_peek("x200").is_some());
    }
}
