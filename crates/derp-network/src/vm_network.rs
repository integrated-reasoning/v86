use wasm_bindgen::prelude::*;
use js_sys::{Array, Uint8Array};
use std::sync::{Arc, Mutex};
use crate::network::NetworkState;
use crate::error::DerpResult;

#[wasm_bindgen]
pub struct VmNetwork {
    network: Arc<Mutex<NetworkState>>,
    mtu: u16,
    mac_address: [u8; 6],
}

#[wasm_bindgen]
impl VmNetwork {
    #[wasm_bindgen(constructor)]
    pub fn new(network: NetworkState, mac_address: &[u8]) -> Result<VmNetwork, JsValue> {
        if mac_address.len() != 6 {
            return Err(JsValue::from_str("Invalid MAC address length"));
        }

        let mut mac = [0u8; 6];
        mac.copy_from_slice(mac_address);

        Ok(VmNetwork {
            network: Arc::new(Mutex::new(network)),
            mtu: 1500, // Standard Ethernet MTU
            mac_address: mac,
        })
    }

    /// Called by v86 when the VM sends a network packet
    #[wasm_bindgen(js_name = sendPacket)]
    pub fn send_packet(&self, data: &[u8]) -> Result<(), JsValue> {
        // Validate ethernet frame
        if data.len() < 14 {
            return Err(JsValue::from_str("Invalid ethernet frame"));
        }

        // Extract destination MAC
        let dst_mac = &data[0..6];
        
        // Only handle packets for our MAC or broadcast
        if dst_mac != self.mac_address && dst_mac != [0xFF; 6] {
            return Ok(());
        }

        // Extract ethertype
        let ethertype = u16::from_be_bytes([data[12], data[13]]);
        
        // For now, only handle IPv4 (0x0800) and ARP (0x0806)
        match ethertype {
            0x0800 | 0x0806 => {
                let network = self.network.lock().map_err(|e| JsValue::from_str(&e.to_string()))?;
                network.send_packet(&data[14..])
                    .map_err(|e| JsValue::from_str(&e.to_string()))
            }
            _ => Ok(())
        }
    }

    /// Called by the network stack when a packet is received from the network
    #[wasm_bindgen(js_name = receivePacket)]
    pub fn receive_packet(&self, data: &[u8]) -> Result<(), JsValue> {
        if data.len() > (self.mtu as usize) {
            return Err(JsValue::from_str("Packet too large"));
        }

        // Create ethernet frame
        let mut frame = Vec::with_capacity(14 + data.len());
        
        // Add destination MAC (VM's MAC)
        frame.extend_from_slice(&self.mac_address);
        
        // Add source MAC (we use a fixed MAC for the virtual interface)
        frame.extend_from_slice(&[0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
        
        // Add ethertype (IPv4)
        frame.extend_from_slice(&[0x08, 0x00]);
        
        // Add payload
        frame.extend_from_slice(data);

        // Convert to JS array for v86
        let js_array = Array::new();
        for byte in frame {
            js_array.push(&JsValue::from(byte));
        }

        // Call v86's network adapter receive method
        // Note: This needs to be connected to the actual v86 instance
        js_sys::eval("v86.network_adapter.receive_packet()")
            .map_err(|e| JsValue::from_str(&format!("Failed to call v86: {:?}", e)))?;

        Ok(())
    }

    #[wasm_bindgen(js_name = getMacAddress)]
    pub fn get_mac_address(&self) -> Uint8Array {
        let array = Uint8Array::new_with_length(6);
        array.copy_from_slice(&self.mac_address);
        array
    }

    #[wasm_bindgen(js_name = getMtu)]
    pub fn get_mtu(&self) -> u16 {
        self.mtu
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;
    use crate::crypto::CryptoState;

    wasm_bindgen_test_configure!(run_in_browser);

    fn create_test_network() -> VmNetwork {
        let crypto = CryptoState::new().unwrap();
        let network = NetworkState::new(Arc::new(crypto));
        let mac = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
        VmNetwork::new(network, &mac).unwrap()
    }

    #[wasm_bindgen_test]
    fn test_mac_address() {
        let network = create_test_network();
        let mac = network.get_mac_address();
        assert_eq!(mac.length(), 6);
        assert_eq!(mac.to_vec(), vec![0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
    }

    #[wasm_bindgen_test]
    fn test_mtu() {
        let network = create_test_network();
        assert_eq!(network.get_mtu(), 1500);
    }

    #[wasm_bindgen_test]
    fn test_send_packet() {
        let network = create_test_network();
        
        // Create test IPv4 packet
        let mut packet = vec![0u8; 64];
        packet[0..6].copy_from_slice(&[0x52, 0x54, 0x00, 0x12, 0x34, 0x56]); // Dest MAC
        packet[6..12].copy_from_slice(&[0x52, 0x54, 0x00, 0x12, 0x34, 0x57]); // Source MAC
        packet[12..14].copy_from_slice(&[0x08, 0x00]); // IPv4 ethertype
        
        let result = network.send_packet(&packet);
        assert!(result.is_ok());
    }

    #[wasm_bindgen_test]
    fn test_receive_packet() {
        let network = create_test_network();
        
        // Create test IPv4 payload
        let payload = vec![0u8; 40];
        
        let result = network.receive_packet(&payload);
        assert!(result.is_ok());
    }
}
