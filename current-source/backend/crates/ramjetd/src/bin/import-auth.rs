                                                                               
                                                                               
use ramjetd::auth_api::store::AuthStore;
use serde::Deserialize;
use serde_json::Value;
#[derive(Deserialize)]#[serde(deny_unknown_fields)]
struct Plan{expected_input_sessions:usize,expected_retained_sessions:usize,exclude_names:Vec<String>,confirmed_pattern_names:Vec<String>}
fn main(){if let Err(e)=run(){eprintln!("import failed: {e}");std::process::exit(1)}}
fn run()->Result<(),String>{
 let args:Vec<_>=std::env::args().collect();if args.len()!=5{return Err("usage: import-auth DB USERS SESSIONS PLAN_JSON".into())}
 let plan:Plan=serde_json::from_slice(&std::fs::read(&args[4]).map_err(|_|"plan unreadable")?).map_err(|_|"invalid import plan")?;
 let mut users:Value=serde_json::from_slice(&std::fs::read(&args[2]).map_err(|_|"users unreadable")?).map_err(|_|"bad users JSON")?;
 let mut sessions:Value=serde_json::from_slice(&std::fs::read(&args[3]).map_err(|_|"sessions unreadable")?).map_err(|_|"bad sessions JSON")?;
 filter(&mut users,&mut sessions,&plan)?;
 let s=AuthStore::open(std::path::Path::new(&args[1]))?;let(a,b)=s.import(&users,&sessions,plan.expected_retained_sessions)?;
 println!("import verified: accounts={a} session_digests={b}; excluded_names={}; no wipe",plan.exclude_names.len());Ok(())
}
fn filter(users:&mut Value,sessions:&mut Value,p:&Plan)->Result<(),String>{
 let u=users.as_object_mut().ok_or("bad users object")?;let s=sessions.as_object_mut().ok_or("bad sessions object")?;
 if s.len()!=p.expected_input_sessions{return Err("input session count mismatch".into())}
 let excluded:std::collections::HashSet<_>=p.exclude_names.iter().collect();let confirmed:std::collections::HashSet<_>=p.confirmed_pattern_names.iter().collect();
 if excluded.len()!=p.exclude_names.len()||confirmed.len()!=p.confirmed_pattern_names.len(){return Err("duplicate plan names".into())}
 for n in excluded.iter().chain(confirmed.iter()){if !u.contains_key(n.as_str()){return Err("plan names nonexistent account".into())}}
                                                                                 
                                                                           
 for n in u.keys(){if (n=="qah"||n.starts_with("fixture-"))&&!excluded.contains(n)&&!confirmed.contains(n){eprintln!("unconfirmed import name: {}",serde_json::to_string(n).unwrap());return Err("pattern names need exact confirmation".into())}}
 for n in &p.exclude_names{eprintln!("excluded import name: {}",serde_json::to_string(n).unwrap());u.remove(n);}
 s.retain(|_,v|v["user"].as_str().map(|n|!excluded.iter().any(|x|x.as_str()==n)).unwrap_or(true));
 if s.len()!=p.expected_retained_sessions{return Err("retained session count mismatch".into())}Ok(())
}
#[cfg(test)]mod tests{use super::*;use serde_json::json;#[test]fn exact_exclusions(){let mut u=json!({"fixture-real":{},"fixture-a":{},"qah":{},"qah-real":{}});let mut s=json!({"a":{"user":"fixture-a"},"b":{"user":"fixture-real"}});let mut p=Plan{expected_input_sessions:2,expected_retained_sessions:1,exclude_names:vec!["fixture-a".into(),"qah".into()],confirmed_pattern_names:vec![]};assert!(filter(&mut u.clone(),&mut s.clone(),&p).is_err());p.confirmed_pattern_names.push("fixture-real".into());filter(&mut u,&mut s,&p).unwrap();assert!(u.get("fixture-real").is_some());assert!(u.get("qah-real").is_some());assert_eq!(s.as_object().unwrap().len(),1);}}
