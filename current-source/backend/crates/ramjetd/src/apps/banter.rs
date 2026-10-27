                                                                                     
                                                      
                                                                                         
                                                                                       
                                   
                                    
                                                                                   
                                               
                                                                                   
                                                                             
                                                                                
                                                                                     
#[cfg(test)] fn hex_dec(s: &str) -> Option<Vec<u8>> {
    if !s.is_ascii() || s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

type Key = [u8; 32];

                                                                                
                                                                            
#[cfg(target_os = "linux")]
#[path = "banter_boot.rs"]
pub mod boot;

                                                                                    
                                                                          
fn parse_key(h: &str) -> Option<Key> {
    let b = h.as_bytes();
    if b.len() != 64 { return None; }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = (b[i * 2] as char).to_digit(16)?;
        let lo = (b[i * 2 + 1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

fn cipher(key: &Key) -> Aes256Gcm { Aes256Gcm::new_from_slice(key).unwrap() }

                                                                                  
                                                                                 
                                                                               
                                                                    
                                                                                     
                                                                               
                                                                                    
                                                                                   
                                                                                 
                                                     

                                                                                     
fn seal(key: &Key, plaintext: &[u8]) -> Option<Vec<u8>> {
    seal_rng(key, plaintext, |iv| std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, iv)))
}
fn seal_rng(key: &Key, plaintext: &[u8], fill: impl FnOnce(&mut [u8;12])->std::io::Result<()>) -> Option<Vec<u8>> {
    let mut iv = [0u8; 12];
    fill(&mut iv).ok()?;                                                    
    let ct = cipher(key).encrypt(Nonce::from_slice(&iv), Payload { msg: plaintext, aad: b"" }).ok()?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Some(out)
}

                                                                                    
fn open(key: &Key, buf: &[u8]) -> Option<Vec<u8>> {
    if buf.len() < 12 + 16 { return None; }
    let (iv, ct_tag) = buf.split_at(12);
    cipher(key).decrypt(Nonce::from_slice(iv), Payload { msg: ct_tag, aad: b"" }).ok()
}

                                                                                  
                                                                                   
                                                                                      
                                                                              
                                                                      
                                                             
#[derive(Debug, Clone, PartialEq)]
pub enum JVal {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<JVal>),
    Obj(Vec<(String, JVal)>),
}

impl<'de> serde::Deserialize<'de> for JVal {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = JVal;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("any JSON value") }
            fn visit_bool<E>(self, v: bool) -> Result<JVal, E> { Ok(JVal::Bool(v)) }
            fn visit_i64<E>(self, v: i64) -> Result<JVal, E> { Ok(JVal::Num(v.into())) }
            fn visit_u64<E>(self, v: u64) -> Result<JVal, E> { Ok(JVal::Num(v.into())) }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<JVal, E> {
                serde_json::Number::from_f64(v).map(JVal::Num).ok_or_else(|| serde::de::Error::custom("non-finite"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<JVal, E> { Ok(JVal::Str(v.to_string())) }
            fn visit_string<E>(self, v: String) -> Result<JVal, E> { Ok(JVal::Str(v)) }
            fn visit_none<E>(self) -> Result<JVal, E> { Ok(JVal::Null) }
            fn visit_unit<E>(self) -> Result<JVal, E> { Ok(JVal::Null) }
            fn visit_some<D2: serde::Deserializer<'de>>(self, d: D2) -> Result<JVal, D2::Error> { <JVal as serde::Deserialize>::deserialize(d) }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut a: A) -> Result<JVal, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = a.next_element::<JVal>()? { out.push(v); }
                Ok(JVal::Arr(out))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut a: A) -> Result<JVal, A::Error> {
                                                                                     
                                                                 
                let mut out: Vec<(String, JVal)> = Vec::new();
                while let Some((k, v)) = a.next_entry::<String, JVal>()? {
                    match out.iter_mut().find(|(n, _)| *n == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(JVal::Obj(out))
            }
        }
        d.deserialize_any(V)
    }
}
impl serde::Serialize for JVal {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self {
            JVal::Null => s.serialize_unit(),
            JVal::Bool(b) => s.serialize_bool(*b),
            JVal::Num(n) => n.serialize(s),
            JVal::Str(v) => s.serialize_str(v),
            JVal::Arr(a) => { let mut q = s.serialize_seq(Some(a.len()))?; for v in a { q.serialize_element(v)?; } q.end() }
            JVal::Obj(o) => { let mut m = s.serialize_map(Some(o.len()))?; for (k, v) in o { m.serialize_entry(k, v)?; } m.end() }
        }
    }
}
impl JVal {
    fn get(&self, k: &str) -> Option<&JVal> {
        if let JVal::Obj(o) = self { o.iter().find(|(n, _)| n == k).map(|(_, v)| v) } else { None }
    }
    fn as_i64(&self) -> Option<i64> {
                                                                                 
        if let JVal::Num(n) = self {
            const LIM: i64 = 9007199254740991;
            if let Some(i) = n.as_i64() { return (-LIM..=LIM).contains(&i).then_some(i); }
            n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() <= LIM as f64).map(|f| f as i64)
        } else { None }
    }
    fn as_str(&self) -> Option<&str> { if let JVal::Str(s) = self { Some(s) } else { None } }
}

                                                                                
                                                                                  
