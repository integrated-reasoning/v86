use serde::{Serialize, Deserialize};
use uuid::Uuid;
use super::error::{DerpError, DerpResult};
use miniz_oxide::deflate::compress_to_vec;
use miniz_oxide::inflate::decompress_to_vec;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameType {
    ServerKey = 1,
    ServerInfo = 2,
    ClientInfo = 3,
    Ping = 4,
    Pong = 5,
    Send = 6,
    RecvFromPeer = 7,
}

impl TryFrom<u8> for FrameType {
    type Error = DerpError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(FrameType::ServerKey),
            2 => Ok(FrameType::ServerInfo),
            3 => Ok(FrameType::ClientInfo),
            4 => Ok(FrameType::Ping),
            5 => Ok(FrameType::Pong),
            6 => Ok(FrameType::Send),
            7 => Ok(FrameType::RecvFromPeer),
            _ => Err(DerpError::InvalidProtocol(format!("Invalid frame type: {}", value))),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum HandshakeState {
    Initial,
    AwaitingServerKey,
    AwaitingServerInfo,
    Complete,
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub version: String,
    pub client_id: String,
    pub supported_features: Vec<String>,
    pub max_packet_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    pub server_id: String,
    pub supported_versions: Vec<String>,
    pub supported_features: Vec<String>,
    pub max_packet_size: u32,
    pub keepalive_interval: u32,
}

pub struct ProtocolState {
    pub handshake_state: HandshakeState,
    client_info: Option<ClientInfo>,
    server_info: Option<ServerInfo>,
    last_ping_time: Option<std::time::Instant>,
    supported_features: Vec<String>,
    compression_enabled: bool,
}

impl ProtocolState {
    pub fn new() -> Self {
        ProtocolState {
            handshake_state: HandshakeState::Initial,
            client_info: None,
            server_info: None,
            last_ping_time: None,
            supported_features: vec![
                "compression".to_string(),
                "encryption".to_string(),
                "ipv6".to_string(),
            ],
            compression_enabled: false,
        }
    }

    pub fn is_connected(&self) -> bool {
        matches!(self.handshake_state, HandshakeState::Complete)
    }

    pub fn start_handshake(&mut self) -> DerpResult<Vec<u8>> {
        if !matches!(self.handshake_state, HandshakeState::Initial) {
            return Err(DerpError::InvalidState("Handshake already started".into()));
        }

        self.handshake_state = HandshakeState::AwaitingServerKey;
        
        let client_info = ClientInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            client_id: Uuid::new_v4().to_string(),
            supported_features: self.supported_features.clone(),
            max_packet_size: 16384, // 16KB default max packet size
        };
        
        self.client_info = Some(client_info.clone());
        
        Ok(self.encode_frame(FrameType::ClientInfo, &bincode::serialize(&client_info)?))
    }

    pub fn handle_server_key(&mut self, payload: Vec<u8>) -> DerpResult<Vec<u8>> {
        if !matches!(self.handshake_state, HandshakeState::AwaitingServerKey) {
            return Err(DerpError::InvalidState("Unexpected server key".into()));
        }

        if payload.len() != 32 {
            return Err(DerpError::InvalidProtocol("Invalid server key length".into()));
        }

        self.handshake_state = HandshakeState::AwaitingServerInfo;
        Ok(vec![])
    }

    pub fn handle_server_info(&mut self, payload: Vec<u8>) -> DerpResult<Vec<u8>> {
        if !matches!(self.handshake_state, HandshakeState::AwaitingServerInfo) {
            return Err(DerpError::InvalidState("Unexpected server info".into()));
        }

        let server_info: ServerInfo = bincode::deserialize(&payload)
            .map_err(|e| DerpError::InvalidProtocol(format!("Invalid server info: {}", e)))?;

        // Validate server version compatibility
        if !server_info.supported_versions.contains(&env!("CARGO_PKG_VERSION").to_string()) {
            return Err(DerpError::InvalidProtocol(format!(
                "Incompatible server version. Server supports: {:?}",
                server_info.supported_versions
            )));
        }

        // Check feature compatibility
        let client_features = &self.supported_features;
        let common_features: Vec<_> = server_info.supported_features.iter()
            .filter(|f| client_features.contains(&f.to_string()))
            .collect();

        if common_features.is_empty() {
            return Err(DerpError::InvalidProtocol(
                "No compatible features between client and server".into()
            ));
        }

        // Enable compression if both sides support it
        self.compression_enabled = common_features.iter().any(|f| *f == "compression");

        self.server_info = Some(server_info);
        self.handshake_state = HandshakeState::Complete;
        Ok(vec![])
    }

    pub fn handle_ping(&mut self) -> Vec<u8> {
        self.last_ping_time = Some(std::time::Instant::now());
        self.encode_frame(FrameType::Pong, &[])
    }

