use std::fmt;
use std::error::Error;
use bincode;

#[derive(Debug)]
pub enum DerpError {
    InvalidState(String),
    InvalidProtocol(String),
    WebSocketError(String),
    CryptoError(String),
    SerializationError(String),
}

impl fmt::Display for DerpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DerpError::InvalidState(msg) => write!(f, "Invalid state: {}", msg),
            DerpError::InvalidProtocol(msg) => write!(f, "Protocol error: {}", msg),
            DerpError::WebSocketError(msg) => write!(f, "WebSocket error: {}", msg),
            DerpError::CryptoError(msg) => write!(f, "Cryptography error: {}", msg),
            DerpError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
        }
    }
}

impl Error for DerpError {}

impl From<bincode::Error> for DerpError {
    fn from(err: bincode::Error) -> Self {
        DerpError::SerializationError(err.to_string())
    }
}

pub type DerpResult<T> = Result<T, DerpError>;