#[derive(Debug, Clone)]
pub struct Row {
    pub id: i64,
    pub from: String,
    pub ts: i64,
    pub kind: String,                        
    pub rest: Vec<(String, JVal)>,                                                          
}

                                                                                  
fn row_from_line(key: &Key, line: &str) -> Option<Row> {
    let outer: JVal = serde_json::from_str(line).ok()?;
    let b64 = outer.get("b")?.as_str()?;
    use base64::Engine;
    let sealed = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let plain = open(key, &sealed)?;                                        
    let inner: JVal = serde_json::from_slice(&plain).ok()?;
    let g = |k: &str| inner.get(k).or_else(|| outer.get(k)).cloned();                
    let rest = match &inner {
        JVal::Obj(o) => o.iter().filter(|(k, _)| k != "id" && k != "from" && k != "ts" && k != "type").cloned().collect(),
        _ => return None,
    };
    Some(Row {
        id: g("id")?.as_i64()?,
        from: g("from")?.as_str()?.to_string(),
        ts: g("ts")?.as_i64()?,
        kind: g("type")?.as_str()?.to_string(),
        rest,
    })
}

                                                                                 
                                                                            
fn row_to_line(key: &Key, row: &Row) -> Option<String> {
    let sealed = seal(key, serde_json::to_string(&JVal::Obj(row.rest.clone())).ok()?.as_bytes())?;
    use base64::Engine;
    Some(format!("{{\"id\":{},\"from\":{},\"ts\":{},\"type\":{},\"b\":\"{}\"}}",
        row.id, serde_json::to_string(&row.from).ok()?, row.ts,
        serde_json::to_string(&row.kind).ok()?,
        base64::engine::general_purpose::STANDARD.encode(sealed)))
}

                                                                                  

#[cfg(test)]
mod tests {
    use super::*;

                                                                            
                                                                                       
    pub(crate) const KEY_HEX: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    pub(crate) const R32_PAYLOAD: &str = r#"{"text":"hi there","reacts":{"fire":["sam"]},"reply":{"id":3,"from":"sam","text":"quoted"}}"#;
    const R32_LINE: &str = r#"{"id":7,"from":"luke","ts":1729000000000,"type":"text","b":"O/ot6s3PNWdz74eeBTHmkyMkzJzNfEq2U/2vJkE0QujjZQ8EIJj+gBMhOo5gRkP/8+Fex/8gb1AJrWQ31Oat1w0TCnnRkYVuwf9hzv2W+PbufoRQz8X4HTt+0zGq399ho/88Vw8OIXxas+Zg7YSwW5tP3txfskI="}"#;
    const R32_MEDIA_B64: &str = "SYzF0uY9MvCalJUNOcf1N/6lv23nfqw4ofKARy/oVYslts0=";

    fn key() -> Key { hex_dec(KEY_HEX).unwrap().try_into().unwrap() }

