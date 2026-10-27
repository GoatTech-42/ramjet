                                                                       
                                                                                  
                                                                                 
use std::{ffi::CString, fs::File, io::{Read, Seek}, os::{fd::{AsRawFd, FromRawFd}, unix::fs::MetadataExt}, path::{Component, Path}};
use super::Key;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal { Path, Custody, Busy, MissingWithData, RecoveryRequired, Key, Io }
type Result<T> = std::result::Result<T, Refusal>;

                                                                                  
                                                                                
                                                                                   
pub struct ReadyKey { key: Key, _held: Vec<File>, _room: File }
impl ReadyKey {
    pub fn seal(&self, plaintext: &[u8]) -> Option<Vec<u8>> { super::seal(&self.key, plaintext) }
    pub fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> { super::open(&self.key, sealed) }
    pub fn row_from_line(&self, line:&str) -> Option<super::Row> { super::row_from_line(&self.key,line) }
    pub fn row_to_line(&self, row:&super::Row) -> Option<String> { super::row_to_line(&self.key,row) }
}
impl Drop for ReadyKey {
    fn drop(&mut self) { self.key.fill(0); }                                            
}
fn name(s: &std::ffi::OsStr) -> Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(s.as_bytes()).map_err(|_| Refusal::Path)
}
fn at(dir: &File, n: &std::ffi::OsStr, flags: i32, mode: u32) -> std::io::Result<File> {
    let n = name(n).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
                                                                                     
    let fd = unsafe { libc::openat(dir.as_raw_fd(), n.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK, mode) };
    if fd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
}
fn directory(dir: &File, n: &std::ffi::OsStr) -> std::io::Result<File> { at(dir,n,libc::O_RDONLY | libc::O_DIRECTORY,0) }
fn custody(f: &File, uid: u32, dev: u64, private: bool) -> Result<()> {
    let m=f.metadata().map_err(|_|Refusal::Io)?;
    if !m.is_dir() || m.dev()!=dev || (m.uid()!=uid && (!private && m.uid()!=0))
        || (private && (m.uid()!=uid || m.mode() & 0o7777 != 0o700))
        || m.mode() & 0o022 != 0 { return Err(Refusal::Custody); }
    Ok(())
}
fn sync_chain(held: &[File], room: &File) -> Result<()> {
    room.sync_all().map_err(|_|Refusal::Io)?;
    for d in held.iter().rev() { d.sync_all().map_err(|_|Refusal::Io)?; }
    Ok(())
}
fn validate(mut h: File, uid:u32,dev:u64) -> Result<(Key,File)> {
    let m=h.metadata().map_err(|_|Refusal::Io)?;
    if !m.is_file() || m.uid()!=uid || m.dev()!=dev || m.nlink()!=1 || m.mode() & 0o7777 != 0o600 {return Err(Refusal::Custody);}
    let mut bytes=Vec::new();
    (&mut h).take(4097).read_to_end(&mut bytes).map_err(|_|Refusal::Io)?;
    if bytes.len()>4096 {return Err(Refusal::Key);}
    let s=std::str::from_utf8(&bytes).map_err(|_|Refusal::Key)?;
    let k=super::parse_key(super::super::js_trim(s)).ok_or(Refusal::Key)?;
    Ok((k,h))
}
                                                                            
                                                                                
                                                                                 
                                                                                
                                                                                   
                                                                                   
                                                                            
