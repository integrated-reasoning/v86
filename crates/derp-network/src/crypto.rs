use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    AeadCore, Aes256Gcm, Nonce,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use super::error::{DerpError, DerpResult};

type HmacSha256 = Hmac<Sha256>;

pub struct CryptoState {
    cipher: Aes256Gcm,
    hmac_key: Vec<u8>,
}

impl CryptoState {
    pub fn new() -> DerpResult<Self> {
        let key = Aes256Gcm::generate_key(&mut OsRng);
        let cipher = Aes256Gcm::new(&key);
        
        let mut hmac_key = vec![0u8; 32];
        getrandom::getrandom(&mut hmac_key)
            .map_err(|e| DerpError::CryptoError(format!("Failed to generate HMAC key: {}", e)))?;

        Ok(CryptoState { 
            cipher,
            hmac_key,
        })
    }

    pub fn encrypt(&self, data: &[u8]) -> DerpResult<Vec<u8>> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self.cipher
            .encrypt(&nonce, data)
            .map_err(|e| DerpError::CryptoError(format!("Encryption failed: {}", e)))?;

        // Combine nonce and ciphertext
        let mut result = nonce.to_vec();
        result.extend_from_slice(&ciphertext);
        Ok(result)
    }

    pub fn decrypt(&self, data: &[u8]) -> DerpResult<Vec<u8>> {
        if data.len() < 12 {
            return Err(DerpError::CryptoError("Data too short".into()));
        }

        let nonce = Nonce::from_slice(&data[..12]);
        let ciphertext = &data[12..];

        self.cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| DerpError::CryptoError(format!("Decryption failed: {}", e)))
    }

    pub fn sign(&self, data: &[u8]) -> DerpResult<String> {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(&self.hmac_key)
            .map_err(|e| DerpError::CryptoError(format!("Failed to create HMAC: {}", e)))?;
            
        mac.update(data);
        let result = mac.finalize();
        Ok(BASE64.encode(result.into_bytes()))
    }

    pub fn verify(&self, data: &[u8], signature: &str) -> DerpResult<bool> {
        let signature_bytes = BASE64.decode(signature)
            .map_err(|e| DerpError::CryptoError(format!("Invalid signature encoding: {}", e)))?;

        let mut mac = <HmacSha256 as Mac>::new_from_slice(&self.hmac_key)
            .map_err(|e| DerpError::CryptoError(format!("Failed to create HMAC: {}", e)))?;
            
        mac.update(data);

        Ok(mac.verify_slice(&signature_bytes).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn test_encryption_decryption() {
        let crypto = CryptoState::new().unwrap();
        let data = b"Hello, World!";
        
        let encrypted = crypto.encrypt(data).unwrap();
        let decrypted = crypto.decrypt(&encrypted).unwrap();
        
        assert_eq!(data, &decrypted[..]);
    }

    #[wasm_bindgen_test]
    fn test_signing_verification() {
        let crypto = CryptoState::new().unwrap();
        let data = b"Hello, World!";
        
        let signature = crypto.sign(data).unwrap();
        assert!(crypto.verify(data, &signature).unwrap());
        
        // Test invalid signature
        assert!(!crypto.verify(data, "invalid-signature").unwrap_or(true));
    }

    #[wasm_bindgen_test]
    fn test_encryption_different_data() {
        let crypto = CryptoState::new().unwrap();
        let data1 = b"Hello";
        let data2 = b"World";
        
        let encrypted1 = crypto.encrypt(data1).unwrap();
        let encrypted2 = crypto.encrypt(data2).unwrap();
        
        assert_ne!(encrypted1, encrypted2);
        
        let decrypted1 = crypto.decrypt(&encrypted1).unwrap();
        let decrypted2 = crypto.decrypt(&encrypted2).unwrap();
        
        assert_eq!(data1, &decrypted1[..]);
        assert_eq!(data2, &decrypted2[..]);
    }

    #[wasm_bindgen_test]
    fn test_invalid_decryption() {
        let crypto = CryptoState::new().unwrap();
        let result = crypto.decrypt(b"invalid data");
        assert!(result.is_err());
    }
}
