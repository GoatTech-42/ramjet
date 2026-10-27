                                                                            
use std::{collections::HashMap,sync::Mutex};
#[derive(Default)]
pub struct Rates{inner:Mutex<HashMap<String,Cell>>}
#[derive(Clone,Copy)]
struct Cell{start:i64,count:u32,until:i64,last:i64}
impl Rates{
 fn edit<T>(&self,key:String,f:impl FnOnce(&mut Cell,i64)->T)->T{
  let n=super::store::now();let mut m=self.inner.lock().unwrap_or_else(|e|e.into_inner());
  if !m.contains_key(&key)&&m.len()>=10000{if let Some(k)=m.iter().min_by_key(|(_,v)|v.last).map(|(k,_)|k.clone()){m.remove(&k);}}
  let e=m.entry(key).or_insert(Cell{start:n,count:0,until:0,last:n});e.last=n;f(e,n)
 }
 pub fn window(&self,key:String,limit:u32,ms:i64)->Option<u64>{self.edit(key,|e,n|{if n-e.start>ms{e.start=n;e.count=0}e.count=e.count.saturating_add(1);(e.count>limit).then_some(((ms-(n-e.start)+999)/1000).max(1)as u64)})}
 pub fn blocked(&self,key:String)->Option<u64>{self.edit(key,|e,n|{(e.until>n).then_some(((e.until-n+999)/1000).clamp(1,8)as u64)})}
 pub fn fail(&self,key:String){self.edit(key,|e,n|{if n-e.start>600000{e.start=n;e.count=0}e.count=e.count.saturating_add(1);e.until=n+((1u64<<e.count.min(3))as i64)*1000;});}
 pub fn reset(&self,key:&str){self.inner.lock().unwrap_or_else(|e|e.into_inner()).remove(key);}
}
pub fn client_ip(h:&axum::http::HeaderMap,peer:Option<std::net::SocketAddr>)->String{
 let Some(peer)=peer else{return "unknown".into()};
 let pin=std::env::var("RJ_TRUSTED_INGRESS").ok().and_then(|s|s.parse::<std::net::IpAddr>().ok());
 let hops=std::env::var("RJ_FORWARDED_HOPS").ok().and_then(|s|s.parse::<usize>().ok()).unwrap_or(0);
 if pin==Some(peer.ip())&&hops>0{let all:Vec<_>=h.get_all("x-forwarded-for").iter().collect();if all.len()==1{if let Ok(s)=all[0].to_str(){let parts:Vec<_>=s.split(',').map(str::trim).collect();if hops<=parts.len(){if let Ok(ip)=parts[parts.len()-hops].parse::<std::net::IpAddr>(){return ip.to_string()}}}}}
 peer.ip().to_string()
}
#[cfg(test)]mod tests{use super::*;#[test]fn bounded(){let r=Rates::default();for i in 0..10010{r.fail(format!("a{i}"))}assert_eq!(r.inner.lock().unwrap().len(),10000)}#[test]fn failure_and_reset(){let r=Rates::default();r.fail("acct:a".into());assert!(r.blocked("acct:a".into()).is_some());r.reset("acct:a");assert!(r.blocked("acct:a".into()).is_none());}}