pub fn load_existing(data: &Path, expected_device:u64) -> Result<ReadyKey> {
    load_impl(data,expected_device,||{})
}
fn load_impl(data: &Path, expected_device:u64, before_gate:impl FnOnce()) -> Result<ReadyKey> {
    if !data.is_absolute() {return Err(Refusal::Path);}
    let uid=unsafe {libc::geteuid()};                                                    
    let root=File::open("/").map_err(|_|Refusal::Io)?;
    custody(&root,uid,expected_device,false)?;
    let mut held=vec![root];
    let parts: Vec<_>=data.components().collect();
    for c in parts.iter().skip(1) {
        let Component::Normal(n)=c else {return Err(Refusal::Path);};
        let d=directory(held.last().unwrap(),n).map_err(|_|Refusal::Custody)?;
        custody(&d,uid,expected_device,false)?;
        held.push(d);
    }
    let parent=held.last().ok_or(Refusal::Path)?;
    custody(parent,uid,expected_device,true)?;
    if unsafe {libc::flock(parent.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0 {return Err(Refusal::Busy);}
    let room=match directory(parent,std::ffi::OsStr::new("banter2")) {
        Ok(d)=>d,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => return Err(Refusal::MissingWithData),
        Err(_)=>return Err(Refusal::Custody),
    };
    custody(&room,uid,expected_device,true)?;
    artifact_absence(&room)?;
    let h=at(&room,std::ffi::OsStr::new("key"),libc::O_RDONLY,0).map_err(|e| if e.kind()==std::io::ErrorKind::NotFound {Refusal::MissingWithData} else {Refusal::Custody})?;
    let (key,mut h)=validate(h,uid,expected_device)?;
    before_gate();
    h.sync_all().map_err(|_|Refusal::Io)?;
    sync_chain(&held,&room)?;
                                                                              
                                                                                  
                                                                         
    for d in &held {custody(d,uid,expected_device,false)?;}
    custody(held.last().unwrap(),uid,expected_device,true)?;
    custody(&room,uid,expected_device,true)?;
    for (index,c) in parts.iter().skip(1).enumerate() {
        let Component::Normal(n)=c else {return Err(Refusal::Path);};
        binding(&held[index],n,&held[index+1])?;
    }
    binding(held.last().unwrap(),std::ffi::OsStr::new("banter2"),&room)?;
    binding(&room,std::ffi::OsStr::new("key"),&h)?;
    h.rewind().map_err(|_|Refusal::Io)?;
    let (checked,h)=validate(h,uid,expected_device)?;
    if checked!=key {return Err(Refusal::Custody);}
    artifact_absence(&room)?;                                                 
                                                                             
                                                               
    held.push(h);
    Ok(ReadyKey{key,_held:held,_room:room})
}

                                                                     
fn artifact_absence(room:&File)->Result<()> {
    for n in [".initializing",".key.staged"] {
        match at(room,std::ffi::OsStr::new(n),libc::O_RDONLY,0) {
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),
            _=>return Err(Refusal::RecoveryRequired),
        }
    }
    Ok(())
}

                                                                              
                                                                              
                                                                
fn binding(parent:&File,n:&std::ffi::OsStr,held:&File)->Result<()> {
    let n=name(n)?;
    let mut current=std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {libc::fstatat(parent.as_raw_fd(),n.as_ptr(),current.as_mut_ptr(),libc::AT_SYMLINK_NOFOLLOW)}!=0 {return Err(Refusal::Custody);}
    let current=unsafe {current.assume_init()};
    let m=held.metadata().map_err(|_|Refusal::Io)?;
    if current.st_dev!=m.dev() || current.st_ino!=m.ino() || current.st_mode & libc::S_IFMT != m.mode() & libc::S_IFMT {return Err(Refusal::Custody);}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> std::path::PathBuf {
        let p=std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap().join(format!("rj-seal-test-{}",crate::apps::hex_id(12).unwrap()));
        assert!(!p.exists());
        std::fs::create_dir(&p).unwrap();
        std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o700)).unwrap();
        p
    }
    fn dev(p:&Path)->u64 {std::fs::metadata(p).unwrap().dev()}
    fn fixture_key(p:&Path) {
        std::fs::create_dir(p.join("banter2")).unwrap();
        std::fs::set_permissions(p.join("banter2"),std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(p.join("banter2/key"),"a".repeat(64)).unwrap();
        std::fs::set_permissions(p.join("banter2/key"),std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn existing_durability_gate_reload_and_lock() {
        let p=fixture(); fixture_key(&p);
        let k=load_existing(&p,dev(&p)).unwrap();
        let b=k.seal(b"fixture").unwrap();
        assert_eq!(k.open(&b).unwrap(),b"fixture");
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::Busy)));
        drop(k);
        let k2=load_existing(&p,dev(&p)).unwrap();
        assert_eq!(k2.open(&b).unwrap(),b"fixture");
        drop(k2);
        assert_eq!(std::fs::read_dir(p.join("banter2")).unwrap().count(),1);
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn missing_with_data_and_uncertain_init_refuse() {
        let p=fixture();
        std::fs::create_dir(p.join("banter2")).unwrap();
        std::fs::set_permissions(p.join("banter2"),std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::MissingWithData)));
        std::fs::write(p.join("banter2/.initializing"),b"").unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::RecoveryRequired)));
        assert!(!p.join("banter2/key").exists());
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn absence_is_never_fresh_authority() {
        let p=fixture();
        std::fs::write(p.join("migration-history"),b"fixture").unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::MissingWithData)));
        assert!(!p.join("banter2").exists());
        std::fs::remove_file(p.join("migration-history")).unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::MissingWithData)));
        assert!(!p.join("banter2").exists());
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn final_gate_detects_replacement_and_private_mode_change() {
        for what in ["data-mode","room-mode","key-replace","key-content","room-replace"] {
            let p=fixture(); fixture_key(&p); let d=dev(&p);
            let r=load_impl(&p,d,|| match what {
                "data-mode"=>std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o750)).unwrap(),
                "room-mode"=>std::fs::set_permissions(p.join("banter2"),std::fs::Permissions::from_mode(0o750)).unwrap(),
                "key-content"=>std::fs::write(p.join("banter2/key"),"c".repeat(64)).unwrap(),
                "key-replace"=>{
                    std::fs::rename(p.join("banter2/key"),p.join("banter2/original")).unwrap();
                    std::fs::write(p.join("banter2/key"),"b".repeat(64)).unwrap();
                },
                _=>{
                    std::fs::rename(p.join("banter2"),p.join("old-room")).unwrap();
                    fixture_key(&p);
                }
            });
            assert!(matches!(r,Err(Refusal::Custody)),"{what}");
            std::fs::remove_dir_all(p).unwrap();
        }
    }
    #[test]
    fn final_gate_detects_new_marker_or_stage() {
        for artifact in [".initializing",".key.staged"] {
            let p=fixture(); fixture_key(&p); let d=dev(&p);
            let r=load_impl(&p,d,||std::fs::write(p.join("banter2").join(artifact),b"fixture").unwrap());
            assert!(matches!(r,Err(Refusal::RecoveryRequired)),"{artifact}");
            assert!(p.join("banter2").join(artifact).exists());             
            std::fs::remove_dir_all(p).unwrap();
        }
    }
    #[test]
    fn held_file_uid_mismatch_refuses() {
        let p=fixture(); fixture_key(&p);
        let h=File::open(p.join("banter2/key")).unwrap();
        let wrong=unsafe {libc::geteuid()}.wrapping_add(1);
        assert!(matches!(validate(h,wrong,dev(&p)),Err(Refusal::Custody)));
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn flock_excludes_a_cooperating_separate_process_only() {
        let p=fixture(); fixture_key(&p);
        let k=load_existing(&p,dev(&p)).unwrap();
        let script="import os,fcntl,sys; f=os.open(sys.argv[1],os.O_RDONLY);\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(23)\nsys.exit(0)";
        let status=std::process::Command::new("python3").args(["-c",script]).arg(&p).status().unwrap();
        assert_eq!(status.code(),Some(23));
        drop(k);
        let status=std::process::Command::new("python3").args(["-c",script]).arg(&p).status().unwrap();
        assert!(status.success());
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn hostile_key_matrix() {
        let p=fixture(); fixture_key(&p); drop(load_existing(&p,dev(&p)).unwrap());
        let f=p.join("banter2/key");
        let original=std::fs::read(&f).unwrap();
                                                                              
        let mut ov=original.clone(); ov.extend(vec![b' ';4100]);
        std::fs::write(&f,&ov).unwrap();
        let refusal=load_existing(&p,dev(&p)); assert!(matches!(refusal,Err(Refusal::Key)), "unexpected refusal {:?}", refusal.err());
        assert_eq!(std::fs::read(&f).unwrap(),ov);
                                                                          
        let text=String::from_utf8(original.clone()).unwrap();
        std::fs::write(&f,format!("\u{feff}{text}\n")).unwrap();
        drop(load_existing(&p,dev(&p)).unwrap());
        std::fs::write(&f,format!("\u{85}{text}")).unwrap();
        let refusal=load_existing(&p,dev(&p)); assert!(matches!(refusal,Err(Refusal::Key)), "unexpected refusal {:?}", refusal.err());
        std::fs::write(&f,&original).unwrap();
        std::fs::set_permissions(&f,std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::Custody)));
        std::fs::set_permissions(&f,std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&f,p.join("banter2/key.extra")).unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::Custody)));
        std::fs::remove_file(&f).unwrap();
        std::os::unix::fs::symlink("key.extra",&f).unwrap();
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::Custody)));
        std::fs::remove_file(&f).unwrap();
        let n=CString::new(f.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe {libc::mkfifo(n.as_ptr(),0o600)},0);
        assert!(matches!(load_existing(&p,dev(&p)),Err(Refusal::Custody)));
        std::fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn ancestor_symlink_mode_device_refusal() {
        let p=fixture(); let d=dev(&p);
        assert!(matches!(load_existing(&p,d+1),Err(Refusal::Custody)));
        std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(matches!(load_existing(&p,d),Err(Refusal::Custody)));
        std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o700)).unwrap();
        let link=p.with_extension("link");
        std::os::unix::fs::symlink(&p,&link).unwrap();
        assert!(matches!(load_existing(&link,d),Err(Refusal::Custody)));
        std::fs::remove_file(link).unwrap(); std::fs::remove_dir_all(p).unwrap();
    }
}
