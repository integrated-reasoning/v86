"use strict";

const assert = require("assert");
const { VMEffectNetworkAdapter } = require("../../src/browser/vmeffect_network");
const { DERPProtocol, DERPCrypto, PROTOCOL_VERSION, FRAME_TYPES, FRAME_HEADER_LENGTH } = require("../../src/browser/derp_protocol");

// Mock crypto for testing
const mockCryptoObj = {
    subtle: {
        generateKey: async (algorithm, extractable, keyUsages) => ({
            publicKey: {
                type: "public",
                algorithm: { name: "ECDH", namedCurve: "P-256" },
                extractable: true,
                usages: ["deriveKey", "deriveBits"]
            },
            privateKey: {
                type: "private",
                algorithm: { name: "ECDH", namedCurve: "P-256" },
                extractable: true,
                usages: ["deriveKey", "deriveBits"]
            }
        }),
        deriveKey: async (algorithm, baseKey, derivedKeyAlgorithm, extractable, keyUsages) => ({
            type: "secret",
            algorithm: { name: "AES-GCM", length: 256 },
            extractable: false,
            usages: ["encrypt", "decrypt"]
        }),
        deriveBits: async (algorithm, baseKey, length) => {
            return new Uint8Array(32).fill(2).buffer;
        },
        encrypt: async (algorithm, key, data) => {
            // Simple mock encryption - just append IV
            const result = new Uint8Array(data.length + algorithm.iv.length);
            result.set(algorithm.iv);
            result.set(new Uint8Array(data), algorithm.iv.length);
            return result.buffer;
        },
        decrypt: async (algorithm, key, data) => {
            // Simple mock decryption - just remove IV
            return new Uint8Array(data).slice(algorithm.iv.length).buffer;
        },
        exportKey: async (format, key) => {
            if (format === "raw") {
                return new Uint8Array(32).fill(1).buffer;
            }
            return key;
        },
        importKey: async (format, keyData, algorithm, extractable, keyUsages) => {
            if (format === "raw") {
                return {
                    type: "secret",
                    algorithm: { name: "AES-GCM", length: 256 },
                    extractable: false,
                    usages: keyUsages
                };
            }
            return {
                type: "public",
                algorithm: { name: "ECDH", namedCurve: "P-256" },
                extractable: true,
                usages: keyUsages
            };
        }
    },
    getRandomValues: (arr) => {
        arr.fill(5);
        return arr;
    }
};

// Mock Tailscale environment
const mockTailscaleEnv = {
    DERP_SERVER_URL: "wss://test.derp.example.com",
    DERP_AUTH_TOKEN: "test-token",
    DERP_MAC_ADDRESS: "00:11:22:33:44:55"
};

// Helper to mock and restore crypto
function mockCrypto() {
    const descriptor = Object.getOwnPropertyDescriptor(global, 'crypto');
    const originalCrypto = descriptor ? descriptor.value : undefined;
    
    Object.defineProperty(global, 'crypto', {
        value: mockCryptoObj,
        configurable: true,
        writable: true
    });
    
    return originalCrypto;
}

// Helper to restore crypto
function restoreCrypto(originalCrypto) {
    if (originalCrypto === undefined) {
        delete global.crypto;
    } else {
        Object.defineProperty(global, 'crypto', {
            value: originalCrypto,
            configurable: true,
            writable: true
        });
    }
}

