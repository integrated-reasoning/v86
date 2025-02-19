use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{WebSocket, MessageEvent, CloseEvent, ErrorEvent};
use js_sys::Uint8Array;
use std::sync::{Arc, Mutex};
use serde::{Serialize, Deserialize};
use super::{
    crypto::CryptoState,
    protocol::{ProtocolState, FrameType},
    error::{DerpError, DerpResult},
};

const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const INITIAL_RECONNECT_DELAY_MS: u32 = 1000;

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct NetworkStats {
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub packets_received: u64,
    pub packets_sent: u64,
    pub reconnect_attempts: u32,
}

pub struct NetworkState {
    stats: Arc<Mutex<NetworkStats>>,
    websocket: Option<WebSocket>,
    crypto_state: Arc<CryptoState>,
    protocol_state: Arc<Mutex<ProtocolState>>,
    url: Option<String>,
    reconnect_delay_ms: u32,
}

impl NetworkState {
    pub fn new(crypto_state: Arc<CryptoState>) -> Self {
        NetworkState {
            stats: Arc::new(Mutex::new(NetworkStats::default())),
            websocket: None,
            crypto_state,
            protocol_state: Arc::new(Mutex::new(ProtocolState::new())),
            url: None,
            reconnect_delay_ms: INITIAL_RECONNECT_DELAY_MS,
        }
    }

    pub async fn connect(&mut self, url: &str) -> DerpResult<()> {
        self.url = Some(url.to_string());
        self.connect_with_retry().await
    }

    async fn connect_with_retry(&mut self) -> DerpResult<()> {
        let url = self.url.as_ref().ok_or_else(|| 
            DerpError::InvalidState("No URL configured".into())
        )?;

        let ws = WebSocket::new(url)
            .map_err(|e| DerpError::WebSocketError(format!("Failed to create WebSocket: {:?}", e)))?;
        
        ws.set_binary_type(web_sys::BinaryType::Arraybuffer);
        
        // Setup message handler
        let stats = self.stats.clone();
        let protocol_state = self.protocol_state.clone();
        let crypto_state = self.crypto_state.clone();
        let ws_clone = ws.clone();
        
        let onmessage_callback = Closure::wrap(Box::new(move |e: MessageEvent| {
            if let Ok(array_buffer) = e.data().dyn_into::<js_sys::ArrayBuffer>() {
                let array = Uint8Array::new(&array_buffer);
                let data = array.to_vec();
                
                if let Ok((frame_type, payload)) = ProtocolState::decode_frame(&data) {
                    let mut protocol = protocol_state.lock().unwrap();
                    match frame_type {
                        FrameType::ServerKey => {
                            let _ = protocol.handle_server_key(payload);
                        }
                        FrameType::ServerInfo => {
                            if let Ok(response) = protocol.handle_server_info(payload) {
                                let array = Uint8Array::from(&response[..]);
                                let _ = ws_clone.send_with_u8_array(&array.to_vec());
                            }
                        }
                        FrameType::Ping => {
                            let pong = protocol.handle_ping();
                            let array = Uint8Array::from(&pong[..]);
                            let _ = ws_clone.send_with_u8_array(&array.to_vec());
                        }
                        FrameType::RecvFromPeer => {
                            // Decrypt payload using crypto state
                            if let Ok(decrypted) = crypto_state.decrypt(&payload) {
                                let mut stats = stats.lock().unwrap();
                                stats.bytes_received += decrypted.len() as u64;
                                stats.packets_received += 1;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        
        // Setup error handler
        let error_callback = Closure::wrap(Box::new(move |e: ErrorEvent| {
            web_sys::console::warn_1(&e);
        }) as Box<dyn FnMut(ErrorEvent)>);
        
        // Setup close handler with reconnection logic
        let stats = self.stats.clone();
        let url = url.to_string();
        let reconnect_delay = self.reconnect_delay_ms;
        let close_callback = Closure::wrap(Box::new(move |_: CloseEvent| {
            let mut stats = stats.lock().unwrap();
            if stats.reconnect_attempts < MAX_RECONNECT_ATTEMPTS {
                stats.reconnect_attempts += 1;
                let delay = reconnect_delay * (1 << stats.reconnect_attempts);
                let url = url.clone();
                
                // Schedule reconnection
                let window = web_sys::window().unwrap();
                let reconnect_callback = Closure::wrap(Box::new(move || {
                    let ws = WebSocket::new(&url).unwrap();
                    ws.set_binary_type(web_sys::BinaryType::Arraybuffer);
                }) as Box<dyn FnMut()>);
                
                let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                    reconnect_callback.as_ref().unchecked_ref(),
                    delay as i32,
                );
                
                reconnect_callback.forget();
            }
        }) as Box<dyn FnMut(CloseEvent)>);
        
        ws.set_onmessage(Some(onmessage_callback.as_ref().unchecked_ref()));
        ws.set_onerror(Some(error_callback.as_ref().unchecked_ref()));
        ws.set_onclose(Some(close_callback.as_ref().unchecked_ref()));
        
        onmessage_callback.forget();
        error_callback.forget();
        close_callback.forget();

        self.websocket = Some(ws);
        
        // Start handshake using crypto state
        let handshake_frame = {
            let mut protocol = self.protocol_state.lock().unwrap();
            protocol.start_handshake()?
        };
        self.send_raw(&handshake_frame)?;
        
        Ok(())
    }

    pub fn send_packet(&mut self, data: &[u8]) -> DerpResult<()> {
        if !self.protocol_state.lock().unwrap().is_connected() {
            return Err(DerpError::InvalidState("Not connected".into()));
        }

        // Encrypt data before sending
        let encrypted = self.crypto_state.encrypt(data)?;
        let frame = self.protocol_state.lock().unwrap()
            .encode_frame(FrameType::Send, &encrypted);
        
        self.send_raw(&frame)?;
        
        let mut stats = self.stats.lock().unwrap();
        stats.bytes_sent += data.len() as u64;
        stats.packets_sent += 1;
        
        Ok(())
    }

    fn send_raw(&self, data: &[u8]) -> DerpResult<()> {
        if let Some(ws) = &self.websocket {
            let array = Uint8Array::from(data);
            ws.send_with_u8_array(&array.to_vec())
                .map_err(|e| DerpError::WebSocketError(format!("Failed to send data: {:?}", e)))?;
            Ok(())
        } else {
            Err(DerpError::InvalidState("WebSocket not initialized".into()))
        }
    }

    pub fn get_stats(&self) -> NetworkStats {
        self.stats.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    async fn test_reconnection() {
        let crypto_state = Arc::new(CryptoState::new().unwrap());
        let mut network = NetworkState::new(crypto_state);

        // Simulate connection failure
        let _ = network.connect("ws://invalid-url").await;
        
        // Wait for reconnection attempt
        let window = web_sys::window().unwrap();
        let closure = Closure::wrap(Box::new(|| {}) as Box<dyn FnMut()>);
        let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
            closure.as_ref().unchecked_ref(),
            INITIAL_RECONNECT_DELAY_MS as i32 * 2,
        );
        closure.forget();
        
        assert!(network.get_stats().reconnect_attempts > 0);
    }
}