    pub fn encode_frame(&self, frame_type: FrameType, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(payload.len() + 5);
        frame.push(frame_type as u8);

        let compressed_payload = if self.compression_enabled && payload.len() > 64 {
            compress_to_vec(payload, 6)
        } else {
            payload.to_vec()
        };

        frame.extend_from_slice(&(compressed_payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&compressed_payload);
        frame
    }

    pub fn decode_frame(data: &[u8]) -> DerpResult<(FrameType, Vec<u8>)> {
        if data.len() < 5 {
            return Err(DerpError::InvalidProtocol("Frame too short".into()));
        }

        let frame_type = FrameType::try_from(data[0])?;
        let payload_len = u32::from_be_bytes([data[1], data[2], data[3], data[4]]) as usize;

        if data.len() < payload_len + 5 {
            return Err(DerpError::InvalidProtocol("Incomplete frame".into()));
        }

        let payload = &data[5..5 + payload_len];
        
        // Try to decompress if it looks like compressed data
        let decompressed = if payload.len() > 2 && frame_type != FrameType::Ping && frame_type != FrameType::Pong {
            decompress_to_vec(payload).unwrap_or(payload.to_vec())
        } else {
            payload.to_vec()
        };

        Ok((frame_type, decompressed))
    }

    pub fn get_keepalive_interval(&self) -> Option<u32> {
        self.server_info.as_ref().map(|info| info.keepalive_interval)
    }

    pub fn should_send_ping(&self) -> bool {
        if let (Some(server_info), Some(last_ping)) = (&self.server_info, self.last_ping_time) {
            let elapsed = last_ping.elapsed().as_secs() as u32;
            elapsed >= server_info.keepalive_interval
        } else {
            false
        }
    }

    pub fn is_compression_enabled(&self) -> bool {
        self.compression_enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frame_encoding() {
        let protocol = ProtocolState::new();
        let payload = b"test data";
        let frame = protocol.encode_frame(FrameType::Send, payload);
        
        assert_eq!(frame[0], FrameType::Send as u8);
        let len = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]) as usize;
        assert_eq!(&frame[5..5+len], payload);
    }

    #[test]
    fn test_frame_decoding() {
        let mut frame = vec![FrameType::Send as u8];
        let payload = b"test data";
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        
        let (frame_type, decoded_payload) = ProtocolState::decode_frame(&frame).unwrap();
        assert_eq!(frame_type, FrameType::Send);
        assert_eq!(decoded_payload, payload);
    }

    #[test]
    fn test_compression() {
        let mut protocol = ProtocolState::new();
        protocol.compression_enabled = true;

        // Create a payload that would benefit from compression
        let payload = vec![b'a'; 1000];
        let frame = protocol.encode_frame(FrameType::Send, &payload);
        
        // The compressed frame should be smaller than the original payload
        let frame_len = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]) as usize;
        assert!(frame_len < payload.len());

        // Decoding should give us back the original payload
        let (frame_type, decoded_payload) = ProtocolState::decode_frame(&frame).unwrap();
        assert_eq!(frame_type, FrameType::Send);
        assert_eq!(decoded_payload, payload);
    }

    #[test]
    fn test_small_payload_no_compression() {
        let mut protocol = ProtocolState::new();
        protocol.compression_enabled = true;

        // Small payload shouldn't be compressed
        let payload = b"small";
        let frame = protocol.encode_frame(FrameType::Send, payload);
        
        let frame_len = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]) as usize;
        assert_eq!(frame_len, payload.len());

        let (frame_type, decoded_payload) = ProtocolState::decode_frame(&frame).unwrap();
        assert_eq!(frame_type, FrameType::Send);
        assert_eq!(decoded_payload, payload);
    }

    #[test]
    fn test_handshake_flow() {
        let mut protocol = ProtocolState::new();
        
        // Start handshake
        let _ = protocol.start_handshake().unwrap();
        assert!(matches!(protocol.handshake_state, HandshakeState::AwaitingServerKey));
        
        // Handle server key
        let _ = protocol.handle_server_key(vec![0; 32]).unwrap();
        assert!(matches!(protocol.handshake_state, HandshakeState::AwaitingServerInfo));
        
        // Handle server info
        let server_info = ServerInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            server_id: Uuid::new_v4().to_string(),
            supported_versions: vec![env!("CARGO_PKG_VERSION").to_string()],
            supported_features: vec![
                "compression".to_string(),
                "encryption".to_string(),
                "ipv6".to_string(),
            ],
            max_packet_size: 16384,
            keepalive_interval: 30,
        };
        let server_info_data = bincode::serialize(&server_info).unwrap();
        let _ = protocol.handle_server_info(server_info_data).unwrap();
        
        assert!(matches!(protocol.handshake_state, HandshakeState::Complete));
        assert!(protocol.is_compression_enabled());
    }
}