// Helper to create frames
function createFrame(type, payload) {
    // Convert payload to Uint8Array if it's an ArrayBuffer or array-like
    let payloadArray;
    if (payload instanceof Uint8Array) {
        payloadArray = payload;
        console.log('Payload is Uint8Array');
    } else if (payload instanceof ArrayBuffer) {
        payloadArray = new Uint8Array(payload);
        console.log('Payload is ArrayBuffer');
    } else if (ArrayBuffer.isView(payload)) {
        payloadArray = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        console.log('Payload is ArrayBufferView');
    } else {
        throw new Error('Invalid payload type: ' + payload.constructor.name);
    }
    
    console.log('Frame details:', {
        headerLength: FRAME_HEADER_LENGTH,
        payloadLength: payloadArray.byteLength,
        totalLength: FRAME_HEADER_LENGTH + payloadArray.byteLength,
        type,
        payloadArray: {
            byteLength: payloadArray.byteLength,
            byteOffset: payloadArray.byteOffset,
            buffer: payloadArray.buffer ? true : false
        }
    });
    
    const frame = new Uint8Array(FRAME_HEADER_LENGTH + payloadArray.byteLength);
    frame[0] = PROTOCOL_VERSION;
    frame[1] = type;
    frame[2] = 0;
    frame[3] = (payloadArray.byteLength >> 8) & 0xFF;
    frame[4] = payloadArray.byteLength & 0xFF;
    
    console.log('Setting payload at offset:', FRAME_HEADER_LENGTH);
    frame.set(payloadArray, FRAME_HEADER_LENGTH);
    return frame;
}

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
        this.readyState = 0; // CONNECTING
        
        // Simulate connection
        setTimeout(async () => {
            this.readyState = 1; // OPEN
            if (this.onopen) {
                this.onopen({ target: this });
            }
            
            // Send server key immediately after connection
            const serverKey = new Uint8Array(32).fill(1);
            const frame = createFrame(FRAME_TYPES.SERVER_KEY, serverKey);
            if (this.onmessage) {
                this.onmessage({
                    target: this,
                    data: frame.buffer,
                    binary: true
                });
            }
            
            // Wait for client info
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Create mock session key for server info encryption
            const mockSessionKey = await crypto.subtle.importKey(
                "raw",
                new Uint8Array(32).fill(2),
                { name: "AES-GCM" },
                false,
                ["encrypt"]
            );
            
            // Encrypt server info
            const serverInfo = new TextEncoder().encode(JSON.stringify({
                version: 1,
                region: "test",
                name: "test-server"
            }));
            
            const iv = new Uint8Array(12).fill(3);
            const encrypted = await crypto.subtle.encrypt(
                {
                    name: "AES-GCM",
                    iv
                },
                mockSessionKey,
                serverInfo
            );
            
            // Combine IV and encrypted data
            const encryptedWithIV = new Uint8Array(iv.length + encrypted.byteLength);
            encryptedWithIV.set(iv);
            encryptedWithIV.set(new Uint8Array(encrypted), iv.length);
            
            // Send encrypted server info
            const infoFrame = createFrame(FRAME_TYPES.SERVER_INFO, encryptedWithIV);
            if (this.onmessage) {
                this.onmessage({
                    target: this,
                    data: infoFrame.buffer,
                    binary: true
                });
            }
        }, 0);
    }
    
    send(data) {
        if (this.readyState !== 1) {
            throw new Error("WebSocket is not open");
        }
        // Store sent data as Uint8Array
        this.sent.push(new Uint8Array(data));
    }
    
    close() {
        this.readyState = 3; // CLOSED
        if (this.onclose) {
            this.onclose({ target: this, code: 1000 });
        }
    }
    
    // Helper to simulate incoming messages
    simulateMessage(data) {
        if (this.readyState !== 1) {
            throw new Error("WebSocket is not open");
        }
        
        // Ensure data is Uint8Array
        const messageData = data instanceof Uint8Array ? data : new Uint8Array(data);
        
        if (this.onmessage) {
            this.onmessage({ 
                target: this, 
                data: messageData.buffer,
                binary: true
            });
        }
    }
}

describe("DERP Protocol", () => {
    let keyPair;
    let protocol;
    let originalCrypto;
    
    beforeEach(async () => {
        originalCrypto = mockCrypto();
        keyPair = await DERPCrypto.generateKeyPair();
        protocol = new DERPProtocol(keyPair);
    });
    
    afterEach(() => {
        restoreCrypto(originalCrypto);
    });
    
    it("should create and decode frame headers", () => {
        const data = new Uint8Array([1, 2, 3, 0, 5]);
        const header = protocol.decodeFrameHeader(data);
        
        assert.strictEqual(header.version, 1);
        assert.strictEqual(header.type, 2);
        assert.strictEqual(header.flags, 3);
        assert.strictEqual(header.length, 5);
    });
    
    it("should handle server key exchange", async () => {
        const serverKey = new Uint8Array(32).fill(1);
        await protocol.handleServerKey(serverKey);
        
        assert(protocol.serverKey);
        assert(protocol.sessionKey);
    });
    
    it("should create and handle client info", async () => {
        // First handle server key
        const serverKey = new Uint8Array(32).fill(1);
        await protocol.handleServerKey(serverKey);
        
        // Create and verify client info
        const clientInfo = { version: 1, token: "test" };
        const frame = await protocol.createClientInfo(clientInfo);
        
        assert(frame instanceof Uint8Array);
        const header = protocol.decodeFrameHeader(frame);
        assert.strictEqual(header.type, FRAME_TYPES.CLIENT_INFO);
    });
    
    it("should handle peer state changes", async () => {
        // First handle server key
        const serverKey = new Uint8Array(32).fill(1);
        await protocol.handleServerKey(serverKey);
        
        // Add a peer
        const peerKey = new Uint8Array(32).fill(2);
        protocol.handlePeerState(FRAME_TYPES.PEER_PRESENT, peerKey);
        
        assert.strictEqual(protocol.peerKeys.size, 1);
        
        // Remove the peer
        protocol.handlePeerState(FRAME_TYPES.PEER_GONE, peerKey);
        assert.strictEqual(protocol.peerKeys.size, 0);
    });
});