    #[test]
    fn opens_r32_sealed_row_and_media() {
                                                           
        let row = row_from_line(&key(), R32_LINE).expect("r32-minted row must open");
        assert_eq!((row.id, row.from.as_str(), row.ts, row.kind.as_str()), (7, "luke", 1729000000000, "text"));
                                                            
        let keys: Vec<&str> = row.rest.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["text", "reacts", "reply"]);
        assert_eq!(serde_json::to_string(&JVal::Obj(row.rest.clone())).unwrap(), R32_PAYLOAD);
        use base64::Engine;
        let media = base64::engine::general_purpose::STANDARD.decode(R32_MEDIA_B64).unwrap();
        assert_eq!(open(&key(), &media).unwrap(), vec![0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    }

    #[test]
    fn reseal_preserves_order_and_roundtrips() {
        let row = row_from_line(&key(), R32_LINE).unwrap();
        let line = row_to_line(&key(), &row).unwrap();
                                                                
        assert!(line.starts_with(r#"{"id":7,"from":"luke","ts":1729000000000,"type":"text","b":""#));
        let row2 = row_from_line(&key(), &line).unwrap();
        assert_eq!(serde_json::to_string(&JVal::Obj(row2.rest.clone())).unwrap(), R32_PAYLOAD);                          
    }

    #[test]
    fn tamper_and_wrong_key_drop_silently() {
                                                                     
        let mut bad: serde_json::Value = serde_json::from_str(R32_LINE).unwrap();
        let mut b = bad["b"].as_str().unwrap().to_string();
        b.replace_range(40..41, if b.chars().nth(40) == Some('A') { "B" } else { "A" });
        bad["b"] = serde_json::json!(b);
        assert!(row_from_line(&key(), &serde_json::to_string(&bad).unwrap()).is_none());
        let wrong: Key = [0x11; 32];
        assert!(row_from_line(&wrong, R32_LINE).is_none());
        assert!(open(&key(), &[0u8; 20]).is_none());                                 
        assert!(row_from_line(&key(), "not json").is_none());
    }

    #[test]
    fn rng_failure_and_empty_aad_pinned() {
        assert!(seal_rng(&key(),b"x",|_|Err(std::io::ErrorKind::Other.into())).is_none());
        let fixed=seal_rng(&key(),b"x",|iv|{iv.fill(7);Ok(())}).unwrap();
        assert_eq!(&fixed[..12],&[7u8;12]);
        assert_eq!(fixed.len(),29);                                      
        assert!(cipher(&key()).decrypt(Nonce::from_slice(&fixed[..12]),Payload{msg:&fixed[12..],aad:b"not empty"}).is_err());
        assert_eq!(open(&key(),&fixed).unwrap(),b"x");
    }
    #[test]
    fn json_edge_fixtures_and_inner_wins() {
        let dup:JVal=serde_json::from_str(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(serde_json::to_string(&dup).unwrap(),r#"{"a":3,"b":2}"#);
                                                                                   
        let indexed:JVal=serde_json::from_str(r#"{"2":"two","1":"one","x":0}"#).unwrap();
        assert_eq!(serde_json::to_string(&indexed).unwrap(),r#"{"2":"two","1":"one","x":0}"#);
        for (raw,want) in [("9007199254740991",Some(9007199254740991)),("9007199254740992",None),("-9007199254740992",None),("1e20",None),("1.5",None),("1.0",Some(1)),("-0.0",Some(0))] {
            let v:JVal=serde_json::from_str(raw).unwrap(); assert_eq!(v.as_i64(),want,"{raw}");
        }
                                                                               
        let minus:JVal=serde_json::from_str("-0").unwrap();
        assert_eq!(serde_json::to_string(&minus).unwrap(),"-0.0");
        use base64::Engine;
        let inner=seal(&key(),br#"{"id":9,"from":"inner","text":"hello"}"#).unwrap();
        let b=base64::engine::general_purpose::STANDARD.encode(inner);
        let line=format!(r#"{{"id":1,"from":"outer","ts":1,"type":"text","b":"{b}"}}"#);
        let row=row_from_line(&key(),&line).unwrap();
        assert_eq!(row.id,9); assert_eq!(row.from,"inner");
                                                                                   
        let changed=line.replace(r#""ts":1"#,r#""ts":2"#);
        assert_eq!(row_from_line(&key(),&changed).unwrap().ts,2);
    }

    #[test]
    fn seal_layout_and_fresh_nonce() {
                                                                    
        let a = seal(&key(), b"hello").unwrap();
        let b2 = seal(&key(), b"hello").unwrap();
        assert_eq!(a.len(), 12 + 5 + 16);
        assert_ne!(&a[..12], &b2[..12]);
        assert_eq!(open(&key(), &a).unwrap(), b"hello");
    }


}

#[cfg(test)]
mod interop_proof {
                                                                              
                                                                                 
                                                                                
    #[test]
    fn rust_sealed_opens_in_r32_node() {
        let key = super::hex_dec(super::tests::KEY_HEX).unwrap().try_into().unwrap();
        let sealed = super::seal(&key, super::tests::R32_PAYLOAD.as_bytes()).unwrap();
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&sealed);
        let script = format!(r#"const {{createDecipheriv}}=require('crypto');
const key=Buffer.from('{}','hex');
const buf=Buffer.from('{}','base64');
const d=createDecipheriv('aes-256-gcm',key,buf.subarray(0,12));
d.setAuthTag(buf.subarray(buf.length-16));
const out=Buffer.concat([d.update(buf.subarray(12,buf.length-16)),d.final()]).toString();
process.stdout.write(out);"#, super::tests::KEY_HEX, b64);
        let out = std::process::Command::new("node").arg("-e").arg(&script).output()
            .expect("node (the r32 runtime) is required for the interop proof");
        assert!(out.status.success(), "r32 open() rejected a Rust-sealed blob: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8(out.stdout).unwrap(), super::tests::R32_PAYLOAD);
    }
}
