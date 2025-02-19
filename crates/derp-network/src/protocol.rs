use serde::{Serialize, Deserialize};
use wasm_bindgen::prelude::*;
use js_sys::{Uint8Array, Object};
use web_sys::WebSocket;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::crypto::CryptoState;
use crate::error::DerpResult;

const PROTOCOL_VERSION: u8 = 1;
const FRAME_HEADER_SIZE: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
pub enum FrameType {
    ServerKey = 1,
    ClientInfo = 2,
    ServerInfo = 3,
    SendPacket = 4,
    RecvPacket = 5,
    PeerPresent = 6,
    PeerGone = 7,
    KeepAlive = 8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Frame {
    version: u8,
    frame_type: u8,
    flags: u8,
    payload: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClientInfo {
    version: u8,
    token: String,
    mac_address: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ServerInfo {
    version: u8,
    name: String,
    region: String,
}

#[wasm_bindgen]
pub struct DerpProtocol {
    crypto: Arc<CryptoState>,
    peers: Arc<Mutex<HashMap<String, PeerState>>>,
    ws: Option<WebSocket>,
    session_key: Option<Vec<u8>>,
}

#[derive(Debug)]
struct PeerState {
    last_seen: f64, // JavaScript timestamp
    public_key: Vec<u8>,
}

#[wasm_bindgen]
impl DerpProtocol {
    #[wasm_bindgen(constructor)]
    pub fn new(crypto: Arc<CryptoState>) -> Self {
        DerpProtocol {
            crypto,
            peers: Arc::new(Mutex::new(HashMap::new())),
            ws: None,
            session_key: None,
        }
    }

    pub fn create_frame(&self, frame_type: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_HEADER_SIZE + payload.len());
        frame.push(PROTOCOL_VERSION);
        frame.push(frame_type);
        frame.push(0); // flags
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    pub fn decode_frame_header(&self, data: &[u8]) -> DerpResult<(u8, u8, u8, usize)> {
        if data.len() < FRAME_HEADER_SIZE {
            return Err("Frame too short".into());
        }

        let version = data[0];
        let frame_type = data[1];
        let flags = data[2];
        let length = ((data[3] as usize) << 8) | (data[4] as usize);

        Ok((version, frame_type, flags, length))
    }

    #[wasm_bindgen(js_name = handleServerKey)]
    pub async fn handle_server_key(&mut self, key: &[u8]) -> DerpResult<()> {
        if key.len() != 32 {
            return Err("Invalid server key length".into());
        }

        self.session_key = Some(self.crypto.derive_session_key(key).await?);
        Ok(())
    }

    #[wasm_bindgen(js_name = createClientInfo)]
    pub async fn create_client_info(&self, info: JsValue) -> DerpResult<Uint8Array> {
        let client_info: ClientInfo = serde_wasm_bindgen::from_value(info)?;
        let data = serde_json::to_vec(&client_info)?;
        let encrypted = self.crypto.encrypt(&data, &self.session_key.as_ref().ok_or("No session key")?).await?;
        
        let frame = self.create_frame(FrameType::ClientInfo as u8, &encrypted);
        Ok(Uint8Array::from(&frame[..]))
    }

    #[wasm_bindgen(js_name = handleServerInfo)]
    pub async fn handle_server_info(&self, payload: &[u8]) -> DerpResult<JsValue> {
        let decrypted = self.crypto.decrypt(payload, &self.session_key.as_ref().ok_or("No session key")?).await?;
        let info: ServerInfo = serde_json::from_slice(&decrypted)?;
        Ok(serde_wasm_bindgen::to_value(&info)?)
    }

    #[wasm_bindgen(js_name = handlePeerState)]
    pub fn handle_peer_state(&self, frame_type: u8, payload: &[u8]) -> DerpResult<()> {
        if payload.len() != 32 {
            return Err("Invalid peer key length".into());
        }

        let peer_key = hex::encode(payload);
        let mut peers = self.peers.lock().map_err(|_| "Failed to lock peers")?;

        match frame_type {
            x if x == FrameType::PeerPresent as u8 => {
                peers.insert(peer_key, PeerState {
                    last_seen: js_sys::Date::now(),
                    public_key: payload.to_vec(),
                });
            }
            x if x == FrameType::PeerGone as u8 => {
                peers.remove(&peer_key);
            }
            _ => return Err("Invalid peer state frame type".into())
        }

        Ok(())
    }

    #[wasm_bindgen(js_name = createPacketFrame)]
    pub fn create_packet_frame(&self, packet: &[u8], dest_key: &[u8]) -> DerpResult<Uint8Array> {
        if dest_key.len() != 32 {
            return Err("Invalid destination key length".into());
        }

        let mut payload = Vec::with_capacity(32 + packet.len());
        payload.extend_from_slice(dest_key);
        payload.extend_from_slice(packet);

        let frame = self.create_frame(FrameType::SendPacket as u8, &payload);
        Ok(Uint8Array::from(&frame[..]))
    }

    #[wasm_bindgen(js_name = handleRecvPacket)]
    pub fn handle_recv_packet(&self, payload: &[u8]) -> DerpResult<Object> {
        if payload.len() < 32 {
            return Err("Invalid packet payload length".into());
        }

        let (src_key, packet) = payload.split_at(32);
        let result = Object::new();

        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("srcKey"),
            &JsValue::from_str(&hex::encode(src_key))
        )?;

        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("packet"),
            &Uint8Array::from(packet)
        )?;

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    async fn create_test_protocol() -> DerpProtocol {
        let crypto = CryptoState::new().unwrap();
        DerpProtocol::new(Arc::new(crypto))
    }

    #[wasm_bindgen_test]
    async fn test_frame_creation() {
        let protocol = create_test_protocol().await;
        let payload = vec![1, 2, 3, 4];
        let frame = protocol.create_frame(FrameType::SendPacket as u8, &payload);
        
        let (version, frame_type, flags, length) = protocol.decode_frame_header(&frame).unwrap();
        assert_eq!(version, PROTOCOL_VERSION);
        assert_eq!(frame_type, FrameType::SendPacket as u8);
        assert_eq!(length, payload.len());
    }

    #[wasm_bindgen_test]
    async fn test_server_key_handling() {
        let mut protocol = create_test_protocol().await;
        let server_key = vec![0u8; 32];
        
        protocol.handle_server_key(&server_key).await.unwrap();
        assert!(protocol.session_key.is_some());
    }

    #[wasm_bindgen_test]
    async fn test_peer_state() {
        let protocol = create_test_protocol().await;
        let peer_key = vec![0u8; 32];
        
        protocol.handle_peer_state(FrameType::PeerPresent as u8, &peer_key).unwrap();
        
        let peers = protocol.peers.lock().unwrap();
        assert!(peers.contains_key(&hex::encode(&peer_key)));
        
        drop(peers);
        
        protocol.handle_peer_state(FrameType::PeerGone as u8, &peer_key).unwrap();
        
        let peers = protocol.peers.lock().unwrap();
        assert!(!peers.contains_key(&hex::encode(&peer_key)));
    }
}
