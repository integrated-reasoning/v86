"use strict";

const assert = require("assert");
const { VMEffectNetworkAdapter } = require("../../src/browser/vmeffect_network");
const { DERPCrypto, DERP_MAGIC } = require("../../src/browser/derp_crypto");
const { FRAME_TYPES, FRAME_HEADER_LENGTH } = require("../../src/browser/derp_protocol");

// Mock WebSocket for testing
class MockWebSocket {
    constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.sent = [];
        this.binaryType = "arraybuffer";
        
        // Simulate connection
        setTimeout(() => this.onopen && this.onopen(), 0);
    }
    
    send(data) {
        this.sent.push(data);
    }
    
    close() {
        this.onclose && this.onclose();
    }
    
    // Helper to simulate incoming messages
    receiveMessage(data) {
        this.onmessage && this.onmessage({ data });
    }
}

// Store original WebSocket and crypto
const OriginalWebSocket = global.WebSocket;
const OriginalCrypto = global.crypto;

describe("VMEffectNetworkAdapter", () => {
    let serverKeyPair;
    
    beforeEach(async () => {
        // Replace WebSocket with mock
        global.WebSocket = MockWebSocket;
        
        // Generate server key pair for testing
        serverKeyPair = await DERPCrypto.generateKeyPair();
    });
    
    afterEach(() => {
        // Restore originals
        global.WebSocket = OriginalWebSocket;
        global.crypto = OriginalCrypto;
    });
    
    it("should establish connection and handle server key", async () => {
        const adapter = new VMEffectNetworkAdapter({
            url: "wss://test.derp.example.com",
            token: "test-token",
            macAddress: "52:54:00:12:34:56",
            onPacket: () => {}
        });
        
        // Wait for connection
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Send server key
        const serverKey = new Uint8Array(40); // 8B magic + 32B key
        serverKey.set(DERP_MAGIC);
        serverKey.set(serverKeyPair.publicKey, 8);
        
        const serverKeyFrame = new Uint8Array(FRAME_HEADER_LENGTH + serverKey.length);
        serverKeyFrame[0] = FRAME_TYPES.SERVER_KEY;
        new DataView(serverKeyFrame.buffer).setUint32(1, serverKey.length, false);
        serverKeyFrame.set(serverKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverKeyFrame.buffer);
        
        // Wait for client info
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Verify client info frame
        const clientInfo = adapter.ws.sent[0];
        assert.strictEqual(clientInfo[0], FRAME_TYPES.CLIENT_INFO);
        
        // Length is in next 4 bytes (big-endian)
        const length = new DataView(clientInfo.buffer).getUint32(1, false);
        assert.strictEqual(clientInfo.length, FRAME_HEADER_LENGTH + length);
    });
    
    it("should handle server info and complete handshake", async () => {
        const adapter = new VMEffectNetworkAdapter({
            url: "wss://test.derp.example.com",
            token: "test-token",
            macAddress: "52:54:00:12:34:56",
            onPacket: () => {}
        });
        
        // Wait for connection and send server key
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const serverKey = new Uint8Array(40);
        serverKey.set(DERP_MAGIC);
        serverKey.set(serverKeyPair.publicKey, 8);
        
        const serverKeyFrame = new Uint8Array(FRAME_HEADER_LENGTH + serverKey.length);
        serverKeyFrame[0] = FRAME_TYPES.SERVER_KEY;
        new DataView(serverKeyFrame.buffer).setUint32(1, serverKey.length, false);
        serverKeyFrame.set(serverKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverKeyFrame.buffer);
        
        // Wait for client info and send server info
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const info = {
            version: 2,
            name: "test-server",
            region: "test-region"
        };
        
        const nonce = DERPCrypto.generateNonce();
        const infoJson = JSON.stringify(info);
        const infoBytes = new TextEncoder().encode(infoJson);
        
        const encrypted = await DERPCrypto.boxSeal(
            infoBytes,
            nonce,
            adapter.keyPair.publicKey,
            serverKeyPair.privateKey
        );
        
        const payload = new Uint8Array(nonce.length + encrypted.length);
        payload.set(nonce);
        payload.set(encrypted, nonce.length);
        
        const serverInfoFrame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
        serverInfoFrame[0] = FRAME_TYPES.SERVER_INFO;
        new DataView(serverInfoFrame.buffer).setUint32(1, payload.length, false);
        serverInfoFrame.set(payload, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverInfoFrame.buffer);
        
        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 10));
        
        assert.strictEqual(adapter.connected, true);
    });
    
    it("should handle packet sending and receiving", async () => {
        let receivedPacket = null;
        
        const adapter = new VMEffectNetworkAdapter({
            url: "wss://test.derp.example.com",
            token: "test-token",
            macAddress: "52:54:00:12:34:56",
            onPacket: (packet) => {
                receivedPacket = packet;
            }
        });
        
        // Complete handshake
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const serverKey = new Uint8Array(40);
        serverKey.set(DERP_MAGIC);
        serverKey.set(serverKeyPair.publicKey, 8);
        
        const serverKeyFrame = new Uint8Array(FRAME_HEADER_LENGTH + serverKey.length);
        serverKeyFrame[0] = FRAME_TYPES.SERVER_KEY;
        new DataView(serverKeyFrame.buffer).setUint32(1, serverKey.length, false);
        serverKeyFrame.set(serverKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverKeyFrame.buffer);
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const info = {
            version: 2,
            name: "test-server",
            region: "test-region"
        };
        
        const nonce = DERPCrypto.generateNonce();
        const infoJson = JSON.stringify(info);
        const infoBytes = new TextEncoder().encode(infoJson);
        
        const encrypted = await DERPCrypto.boxSeal(
            infoBytes,
            nonce,
            adapter.keyPair.publicKey,
            serverKeyPair.privateKey
        );
        
        const payload = new Uint8Array(nonce.length + encrypted.length);
        payload.set(nonce);
        payload.set(encrypted, nonce.length);
        
        const serverInfoFrame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
        serverInfoFrame[0] = FRAME_TYPES.SERVER_INFO;
        new DataView(serverInfoFrame.buffer).setUint32(1, payload.length, false);
        serverInfoFrame.set(payload, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverInfoFrame.buffer);
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Add a peer
        const peerKey = new Uint8Array(32);
        window.crypto.getRandomValues(peerKey);
        
        const peerFrame = new Uint8Array(FRAME_HEADER_LENGTH + peerKey.length);
        peerFrame[0] = FRAME_TYPES.PEER_PRESENT;
        new DataView(peerFrame.buffer).setUint32(1, peerKey.length, false);
        peerFrame.set(peerKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(peerFrame.buffer);
        
        // Send packet
        const testPacket = new Uint8Array([1, 2, 3, 4]);
        adapter.send(testPacket);
        
        // Verify sent packet
        const sentPacket = adapter.ws.sent[1]; // First message was client info
        assert.strictEqual(sentPacket[0], FRAME_TYPES.SEND_PACKET);
        
        // Receive packet
        const recvPayload = new Uint8Array(32 + testPacket.length);
        recvPayload.set(peerKey);
        recvPayload.set(testPacket, 32);
        
        const recvFrame = new Uint8Array(FRAME_HEADER_LENGTH + recvPayload.length);
        recvFrame[0] = FRAME_TYPES.RECV_PACKET;
        new DataView(recvFrame.buffer).setUint32(1, recvPayload.length, false);
        recvFrame.set(recvPayload, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(recvFrame.buffer);
        
        assert.deepStrictEqual(Array.from(receivedPacket), [1, 2, 3, 4]);
    });
    
    it("should handle disconnection and reconnection", async () => {
        const adapter = new VMEffectNetworkAdapter({
            url: "wss://test.derp.example.com",
            token: "test-token",
            macAddress: "52:54:00:12:34:56",
            onPacket: () => {}
        });
        
        // Complete handshake
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const serverKey = new Uint8Array(40);
        serverKey.set(DERP_MAGIC);
        serverKey.set(serverKeyPair.publicKey, 8);
        
        const serverKeyFrame = new Uint8Array(FRAME_HEADER_LENGTH + serverKey.length);
        serverKeyFrame[0] = FRAME_TYPES.SERVER_KEY;
        new DataView(serverKeyFrame.buffer).setUint32(1, serverKey.length, false);
        serverKeyFrame.set(serverKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverKeyFrame.buffer);
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const info = {
            version: 2,
            name: "test-server",
            region: "test-region"
        };
        
        const nonce = DERPCrypto.generateNonce();
        const infoJson = JSON.stringify(info);
        const infoBytes = new TextEncoder().encode(infoJson);
        
        const encrypted = await DERPCrypto.boxSeal(
            infoBytes,
            nonce,
            adapter.keyPair.publicKey,
            serverKeyPair.privateKey
        );
        
        const payload = new Uint8Array(nonce.length + encrypted.length);
        payload.set(nonce);
        payload.set(encrypted, nonce.length);
        
        const serverInfoFrame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
        serverInfoFrame[0] = FRAME_TYPES.SERVER_INFO;
        new DataView(serverInfoFrame.buffer).setUint32(1, payload.length, false);
        serverInfoFrame.set(payload, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverInfoFrame.buffer);
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Simulate disconnection
        adapter.ws.close();
        
        assert.strictEqual(adapter.connected, false);
        assert.strictEqual(adapter.ws, null);
        
        // Wait for reconnection attempt
        await new Promise(resolve => setTimeout(resolve, 1100));
        
        assert.notStrictEqual(adapter.ws, null);
    });
    
    it("should track network statistics", async () => {
        const adapter = new VMEffectNetworkAdapter({
            url: "wss://test.derp.example.com",
            token: "test-token",
            macAddress: "52:54:00:12:34:56",
            onPacket: () => {}
        });
        
        // Complete handshake
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const serverKey = new Uint8Array(40);
        serverKey.set(DERP_MAGIC);
        serverKey.set(serverKeyPair.publicKey, 8);
        
        const serverKeyFrame = new Uint8Array(FRAME_HEADER_LENGTH + serverKey.length);
        serverKeyFrame[0] = FRAME_TYPES.SERVER_KEY;
        new DataView(serverKeyFrame.buffer).setUint32(1, serverKey.length, false);
        serverKeyFrame.set(serverKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverKeyFrame.buffer);
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const info = {
            version: 2,
            name: "test-server",
            region: "test-region"
        };
        
        const nonce = DERPCrypto.generateNonce();
        const infoJson = JSON.stringify(info);
        const infoBytes = new TextEncoder().encode(infoJson);
        
        const encrypted = await DERPCrypto.boxSeal(
            infoBytes,
            nonce,
            adapter.keyPair.publicKey,
            serverKeyPair.privateKey
        );
        
        const payload = new Uint8Array(nonce.length + encrypted.length);
        payload.set(nonce);
        payload.set(encrypted, nonce.length);
        
        const serverInfoFrame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
        serverInfoFrame[0] = FRAME_TYPES.SERVER_INFO;
        new DataView(serverInfoFrame.buffer).setUint32(1, payload.length, false);
        serverInfoFrame.set(payload, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(serverInfoFrame.buffer);
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Add a peer
        const peerKey = new Uint8Array(32);
        window.crypto.getRandomValues(peerKey);
        
        const peerFrame = new Uint8Array(FRAME_HEADER_LENGTH + peerKey.length);
        peerFrame[0] = FRAME_TYPES.PEER_PRESENT;
        new DataView(peerFrame.buffer).setUint32(1, peerKey.length, false);
        peerFrame.set(peerKey, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(peerFrame.buffer);
        
        // Send and receive some packets
        const testPacket = new Uint8Array([1, 2, 3, 4]);
        adapter.send(testPacket);
        
        const recvPayload = new Uint8Array(32 + 4);
        recvPayload.set(peerKey);
        recvPayload.set([5, 6, 7, 8], 32);
        
        const recvFrame = new Uint8Array(FRAME_HEADER_LENGTH + recvPayload.length);
        recvFrame[0] = FRAME_TYPES.RECV_PACKET;
        new DataView(recvFrame.buffer).setUint32(1, recvPayload.length, false);
        recvFrame.set(recvPayload, FRAME_HEADER_LENGTH);
        
        adapter.ws.receiveMessage(recvFrame.buffer);
        
        const stats = adapter.getStats();
        assert.strictEqual(stats.bytesSent, 4);
        assert.strictEqual(stats.bytesReceived, 4);
        assert.strictEqual(stats.packetsDropped, 0);
    });
});
