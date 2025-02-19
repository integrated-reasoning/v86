"use strict";

const PROTOCOL_VERSION = 1;
const FRAME_HEADER_LENGTH = 5;

const FRAME_TYPES = {
    SERVER_KEY: 1,
    CLIENT_INFO: 2,
    SERVER_INFO: 3,
    SEND_PACKET: 4,
    RECV_PACKET: 5,
    PEER_PRESENT: 6,
    PEER_GONE: 7,
    KEEP_ALIVE: 8
};

class DERPProtocol {
    constructor(keyPair) {
        this.keyPair = keyPair;
        this.serverKey = null;
        this.serverInfo = null;
        this.peerKeys = new Map();
        this.sessionKey = null;
    }

    decodeFrameHeader(data) {
        if (data.length < FRAME_HEADER_LENGTH) {
            throw new Error("Frame too short");
        }

        return {
            version: data[0],
            type: data[1],
            flags: data[2],
            length: (data[3] << 8) | data[4]
        };
    }

    async handleServerKey(payload) {
        if (payload.length !== 32) {
            throw new Error("Invalid server key length");
        }

        this.serverKey = payload;
        this.sessionKey = await this.deriveSessionKey(this.serverKey);
    }

    async createClientInfo(info) {
        const data = new TextEncoder().encode(JSON.stringify(info));
        const encrypted = await this.encrypt(data);
        
        return this.createFrame(FRAME_TYPES.CLIENT_INFO, encrypted);
    }

    async handleServerInfo(payload) {
        const decrypted = await this.decrypt(payload);
        const info = JSON.parse(new TextDecoder().decode(decrypted));
        this.serverInfo = info;
        return info;
    }

    handlePeerState(type, payload) {
        const peerKey = payload.slice(0, 32).toString('hex');
        
        if (type === FRAME_TYPES.PEER_PRESENT) {
            this.peerKeys.set(peerKey, {
                lastSeen: Date.now()
            });
        } else if (type === FRAME_TYPES.PEER_GONE) {
            this.peerKeys.delete(peerKey);
        }
    }

    createPacketFrame(packet, destKey) {
        const header = new Uint8Array(32 + packet.length);
        header.set(destKey);
        header.set(packet, 32);
        
        return this.createFrame(FRAME_TYPES.SEND_PACKET, header);
    }

    handleRecvPacket(payload) {
        const srcKey = payload.slice(0, 32);
        const packet = payload.slice(32);
        
        return {
            srcKey: srcKey.toString('hex'),
            packet
        };
    }

    createFrame(type, payload) {
        const header = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
        
        header[0] = PROTOCOL_VERSION;
        header[1] = type;
        header[2] = 0; // flags
        header[3] = (payload.length >> 8) & 0xFF;
        header[4] = payload.length & 0xFF;
        
        header.set(payload, FRAME_HEADER_LENGTH);
        
        return header;
    }

    async encrypt(data) {
        if (!this.sessionKey) {
            throw new Error("No session key");
        }

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv
            },
            this.sessionKey,
            data
        );

        const result = new Uint8Array(iv.length + encrypted.byteLength);
        result.set(iv);
        result.set(new Uint8Array(encrypted), iv.length);
        
        return result;
    }

    async decrypt(data) {
        if (!this.sessionKey) {
            throw new Error("No session key");
        }

        const iv = data.slice(0, 12);
        const encrypted = data.slice(12);

        return new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv
                },
                this.sessionKey,
                encrypted
            )
        );
    }

    async deriveSessionKey(serverKey) {
        const sharedSecret = await crypto.subtle.deriveBits(
            {
                name: "ECDH",
                public: await crypto.subtle.importKey(
                    "raw",
                    serverKey,
                    {
                        name: "ECDH",
                        namedCurve: "P-256"
                    },
                    true,
                    []
                )
            },
            this.keyPair.privateKey,
            256
        );

        return crypto.subtle.importKey(
            "raw",
            sharedSecret,
            {
                name: "AES-GCM",
                length: 256
            },
            true,
            ["encrypt", "decrypt"]
        );
    }
}

// Crypto helper for key generation
const DERPCrypto = {
    async generateKeyPair() {
        return crypto.subtle.generateKey(
            {
                name: "ECDH",
                namedCurve: "P-256"
            },
            true,
            ["deriveKey", "deriveBits"]
        );
    }
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        DERPProtocol,
        DERPCrypto,
        PROTOCOL_VERSION,
        FRAME_TYPES,
        FRAME_HEADER_LENGTH
    };
}
