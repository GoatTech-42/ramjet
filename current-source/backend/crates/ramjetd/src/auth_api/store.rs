                                                                                 
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};
use serde_json::Value;
pub const SCHEMA_SQL: &str = include_str!("schema.sql");
pub fn now() -> i64 { crate::apps::millis() }
pub fn digest(t: &str) -> Vec<u8> { Sha256::digest(t.as_bytes()).to_vec() }
pub fn token() -> String { use base64::Engine; let mut b=[0;32]; rand::RngCore::fill_bytes(&mut rand::thread_rng(),&mut b); base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b) }
pub enum Lookup { Valid(String), Denied, Unknown }
pub enum Login { Ok(String), Bad, Pending, Banned }
pub struct AuthStore { conn: Mutex<Connection>, en_cache: Mutex<std::collections::HashMap<String,(bool,std::time::Instant)>> }
fn sqlerr(_: rusqlite::Error) -> String { "auth storage failure".into() }
                                                                                  
                                                                            
fn cookie_status(s: Option<&str>) -> bool { matches!(s, None|Some("")|Some("active")|Some("approved")) }
fn audit_revoke(tx: &Transaction<'_>, id: &str, event: Option<&str>) -> rusqlite::Result<()> {
 let n=now();
 tx.execute("INSERT INTO revocation_audit(account_id,token_digest,event,occurred_ms) SELECT account_id,token_digest,'session_revoked',?2 FROM sessions WHERE account_id=?1 AND revoked_ms IS NULL",params![id,n])?;
 tx.execute("UPDATE sessions SET revoked_ms=?2 WHERE account_id=?1 AND revoked_ms IS NULL",params![id,n])?;
 if let Some(e)=event { tx.execute("INSERT INTO revocation_audit(account_id,token_digest,event,occurred_ms) VALUES(?1,NULL,?2,?3)",params![id,e,n])?; }
 Ok(())
}
fn session_insert(tx: &Transaction<'_>, id: &str, t: &str, created: i64, expires: i64) -> rusqlite::Result<()> {
 tx.execute("INSERT INTO sessions(account_id,token_digest,created_ms,expires_ms,last_active_ms,revoked_ms) VALUES(?1,?2,?3,?4,?3,NULL)",params![id,digest(t),created,expires])?; Ok(())
}
                                                                                
                                                                                    
pub fn pair_now()->i64{
 static CLOCK:std::sync::OnceLock<(i64,std::time::Instant)>=std::sync::OnceLock::new();let(wall,tick)=CLOCK.get_or_init(||(now(),std::time::Instant::now()));wall.saturating_add(tick.elapsed().as_millis().min(i64::MAX as u128) as i64)
}
const PAIR_TERMINAL_RETAIN_MS:i64=3600000;                                 
fn pair_expire(tx:&Transaction<'_>,n:i64)->rusqlite::Result<()> {
                                                                                            
 tx.execute("DELETE FROM devices WHERE device_id IN (SELECT device_id FROM pairing_requests WHERE state='approved' AND expires_ms<=?1)",params![n])?;
 tx.execute("INSERT OR REPLACE INTO pairing_meta(poll_id,client_id,terminal) SELECT p.poll_id,m.client_id,'expired' FROM pairing_requests p LEFT JOIN pairing_meta m ON m.poll_id=p.poll_id WHERE p.state IN ('pending','approved') AND p.expires_ms<=?1",params![n])?;
 tx.execute("UPDATE pairing_requests SET state='denied' WHERE state IN ('pending','approved') AND expires_ms<=?1",params![n])?;
 tx.execute("DELETE FROM pairing_meta WHERE poll_id IN (SELECT poll_id FROM pairing_requests WHERE state IN ('denied','consumed') AND expires_ms<?1 ORDER BY expires_ms LIMIT 500)",params![n-PAIR_TERMINAL_RETAIN_MS])?;
 tx.execute("DELETE FROM pairing_requests WHERE poll_id IN (SELECT poll_id FROM pairing_requests WHERE state IN ('denied','consumed') AND expires_ms<?1 ORDER BY expires_ms LIMIT 500)",params![n-PAIR_TERMINAL_RETAIN_MS])?;
 tx.execute("DELETE FROM pairing_meta WHERE poll_id IN (SELECT m.poll_id FROM pairing_meta m LEFT JOIN pairing_requests p ON p.poll_id=m.poll_id WHERE p.poll_id IS NULL LIMIT 500)",[])?;Ok(())
}
impl AuthStore {
 pub fn open(p: &Path) -> Result<Self,String> {
  use std::os::unix::fs::MetadataExt;
  let meta=p.symlink_metadata().map_err(|_|"auth DB missing")?;
  if !meta.is_file()||meta.mode()&0o777!=0o600||meta.uid()!=unsafe{libc::geteuid()}{return Err("auth DB owner/mode mismatch".into())}
  let c=Connection::open_with_flags(p,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE|rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(sqlerr)?;
  c.execute_batch(SCHEMA_SQL).map_err(sqlerr)?; c.busy_timeout(std::time::Duration::from_secs(3)).map_err(sqlerr)?;
  Ok(Self{conn:Mutex::new(c),en_cache:Mutex::new(std::collections::HashMap::new())})
 }
 pub fn lookup(&self,t:&str)->Result<Lookup,String> {
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  let row=c.query_row("SELECT s.account_id,s.expires_ms,s.revoked_ms,a.username,a.status FROM sessions s LEFT JOIN accounts a ON s.account_id=a.account_id WHERE token_digest=?1",params![digest(t)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<i64>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))).optional().map_err(sqlerr)?;
  Ok(match row {None=>Lookup::Unknown,Some((_,exp,rev,Some(name),status)) if rev.is_none()&&exp>=now()&&cookie_status(status.as_deref())=>Lookup::Valid(name),_=>Lookup::Denied})
 }
 pub fn user(&self,t:&str)->Option<String>{match self.lookup(t).ok()? {Lookup::Valid(u)=>Some(u),_=>None}}
 pub fn user_enabled(&self,name:&str)->bool{
                                                                                                   
                                                                                               
                                                                 
  {
   let mut m=self.en_cache.lock().unwrap_or_else(|e|e.into_inner());
   if let Some((v,at))=m.get(name){if at.elapsed()<std::time::Duration::from_secs(60){return *v}}
   m.retain(|_,(_,at)|at.elapsed()<std::time::Duration::from_secs(300));
   let c=match self.conn.lock(){Ok(c)=>c,Err(_)=>return false};
   let v=c.query_row("SELECT status FROM accounts WHERE username=?1",params![name],|r|r.get::<_,Option<String>>(0)).optional().ok().flatten().map(|s|cookie_status(s.as_deref())).unwrap_or(false);
   drop(c);m.insert(name.to_string(),(v,std::time::Instant::now()));v
  }
 }
 pub fn login(&self,u:&str,p:&str)->Result<Login,String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  let row=c.query_row("SELECT account_id,password_salt_ascii,password_key_hex,status FROM accounts WHERE username=?1",params![u],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?))).optional().map_err(sqlerr)?;
  let Some((id,s,k,status))=row else {let _=rj_crypto::verify_r32_password(p,"00000000000000000000000000000000",&"00".repeat(32));return Ok(Login::Bad)};
  if !rj_crypto::verify_r32_password(p,&s,&k){return Ok(Login::Bad)}
  Ok(match status.as_deref(){Some("pending")=>Login::Pending,Some("banned")=>Login::Banned,s if cookie_status(s)=>Login::Ok(id),_=>Login::Bad})
 }
 pub fn issue(&self,id:&str)->Result<String,String>{
  let t=token();let n=now();let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;
  session_insert(&tx,id,&t,n,n+2592000000).map_err(sqlerr)?;tx.execute("UPDATE activity SET last_active_ms=?2 WHERE account_id=?1",params![id,n]).map_err(sqlerr)?;tx.commit().map_err(sqlerr)?;Ok(t)
 }
 pub fn logout(&self,t:&str)->Result<(),String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let d=digest(t);let n=now();
  tx.execute("INSERT INTO revocation_audit(account_id,token_digest,event,occurred_ms) SELECT account_id,token_digest,'session_revoked',?2 FROM sessions WHERE token_digest=?1 AND revoked_ms IS NULL",params![d,n]).map_err(sqlerr)?;
  tx.execute("UPDATE sessions SET revoked_ms=?2 WHERE token_digest=?1 AND revoked_ms IS NULL",params![d,n]).map_err(sqlerr)?;tx.commit().map_err(sqlerr)
 }
 pub fn verify_password(&self,t:&str,p:&str)->Option<bool>{let u=self.user(t)?;let c=self.conn.lock().ok()?;let(s,k)=c.query_row("SELECT password_salt_ascii,password_key_hex FROM accounts WHERE username=?1",params![u],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).ok()?;Some(rj_crypto::verify_r32_password(p,&s,&k))}
 pub fn password(&self,t:&str,old:&str,new:&str)->Result<String,String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;
  let (id,s,k,status,exp,rev)=tx.query_row("SELECT a.account_id,a.password_salt_ascii,a.password_key_hex,a.status,s.expires_ms,s.revoked_ms FROM sessions s JOIN accounts a ON a.account_id=s.account_id WHERE token_digest=?1",params![digest(t)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,i64>(4)?,r.get::<_,Option<i64>>(5)?))).map_err(sqlerr)?;
  if rev.is_some()||exp<now()||!cookie_status(status.as_deref())||!rj_crypto::verify_r32_password(old,&s,&k){return Err("current password is wrong".into())}
  let salt=crate::apps::hex_id(16).ok_or("random unavailable")?;let key=rj_crypto::hash_r32_password(new,&salt);let nt=token();let n=now();
  tx.execute("UPDATE accounts SET password_salt_ascii=?2,password_key_hex=?3 WHERE account_id=?1",params![id,salt,key]).map_err(sqlerr)?;
  audit_revoke(&tx,&id,Some("password_rotated")).map_err(sqlerr)?;session_insert(&tx,&id,&nt,n,n+2592000000).map_err(sqlerr)?;tx.commit().map_err(sqlerr)?;Ok(nt)
 }
 pub fn claim(&self,u:&str,p:&str,pending:bool)->Result<(),String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;
  let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE username=?1) OR EXISTS(SELECT 1 FROM username_tombstones WHERE username=?1)",params![u],|r|r.get(0)).map_err(sqlerr)?;if exists{return Err("that name is taken".into())}
  if pending&&tx.query_row("SELECT count(*) FROM accounts WHERE status='pending'",[],|r|r.get::<_,i64>(0)).map_err(sqlerr)? >=25{return Err("too many requests waiting right now - try again later".into())}
  let salt=crate::apps::hex_id(16).ok_or("random unavailable")?;let key=rj_crypto::hash_r32_password(p,&salt);let n=now();
                                                           
  tx.execute("INSERT INTO accounts(account_id,username,password_scheme,password_salt_ascii,password_key_hex,status,created_ms,legacy_record) VALUES(?1,?1,'scrypt-r32',?2,?3,?4,?5,X'')",params![u,salt,key,if pending{"pending"}else{"active"},n]).map_err(sqlerr)?;
  tx.execute("INSERT INTO storage_meter VALUES(?1,268435456,0)",params![u]).map_err(sqlerr)?;tx.execute("INSERT INTO activity(account_id,last_active_ms,idle_wipe_due_ms) VALUES(?1,?2,?3)",params![u,n,n+604800000]).map_err(sqlerr)?;tx.commit().map_err(sqlerr)
 }
 pub fn list(&self)->Result<Vec<Value>,String>{let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let mut q=c.prepare("SELECT username,status,created_ms FROM accounts ORDER BY created_ms DESC,rowid ASC").map_err(sqlerr)?;let rows=q.query_map([],|r|{let s:Option<String>=r.get(1)?;Ok(serde_json::json!({"name":r.get::<_,String>(0)?,"status":s.filter(|s|!s.is_empty()).unwrap_or("active".into()),"created":r.get::<_,i64>(2)?}))}).map_err(sqlerr)?;rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sqlerr)}
 pub fn admin(&self,u:&str,op:&str)->Result<bool,String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;
  let id:Option<String>=tx.query_row("SELECT account_id FROM accounts WHERE username=?1",params![u],|r|r.get(0)).optional().map_err(sqlerr)?;let Some(id)=id else{return Ok(false)};
  match op {"approve"|"unban"=>{tx.execute("UPDATE accounts SET status='approved' WHERE account_id=?1",params![id]).map_err(sqlerr)?;},"ban"=>{audit_revoke(&tx,&id,Some("account_banned")).map_err(sqlerr)?;tx.execute("UPDATE accounts SET status='banned' WHERE account_id=?1",params![id]).map_err(sqlerr)?;},"logout"=>audit_revoke(&tx,&id,None).map_err(sqlerr)?,"remove"=>{
   audit_revoke(&tx,&id,Some("account_removed")).map_err(sqlerr)?;
   tx.execute("INSERT OR IGNORE INTO username_tombstones(account_id,username,retired_ms) VALUES(?1,?2,?3)",params![id,u,now()]).map_err(sqlerr)?;
   for table in ["sessions","settings","history","bookmarks","playlists","conversations","activity","storage_meter","import_members"]{
    tx.execute(&format!("DELETE FROM {table} WHERE account_id=?1"),params![id]).map_err(sqlerr)?;
   }
   tx.execute("DELETE FROM accounts WHERE account_id=?1",params![id]).map_err(sqlerr)?;
  },_=>return Err("not found".into())};tx.commit().map_err(sqlerr)?;Ok(true)
 }
 pub fn touch(&self,username:&str)->Result<(),String>{let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;c.execute("UPDATE activity SET last_active_ms=?2 WHERE account_id=(SELECT account_id FROM accounts WHERE username=?1)",params![username,now()]).map_err(sqlerr)?;Ok(())}
                                            
 pub fn pair_create(&self,poll:&str,code:&str,name:&str,expires:i64)->Result<(),String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let n=pair_now();
  c.execute("DELETE FROM pairing_requests WHERE expires_ms<?1 AND state='pending'",params![n]).map_err(sqlerr)?;
  c.execute("INSERT INTO pairing_requests(poll_id,code,name,created_ms,expires_ms,state) VALUES(?1,?2,?3,?4,?5,'pending')",params![poll,code,name,n,expires]).map_err(sqlerr)?;Ok(())
 }
 pub fn pair_pending_by_code(&self,code:&str)->Result<Option<(String,String)>,String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.query_row("SELECT poll_id,name FROM pairing_requests WHERE code=?1 AND state='pending' AND expires_ms>?2 ORDER BY created_ms DESC LIMIT 1",params![code,pair_now()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(sqlerr)
 }
 pub fn pair_state(&self,poll:&str)->Result<Option<(String,String,i64)>,String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.query_row("SELECT state,name,expires_ms FROM pairing_requests WHERE poll_id=?1",params![poll],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).optional().map_err(sqlerr)
 }
 pub fn pair_mark(&self,poll:&str,state:&str,account:Option<&str>,device:Option<&str>)->Result<(),String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.execute("UPDATE pairing_requests SET state=?2,account_id=COALESCE(?3,account_id),device_id=COALESCE(?4,device_id) WHERE poll_id=?1",params![poll,state,account,device]).map_err(sqlerr)?;Ok(())
 }
                                                                                            
 pub fn pair_sweep(&self)->Result<(),String>{self.pair_sweep_removed().map(|_|())}
 pub fn pair_sweep_removed(&self)->Result<usize,String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let n=pair_now();
  let removed=tx.query_row("SELECT count(*) FROM pairing_requests WHERE state='approved' AND expires_ms<=?1",params![n],|r|r.get::<_,i64>(0)).map_err(sqlerr)?;
  pair_expire(&tx,n).map_err(sqlerr)?;tx.commit().map_err(sqlerr)?;Ok(removed as usize)
 }
 pub fn pair_create_scoped(&self,poll:&str,code:&str,name:&str,expires:i64,client:Option<&str>)->Result<(),String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let n=pair_now();pair_expire(&tx,n).map_err(sqlerr)?;
  if let Some(client)=client {
   tx.execute("INSERT OR REPLACE INTO pairing_meta(poll_id,client_id,terminal) SELECT p.poll_id,?1,'superseded' FROM pairing_requests p JOIN pairing_meta m ON p.poll_id=m.poll_id WHERE m.client_id=?1 AND p.state='pending' AND m.terminal IS NULL",params![client]).map_err(sqlerr)?;
   tx.execute("UPDATE pairing_requests SET state='denied' WHERE state='pending' AND poll_id IN (SELECT poll_id FROM pairing_meta WHERE terminal='superseded')",[]).map_err(sqlerr)?;
  }
  tx.execute("INSERT INTO pairing_requests(poll_id,code,name,created_ms,expires_ms,state) VALUES(?1,?2,?3,?4,?5,'pending')",params![poll,code,name,n,expires]).map_err(sqlerr)?;
  tx.execute("INSERT INTO pairing_meta(poll_id,client_id) VALUES(?1,?2)",params![poll,client]).map_err(sqlerr)?;tx.commit().map_err(sqlerr)
 }
 pub fn pair_info(&self,poll:&str)->Result<Option<(String,String,i64)>,String>{
  self.pair_sweep()?;let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.query_row("SELECT COALESCE(m.terminal,p.state),p.name,p.expires_ms FROM pairing_requests p LEFT JOIN pairing_meta m ON m.poll_id=p.poll_id WHERE p.poll_id=?1",params![poll],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sqlerr)
 }
 pub fn pair_code_info(&self,code:&str)->Result<Option<(String,String,String)>,String>{
  self.pair_sweep()?;let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.query_row("SELECT p.poll_id,COALESCE(m.terminal,p.state),p.name FROM pairing_requests p LEFT JOIN pairing_meta m ON m.poll_id=p.poll_id WHERE p.code=?1 ORDER BY p.created_ms DESC,p.rowid DESC LIMIT 1",params![code],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sqlerr)
 }
 pub fn pair_approve_atomic(&self,poll:&str,user:&str,id:&str,token:&str)->Result<bool,String>{
  self.pair_approve_at(poll,user,id,token,None)
 }
 fn pair_approve_at(&self,poll:&str,user:&str,id:&str,token:&str,at:Option<i64>)->Result<bool,String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let n=at.unwrap_or_else(pair_now);pair_expire(&tx,n).map_err(sqlerr)?;
  let name:Option<String>=tx.query_row("SELECT name FROM pairing_requests WHERE poll_id=?1 AND state='pending' AND expires_ms>?2 AND NOT EXISTS(SELECT 1 FROM pairing_meta WHERE poll_id=?1 AND terminal IS NOT NULL)",params![poll,n],|r|r.get(0)).optional().map_err(sqlerr)?;
  let Some(name)=name else{tx.commit().map_err(sqlerr)?;return Ok(false)};
  tx.execute("INSERT INTO devices(device_id,account_id,name,scopes,token_digest,created_ms) VALUES(?1,?2,?3,'roku',?4,?5)",params![id,user,name,digest(token),n]).map_err(sqlerr)?;
  tx.execute("UPDATE pairing_requests SET state='approved',account_id=?2,device_id=?3 WHERE poll_id=?1",params![poll,user,id]).map_err(sqlerr)?;tx.commit().map_err(sqlerr)?;Ok(true)
 }
 pub fn pair_deny_atomic(&self,poll:&str)->Result<bool,String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let n=pair_now();pair_expire(&tx,n).map_err(sqlerr)?;
  let changed=tx.execute("UPDATE pairing_requests SET state='denied' WHERE poll_id=?1 AND state='pending' AND expires_ms>?2",params![poll,n]).map_err(sqlerr)?;tx.commit().map_err(sqlerr)?;Ok(changed==1)
 }
 pub fn pair_consume_atomic(&self,poll:&str)->Result<bool,String>{
  self.pair_consume_at(poll,None)
 }
 fn pair_consume_at(&self,poll:&str,at:Option<i64>)->Result<bool,String>{
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let n=at.unwrap_or_else(pair_now);pair_expire(&tx,n).map_err(sqlerr)?;
  let changed=tx.execute("UPDATE pairing_requests SET state='consumed' WHERE poll_id=?1 AND state='approved' AND expires_ms>?2 AND EXISTS(SELECT 1 FROM devices d WHERE d.device_id=pairing_requests.device_id AND d.revoked_ms IS NULL)",params![poll,n]).map_err(sqlerr)?;
  tx.commit().map_err(sqlerr)?;Ok(changed==1)
 }
 pub fn device_insert(&self,id:&str,account:&str,name:&str,scopes:&str,token:&str)->Result<(),String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.execute("INSERT INTO devices(device_id,account_id,name,scopes,token_digest,created_ms) VALUES(?1,?2,?3,?4,?5,?6)",params![id,account,name,scopes,digest(token),now()]).map_err(sqlerr)?;Ok(())
 }
 pub fn device_resolve(&self,token:&str)->Result<Option<(String,String)>,String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.query_row("SELECT account_id,device_id FROM devices WHERE token_digest=?1 AND revoked_ms IS NULL",params![digest(token)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(sqlerr)
 }
 pub fn device_list(&self,account:&str)->Result<Vec<(String,String,i64,Option<i64>)>,String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  let mut q=c.prepare("SELECT device_id,name,created_ms,last_used_ms FROM devices WHERE account_id=?1 AND revoked_ms IS NULL ORDER BY created_ms DESC,rowid ASC").map_err(sqlerr)?;
  let rows=q.query_map(params![account],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<i64>>(3)?))).map_err(sqlerr)?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sqlerr)
 }
 pub fn device_revoke(&self,account:&str,id:&str)->Result<bool,String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  let n=c.execute("UPDATE devices SET revoked_ms=?3 WHERE account_id=?1 AND device_id=?2 AND revoked_ms IS NULL",params![account,id,now()]).map_err(sqlerr)?;Ok(n>0)
 }
 pub fn device_active(&self,user:&str,id:&str)->bool{
  let Ok(c)=self.conn.lock()else{return false};
  c.query_row("SELECT 1 FROM devices WHERE account_id=?1 AND device_id=?2 AND revoked_ms IS NULL",params![user,id],|r|r.get::<_,i64>(0)).optional().ok().flatten().is_some()
 }
 pub fn device_touch(&self,id:&str)->Result<(),String>{
  let c=self.conn.lock().map_err(|_|"auth storage unavailable")?;
  c.execute("UPDATE devices SET last_used_ms=?2 WHERE device_id=?1 AND revoked_ms IS NULL",params![id,now()]).map_err(sqlerr)?;Ok(())
 }
 pub fn verify_lite(&self,u:&str,p:&str)->bool{
  let Ok(c)=self.conn.lock()else{return false};
  let row=c.query_row("SELECT password_salt_ascii,password_key_hex,status FROM accounts WHERE username=?1",params![u.to_lowercase()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional();
  match row{Ok(Some((s,k,status)))=>matches!(status.as_deref(),None|Some("")|Some("approved")|Some("active"))&&rj_crypto::verify_r32_password(p,&s,&k),_=>{let _=rj_crypto::verify_r32_password(p,"00000000000000000000000000000000",&"00".repeat(32));false}}
 }
 pub fn import(&self,users:&Value,sessions:&Value,expected:usize)->Result<(usize,usize),String>{
  let users=users.as_object().ok_or("bad users")?;let sessions=sessions.as_object().ok_or("bad sessions")?;if sessions.len()!=expected{return Err("session count mismatch".into())}
  let mut c=self.conn.lock().map_err(|_|"auth storage unavailable")?;let tx=c.transaction().map_err(sqlerr)?;let n=now();
  for(u,v)in users{
   let salt=v["salt"].as_str().ok_or("missing salt")?;let key=v["key"].as_str().ok_or("missing key")?;
   if salt.len()!=32||key.len()!=64||!salt.bytes().all(|b|b.is_ascii_hexdigit())||!key.bytes().all(|b|b.is_ascii_hexdigit()){return Err("bad password material".into())}
   let removed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM revocation_audit WHERE account_id=?1 AND event='account_removed')",params![u],|r|r.get(0)).map_err(sqlerr)?;
   if removed{return Err("removed account in import".into())}
   let status=match v.get("status"){None=>None,Some(Value::String(s))=>Some(s.as_str()),_=>return Err("bad status".into())};
   tx.execute("INSERT OR IGNORE INTO accounts(account_id,username,password_scheme,password_salt_ascii,password_key_hex,status,created_ms,legacy_record) VALUES(?1,?1,'scrypt-r32',?2,?3,?4,?5,?6)",params![u,salt,key,status,v["created"].as_i64().unwrap_or(0),serde_json::to_vec(v).map_err(|_|"bad user")?]).map_err(sqlerr)?;
   tx.execute("INSERT OR IGNORE INTO storage_meter VALUES(?1,268435456,0)",params![u]).map_err(sqlerr)?;tx.execute("INSERT OR IGNORE INTO activity(account_id,last_active_ms,idle_wipe_due_ms) VALUES(?1,?2,?3)",params![u,n,n+604800000]).map_err(sqlerr)?;
  }
  for(t,v)in sessions{
   let u=v["user"].as_str().ok_or("bad session user")?;let created=v["created"].as_i64().ok_or("bad session created")?;let exp=v["expires"].as_i64().ok_or("bad session expiry")?;
   if !users.contains_key(u){return Err("session account missing".into())}
   let denied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM revocation_audit WHERE account_id=?1 AND (event IN ('account_banned','account_removed','password_rotated') OR token_digest=?2))",params![u,digest(t)],|r|r.get(0)).map_err(sqlerr)?;
   if denied { tx.execute("INSERT INTO sessions(account_id,token_digest,created_ms,expires_ms,last_active_ms,revoked_ms) VALUES(?1,?2,?3,?4,?3,?5) ON CONFLICT(token_digest) DO NOTHING",params![u,digest(t),created,exp,n]).map_err(sqlerr)?; }
   else { tx.execute("INSERT INTO sessions(account_id,token_digest,created_ms,expires_ms,last_active_ms,revoked_ms) VALUES(?1,?2,?3,?4,?3,NULL) ON CONFLICT(token_digest) DO NOTHING",params![u,digest(t),created,exp]).map_err(sqlerr)?; }
                                                                               
   let row=tx.query_row("SELECT account_id,created_ms,expires_ms FROM sessions WHERE token_digest=?1",params![digest(t)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?))).map_err(sqlerr)?;
   if row!=(u.to_string(),created,exp){return Err("session verification mismatch".into())}
  }
                                                                              
                                                                        
  for(t,v)in sessions{
   let row=tx.query_row("SELECT a.username,a.status,s.created_ms,s.expires_ms,s.revoked_ms FROM sessions s JOIN accounts a ON a.account_id=s.account_id WHERE s.token_digest=?1",params![digest(t)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,Option<i64>>(4)?))).map_err(sqlerr)?;
   if row.0!=v["user"].as_str().ok_or("bad user")?||row.2!=v["created"].as_i64().ok_or("bad created")?||row.3!=v["expires"].as_i64().ok_or("bad expires")?{return Err("whole-batch verification mismatch".into())}
                                                                               
                                                                               
   let eligible=row.4.is_none()&&row.3>=now()&&cookie_status(row.1.as_deref());
   let verified:Option<String>=tx.query_row("SELECT a.username FROM sessions s JOIN accounts a ON s.account_id=a.account_id WHERE s.token_digest=?1 AND s.revoked_ms IS NULL AND s.expires_ms>=?2 AND (a.status IS NULL OR a.status IN ('','active','approved'))",params![digest(t),now()],|r|r.get(0)).optional().map_err(sqlerr)?;
   if eligible&&verified.as_deref()!=Some(row.0.as_str())||!eligible&&verified.is_some(){return Err("authentication verification mismatch".into())}
  }
  tx.commit().map_err(sqlerr)?;Ok((users.len(),sessions.len()))
 }
}

