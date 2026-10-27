                                                                      
                                                                             
                                                                            
                                                           
use scrypt::{scrypt, Params};
use subtle::ConstantTimeEq;

pub const R32_SCRYPT_LOG_N: u8 = 14;             
pub const R32_SCRYPT_R: u32 = 8;
pub const R32_SCRYPT_P: u32 = 1;
pub const R32_KEYLEN: usize = 32;

                                                       
                                                                              
                                              
pub fn verify_r32_password(password: &str, salt_ascii_hex: &str, key_hex: &str) -> bool {
    let params = match Params::new(R32_SCRYPT_LOG_N, R32_SCRYPT_R, R32_SCRYPT_P, R32_KEYLEN) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut out = [0u8; R32_KEYLEN];
    if scrypt(password.as_bytes(), salt_ascii_hex.as_bytes(), &params, &mut out).is_err() {
        return false;
    }
    let expect = match hex_decode(key_hex) {
        Some(k) => k,
        None => return false,
    };
    expect.len() == R32_KEYLEN && out.ct_eq(&expect[..]).into()
}

                                                                              
                                                                                 
                                                                         
pub fn hash_r32_password(password: &str, salt_ascii_hex: &str) -> String {
    let params = Params::new(R32_SCRYPT_LOG_N, R32_SCRYPT_R, R32_SCRYPT_P, R32_KEYLEN).expect("params");
    let mut out = [0u8; R32_KEYLEN];
    scrypt(password.as_bytes(), salt_ascii_hex.as_bytes(), &params, &mut out).expect("scrypt");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
                                                                                    
                                                                 
                                                                                    
    const SALT: &str = "0123456789abcdeffedcba9876543210";
    const KEY: &str = "23ce8cbf5375b5361037c85b34c62ee858686a23f2de2c6602e3e76c2859b8d1";
    #[test]
    fn write_path_roundtrip() {
        let key = super::hash_r32_password("new pass 123", "aabbccddeeff00112233445566778899");
        assert!(super::verify_r32_password("new pass 123", "aabbccddeeff00112233445566778899", &key));
        assert!(!super::verify_r32_password("other", "aabbccddeeff00112233445566778899", &key));
    }
    #[test]
    fn r32_compat_vector() {
        assert!(verify_r32_password("correct horse battery staple", SALT, KEY));
        assert!(!verify_r32_password("wrong", SALT, KEY));
    }
}
