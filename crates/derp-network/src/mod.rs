use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::sync::Arc;

mod crypto;
mod protocol;
mod network;
mod error;

use error::{DerpError, DerpResult};
use network::{NetworkState, NetworkStats};

#[wasm_bindgen]
pub struct DerpNetworkAdapter {
    network: NetworkState,
}

#[wasm_bindgen]
impl DerpNetworkAdapter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<DerpNetworkAdapter, JsValue> {
        let crypto_state = Arc::new(crypto::CryptoState::new()?);
        Ok(DerpNetworkAdapter {
            network: NetworkState::new(crypto_state),
        })
    }

    #[wasm_bindgen]
    pub async fn connect(&mut self, url: &str) -> Result<(), JsValue> {
        self.network.connect(url).await.map_err(Into::into)
    }

    #[wasm_bindgen]
    pub fn send_packet(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.network.send_packet(data).map_err(Into::into)
    }

    #[wasm_bindgen]
    pub fn get_stats(&self) -> Result<JsValue, JsValue> {
        let stats = self.network.get_stats();
        serde_wasm_bindgen::to_value(&stats).map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    async fn test_adapter_lifecycle() {
        // Test creation
        let mut adapter = DerpNetworkAdapter::new().unwrap();
        
        // Test connection
        let result = adapter.connect("wss://test.example.com").await;
        assert!(result.is_ok());
        
        // Test packet sending
        let result = adapter.send_packet(b"test packet");
        assert!(result.is_ok());
        
        // Test stats
        let stats = adapter.get_stats().unwrap();
        assert!(serde_wasm_bindgen::from_value::<NetworkStats>(stats).is_ok());
    }

    #[wasm_bindgen_test]
    async fn test_error_handling() {
        let mut adapter = DerpNetworkAdapter::new().unwrap();
        
        // Test invalid URL
        let result = adapter.connect("invalid-url").await;
        assert!(result.is_err());
        
        // Test sending before connection
        let result = adapter.send_packet(b"test");
        assert!(result.is_err());
    }
}