#[cfg(test)]mod tests{
 use super::*;use serde_json::json;
 fn setup()->(AuthStore,std::path::PathBuf){let p=std::env::temp_dir().join(format!("inc2-auth-{}.db",crate::apps::hex_id(8).unwrap()));Connection::open(&p).unwrap();{use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o600)).unwrap();}(AuthStore::open(&p).unwrap(),p)}
 fn inputs()->(Value,Value,String){let t=token();let salt="0123456789abcdeffedcba9876543210";let key=rj_crypto::hash_r32_password("fixture pass",salt);let u=json!({"fixture-a":{"salt":salt,"key":key,"created":1},"fixture-p":{"salt":salt,"key":key,"created":2,"status":"pending"}});let mut s=json!({});s[&t]=json!({"user":"fixture-a","created":1,"expires":now()+2592000000i64});(u,s,t)}
 fn clean(p:std::path::PathBuf){std::fs::remove_file(&p).ok();std::fs::remove_file(format!("{}-wal",p.display())).ok();std::fs::remove_file(format!("{}-shm",p.display())).ok();}
 #[test]fn pairing_clock_and_orphan_batch(){let(s,p)=setup();let a=pair_now();std::thread::sleep(std::time::Duration::from_millis(2));assert!(pair_now()>=a);
  {let mut c=s.conn.lock().unwrap();for i in 0..501{c.execute("INSERT INTO pairing_meta(poll_id) VALUES(?1)",params![format!("orphan{i}")]).unwrap();}let tx=c.transaction().unwrap();pair_expire(&tx,pair_now()).unwrap();tx.commit().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM pairing_meta",[],|r|r.get::<_,i64>(0)).unwrap(),1);}
  s.pair_sweep().unwrap();{let c=s.conn.lock().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM pairing_meta",[],|r|r.get::<_,i64>(0)).unwrap(),0);}drop(s);clean(p)
 }
 #[test]fn pairing_exact_boundaries_and_retention(){let(s,p)=setup();s.claim("boundary","fixture pass",false).unwrap();let exp=now()+600000;
  for(offset,live)in [(-1,false),(0,false),(1,true)]{let poll=format!("approve{offset}");s.pair_create_scoped(&poll,&poll,"tv",exp+offset,None).unwrap();assert_eq!(s.pair_approve_at(&poll,"boundary",&poll,&poll,Some(exp)).unwrap(),live);}
  for(offset,live)in [(-1,false),(0,false),(1,true)]{let poll=format!("consume{offset}");s.pair_create_scoped(&poll,&poll,"tv",exp+offset,None).unwrap();assert!(s.pair_approve_at(&poll,"boundary",&poll,&poll,Some(exp-2)).unwrap());assert_eq!(s.pair_consume_at(&poll,Some(exp)).unwrap(),live);}
  {let mut c=s.conn.lock().unwrap();let tx=c.transaction().unwrap();pair_expire(&tx,exp+PAIR_TERMINAL_RETAIN_MS+2).unwrap();tx.commit().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM pairing_requests",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert_eq!(c.query_row("SELECT count(*) FROM pairing_meta",[],|r|r.get::<_,i64>(0)).unwrap(),0);}
  assert!(s.device_resolve("consume1").unwrap().is_some());drop(s);clean(p)
 }
 #[test]fn pairing_v34_atomic_ttl_scope_and_cleanup(){let(s,p)=setup();s.claim("fixture-tv","fixture pass",false).unwrap();
  let exp=now()+600000;
  s.pair_create_scoped("one","AB23CD45","one",exp,Some("client-a")).unwrap();
  s.pair_create_scoped("other","AB23CD46","other",exp,Some("client-b")).unwrap();
  s.pair_create_scoped("two","AB23CD47","two",exp,Some("client-a")).unwrap();
  assert_eq!(s.pair_info("one").unwrap().unwrap().0,"superseded");assert_eq!(s.pair_info("other").unwrap().unwrap().0,"pending");
  assert!(s.pair_approve_atomic("two","fixture-tv","dev-two","token-two").unwrap());
  assert!(!s.pair_approve_atomic("two","fixture-tv","dev-duplicate","token-duplicate").unwrap());
  s.pair_create_scoped("three","AB23CD48","three",exp,Some("client-a")).unwrap();assert_eq!(s.pair_info("two").unwrap().unwrap().0,"approved");
  {let c=s.conn.lock().unwrap();c.execute("UPDATE pairing_requests SET expires_ms=?1 WHERE poll_id='two'",params![now()-1]).unwrap();}
  assert!(!s.pair_consume_atomic("two").unwrap());assert_eq!(s.pair_info("two").unwrap().unwrap().0,"expired");assert!(s.device_resolve("token-two").unwrap().is_none());
  assert!(s.pair_approve_atomic("three","fixture-tv","dev-three","token-three").unwrap());assert!(s.pair_consume_atomic("three").unwrap());assert!(!s.pair_consume_atomic("three").unwrap());
  {let c=s.conn.lock().unwrap();c.execute("UPDATE pairing_requests SET expires_ms=0 WHERE poll_id='three'",[]).unwrap();}s.pair_sweep().unwrap();assert!(s.device_resolve("token-three").unwrap().is_some());
  s.pair_create_scoped("late","AB23CD49","late",now()-1,None).unwrap();assert!(!s.pair_approve_atomic("late","fixture-tv","dev-late","token-late").unwrap());
  drop(s);clean(p)}
 #[test]fn digest_import_revoke_reimport_restart(){let(s,p)=setup();let(u,v,t)=inputs();assert_eq!(s.import(&u,&v,1).unwrap(),(2,1));assert!(matches!(s.lookup(&t).unwrap(),Lookup::Valid(_)));s.logout(&t).unwrap();assert!(matches!(s.lookup(&t).unwrap(),Lookup::Denied));s.import(&u,&v,1).unwrap();assert!(matches!(s.lookup(&t).unwrap(),Lookup::Denied));drop(s);let s=AuthStore::open(&p).unwrap();assert!(matches!(s.lookup(&t).unwrap(),Lookup::Denied));let c=s.conn.lock().unwrap();let d:Vec<u8>=c.query_row("SELECT token_digest FROM sessions",[],|r|r.get(0)).unwrap();assert_eq!(d,digest(&t));drop(c);drop(s);let bytes=std::fs::read(&p).unwrap();assert!(!bytes.windows(t.len()).any(|b|b==t.as_bytes()));clean(p)}
 #[test]fn import_atomic_bad_and_count(){let(s,p)=setup();let(mut u,v,_)=inputs();assert!(s.import(&u,&v,2).is_err());u["fixture-p"]["salt"]=json!("oops");assert!(s.import(&u,&v,1).is_err());assert!(s.list().unwrap().is_empty());drop(s);clean(p)}
 #[test]fn rotation_all_old_dead_new_live(){let(s,p)=setup();let(u,v,t)=inputs();s.import(&u,&v,1).unwrap();let b=s.issue("fixture-a").unwrap();assert!(s.password(&t,"wrong","new pass").is_err());assert!(s.user(&t).is_some());let nt=s.password(&t,"fixture pass","new pass").unwrap();assert_ne!(nt,t);assert!(s.user(&nt).is_some());assert!(matches!(s.lookup(&t).unwrap(),Lookup::Denied));assert!(matches!(s.lookup(&b).unwrap(),Lookup::Denied));assert!(!s.verify_lite("fixture-a","fixture pass"));assert!(s.verify_lite("fixture-a","new pass"));drop(s);clean(p)}
 #[test]fn banned_and_claim_status(){let(s,p)=setup();let(u,v,t)=inputs();s.import(&u,&v,1).unwrap();assert!(s.admin("fixture-a","ban").unwrap());assert!(s.user(&t).is_none());assert!(!s.verify_lite("fixture-a","fixture pass"));s.claim("fixture-new","fixture pass",true).unwrap();let c=s.conn.lock().unwrap();let status:String=c.query_row("SELECT status FROM accounts WHERE username='fixture-new'",[],|r|r.get(0)).unwrap();assert_eq!(status,"pending");drop(c);drop(s);clean(p)}
 #[test]fn pairing_device_lifecycle(){let(s,p)=setup();
  s.claim("fixture-tv","fixture pass",false).unwrap();
  let exp=now()+600000;
  s.pair_create("poll24hexpoll24hexpoll24","AB23CD45","Fixture TV",exp).unwrap();
  assert_eq!(s.pair_pending_by_code("AB23CD45").unwrap(),Some(("poll24hexpoll24hexpoll24".to_string(),"Fixture TV".to_string())));
  assert_eq!(s.pair_state("poll24hexpoll24hexpoll24").unwrap().unwrap().0,"pending");
  s.device_insert("dev8hex1","fixture-tv","Fixture TV","roku","tok48").unwrap();
  s.pair_mark("poll24hexpoll24hexpoll24","approved",Some("fixture-tv"),Some("dev8hex1")).unwrap();
  assert_eq!(s.pair_state("poll24hexpoll24hexpoll24").unwrap().unwrap().0,"approved");
  assert_eq!(s.device_resolve("tok48").unwrap(),Some(("fixture-tv".to_string(),"dev8hex1".to_string())));
  assert_eq!(s.device_resolve("nope").unwrap(),None);
  let l=s.device_list("fixture-tv").unwrap();
  assert_eq!(l.len(),1);assert_eq!(l[0].0,"dev8hex1");assert_eq!(l[0].1,"Fixture TV");
  s.device_touch("dev8hex1").unwrap();
  assert!(s.device_list("fixture-tv").unwrap()[0].3.is_some());
  assert!(s.device_revoke("fixture-tv","dev8hex1").unwrap());
  assert_eq!(s.device_resolve("tok48").unwrap(),None);               
  assert!(s.device_list("fixture-tv").unwrap().is_empty());
  assert!(!s.device_revoke("fixture-tv","dev8hex1").unwrap());
                                        
  s.pair_create("poll24hexpoll24hexpoll2z","ZZ23CD45","old",now()-1).unwrap();
  assert_eq!(s.pair_pending_by_code("ZZ23CD45").unwrap(),None);
  drop(s);clean(p)}
 #[test]fn import_1201_synthetic(){let(s,p)=setup();let(u,mut v,_)=inputs();v.as_object_mut().unwrap().clear();for i in 0..1201{v[token()]=json!({"user":"fixture-a","created":i,"expires":now()+2592000000i64});}s.import(&u,&v,1201).unwrap();for(t,_)in v.as_object().unwrap(){assert!(s.user(t).is_some())}drop(s);clean(p)}
}
#[cfg(test)]mod more_tests{
 use super::*;#[test]fn div9_status_cells(){assert!(cookie_status(None));assert!(cookie_status(Some("active")));assert!(cookie_status(Some("approved")));assert!(cookie_status(Some("")));assert!(!cookie_status(Some("pending")));assert!(!cookie_status(Some("banned")));assert!(!cookie_status(Some("other")));}
}