describe("VMEffectNetworkAdapter", () => {
    let adapter;
    let serverKeyPair;
    let originalWebSocket;
    let originalCrypto;
    
    beforeEach(async () => {
        // Save originals
        originalWebSocket = global.WebSocket;
        originalCrypto = mockCrypto();
        
        // Mock WebSocket
        global.WebSocket = MockWebSocket;
        
        // Generate server key pair
        serverKeyPair = await DERPCrypto.generateKeyPair();
        
        // Create adapter with mock Tailscale environment
        adapter = new VMEffectNetworkAdapter({
            url: mockTailscaleEnv.DERP_SERVER_URL,
            token: mockTailscaleEnv.DERP_AUTH_TOKEN,
            macAddress: mockTailscaleEnv.DERP_MAC_ADDRESS,
            onPacket() {}
        });
        
        // Wait for WebSocket to be ready and handshake to complete
        await new Promise(resolve => {
            const checkConnection = () => {
                if (adapter.connected) {
                    resolve();
                } else {
                    setTimeout(checkConnection, 10);
                }
            };
            checkConnection();
        });
        
        // Add a mock peer
        const peerKey = new Uint8Array(32).fill(3);
        adapter.derp.handlePeerState(FRAME_TYPES.PEER_PRESENT, peerKey);
    });
    
    afterEach(() => {
        if (adapter) {
            adapter.destroy();
        }
        
        // Restore originals
        global.WebSocket = originalWebSocket;
        restoreCrypto(originalCrypto);
    });
    
    it("should establish connection and complete handshake", async () => {
        // Verify connection is established
        assert.strictEqual(adapter.ws.readyState, 1);
        assert.strictEqual(adapter.connected, true);
        
        // Verify client info was sent
        assert(adapter.ws.sent.length > 0);
        const sentFrame = adapter.ws.sent[0];
        const header = new DERPProtocol(serverKeyPair).decodeFrameHeader(sentFrame);
        assert.strictEqual(header.type, FRAME_TYPES.CLIENT_INFO);
    });
    
    it("should handle packet sending and receiving", async () => {
        // Send test packet
        const testPacket = new Uint8Array([1, 2, 3, 4]);
        const destKey = new Uint8Array(32).fill(3); // Use mock peer key
        adapter.send(testPacket, destKey);
        
        // Wait for packet to be sent
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Verify packet was sent
        assert(adapter.ws.sent.length > 1);
        const sentFrame = adapter.ws.sent[1];
        const header = new DERPProtocol(serverKeyPair).decodeFrameHeader(sentFrame);
        assert.strictEqual(header.type, FRAME_TYPES.SEND_PACKET);
    });
    
    it("should track network statistics", async () => {
        // Send test packet
        const testPacket = new Uint8Array([1, 2, 3, 4]);
        const destKey = new Uint8Array(32).fill(3); // Use mock peer key
        adapter.send(testPacket, destKey);
        
        // Wait for stats to update
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Check stats
        const stats = adapter.getStats();
        assert(stats.bytesSent > 0);
        assert.strictEqual(stats.bytesReceived, 0);
        assert.strictEqual(stats.packetsDropped, 0);
    });
});

after(() => {
    restoreCrypto(undefined);
});
