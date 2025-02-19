#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;
    use rand::Rng;

    wasm_bindgen_test_configure!(run_in_browser);

    fn create_test_packet() -> Vec<u8> {
        let mut rng = rand::thread_rng();
        let mut packet = vec![0u8; 1500]; // Standard MTU size
        rng.fill(&mut packet[..]);
        packet
    }

    #[wasm_bindgen_test]
    async fn test_key_generation() {
        let protocol = DerpProtocol::new();
        let key_pair = protocol.generate_key_pair().await;
        assert!(!key_pair.is_empty());
    }

    #[wasm_bindgen_test]
    async fn test_session_creation() {
        let protocol = DerpProtocol::new();
        let session_id = protocol.create_session().await;
        assert!(!session_id.is_empty());
    }

    #[wasm_bindgen_test]
    async fn test_packet_encryption_decryption() {
        let protocol = DerpProtocol::new();
        let session_id = protocol.create_session().await;
        let original_packet = create_test_packet();

        // Encrypt packet
        let encrypted = protocol.encrypt_packet(&session_id, &original_packet).await;
        assert!(!encrypted.is_empty());
        assert_ne!(encrypted, original_packet);

        // Decrypt packet
        let decrypted = protocol.decrypt_packet(&session_id, &encrypted).await;
        assert_eq!(decrypted, original_packet);
    }

    #[wasm_bindgen_test]
    async fn test_packet_integrity() {
        let protocol = DerpProtocol::new();
        let session_id = protocol.create_session().await;
        let original_packet = create_test_packet();

        // Encrypt packet
        let mut encrypted = protocol.encrypt_packet(&session_id, &original_packet).await;
        
        // Tamper with encrypted data
        if let Some(byte) = encrypted.get_mut(encrypted.len() / 2) {
            *byte ^= 0xFF;
        }

        // Decryption should fail
        let result = protocol.decrypt_packet(&session_id, &encrypted).await;
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    async fn test_session_isolation() {
        let protocol = DerpProtocol::new();
        let session_1 = protocol.create_session().await;
        let session_2 = protocol.create_session().await;
        let packet = create_test_packet();

        // Encrypt with session 1
        let encrypted = protocol.encrypt_packet(&session_1, &packet).await;

        // Attempt to decrypt with session 2 should fail
        let result = protocol.decrypt_packet(&session_2, &encrypted).await;
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    async fn test_packet_compression() {
        let protocol = DerpProtocol::new();
        let session_id = protocol.create_session().await;
        
        // Create a highly compressible packet
        let mut packet = vec![0u8; 1500];
        for i in 0..packet.len() {
            packet[i] = (i % 4) as u8;
        }

        // Encrypt packet
        let encrypted = protocol.encrypt_packet(&session_id, &packet).await;

        // Encrypted size should be smaller than original due to compression
        assert!(encrypted.len() < packet.len());

        // Decrypt and verify
        let decrypted = protocol.decrypt_packet(&session_id, &encrypted).await;
        assert_eq!(decrypted, packet);
    }

    #[wasm_bindgen_test]
    async fn test_large_packets() {
        let protocol = DerpProtocol::new();
        let session_id = protocol.create_session().await;
        
        // Test with various packet sizes
        for size in [64, 512, 1500, 4096, 9000] {
            let packet = vec![0u8; size];
            let encrypted = protocol.encrypt_packet(&session_id, &packet).await;
            let decrypted = protocol.decrypt_packet(&session_id, &encrypted).await;
            assert_eq!(decrypted, packet);
        }
    }

    #[wasm_bindgen_test]
    async fn test_concurrent_operations() {
        let protocol = DerpProtocol::new();
        let session_id = protocol.create_session().await;
        let packet = create_test_packet();

        // Perform multiple encryption/decryption operations concurrently
        let mut handles = vec![];
        for _ in 0..5 {
            let protocol_clone = protocol.clone();
            let session_id_clone = session_id.clone();
            let packet_clone = packet.clone();
            
            handles.push(wasm_bindgen_futures::spawn_local(async move {
                let encrypted = protocol_clone.encrypt_packet(&session_id_clone, &packet_clone).await;
                let decrypted = protocol_clone.decrypt_packet(&session_id_clone, &encrypted).await;
                assert_eq!(decrypted, packet_clone);
            }));
        }

        // Wait for all operations to complete
        for handle in handles {
            handle.await;
        }
    }
}
