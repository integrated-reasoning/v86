pub mod crypto;
pub mod error;
pub mod network;
pub mod protocol;

use wasm_bindgen::prelude::*;
use std::sync::Arc;

use crypto::CryptoState;
use network::NetworkState;

#[wasm_bindgen]
pub struct DerpNetwork {
    network: NetworkState,
}

#[wasm_bindgen]
impl DerpNetwork {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<DerpNetwork, JsValue> {
        let crypto_state = CryptoState::new()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
            
        Ok(DerpNetwork {
            network: NetworkState::new(Arc::new(crypto_state)),
        })
    }

    pub async fn connect(&mut self, url: &str) -> Result<(), JsValue> {
        self.network.connect(url)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn send_packet(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.network.send_packet(data)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = getStats)]
    pub fn get_stats(&self) -> Result<JsValue, JsValue> {
        let stats = self.network.get_stats();
        Ok(serde_wasm_bindgen::to_value(&stats)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;
    use wasm_bindgen::JsCast;
    use js_sys::{Object, Reflect};

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    async fn test_derp_network() {
        // Test creation
        let mut derp = DerpNetwork::new().unwrap();
        
        // Test invalid connection
        let result = derp.connect("invalid-url").await;
        assert!(result.is_err());
        
        // Test valid connection
        let result = derp.connect("wss://test.example.com").await;
        assert!(result.is_ok());
        
        // Test sending packet
        let test_data = b"test packet";
        let result = derp.send_packet(test_data);
        assert!(result.is_ok());
        
        // Test stats
        let stats = derp.get_stats().unwrap();
        let stats_obj: Object = stats.unchecked_into();
        
        let bytes_sent = Reflect::get(&stats_obj, &JsValue::from_str("bytes_sent")).unwrap();
        let packets_sent = Reflect::get(&stats_obj, &JsValue::from_str("packets_sent")).unwrap();
        
        assert_eq!(bytes_sent.as_f64().unwrap() as u64, test_data.len() as u64);
        assert_eq!(packets_sent.as_f64().unwrap() as u64, 1);
    }

    #[wasm_bindgen_test]
    fn test_error_handling() {
        let mut derp = DerpNetwork::new().unwrap();
        
        // Test sending before connection
        let result = derp.send_packet(b"test");
        assert!(result.is_err());
        
        // Test stats before any activity
        let stats = derp.get_stats().unwrap();
        let stats_obj: Object = stats.unchecked_into();
        
        let bytes_sent = Reflect::get(&stats_obj, &JsValue::from_str("bytes_sent")).unwrap();
        let packets_sent = Reflect::get(&stats_obj, &JsValue::from_str("packets_sent")).unwrap();
        let reconnect_attempts = Reflect::get(&stats_obj, &JsValue::from_str("reconnect_attempts")).unwrap();
        
        assert_eq!(bytes_sent.as_f64().unwrap() as u64, 0);
        assert_eq!(packets_sent.as_f64().unwrap() as u64, 0);
        assert_eq!(reconnect_attempts.as_f64().unwrap() as u32, 0);
    }
}
