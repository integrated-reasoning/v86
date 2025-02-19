"use strict";

class DerpNetworkAdapter {
    constructor(options) {
        this.relay_url = options.relay_url;
        this.connected = false;
        this.websocket = null;
        this.packetQueue = [];
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.maxReconnectDelay = 32000;
        this.testMode = options.testMode || false;
        this.sessionId = null;
        
        // In test mode, use provided protocol or create a mock
        if (this.testMode) {
            this.derpProtocol = options.derpProtocol || {
                generateKeyPair: async () => new Uint8Array([1, 2, 3, 4]),
                createSession: async () => "test-session",
                encryptPacket: async (sessionId, data) => data,
                decryptPacket: async (sessionId, data) => data,
            };
        }
    }

    async connect() {
        if (this.connected) {
            return true;
        }

        try {
            this.websocket = new WebSocket(this.relay_url);
            this.websocket.binaryType = "arraybuffer";

            return new Promise(async (resolve) => {
                this.websocket.onopen = async () => {
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    this.reconnectDelay = 1000;
                    
                    // Initialize session if not already done
                    if (!this.sessionId) {
                        this.sessionId = await this.derpProtocol.createSession();
                    }
                    
                    await this.flushPacketQueue();
                    resolve(true);
                };

                this.websocket.onclose = () => {
                    const wasConnected = this.connected;
                    this.handleDisconnect();
                    
                    if (!wasConnected) {
                        resolve(false);
                    }
                };

                this.websocket.onerror = (error) => {
                    console.error("WebSocket error:", error);
                    if (!this.connected) {
                        resolve(false);
                    }
                };

                this.websocket.onmessage = async (event) => {
                    try {
                        // Convert received data to Uint8Array
                        const data = event.data instanceof ArrayBuffer ? 
                            new Uint8Array(event.data) : 
                            new Uint8Array(event.data.buffer);
                            
                        const decryptedData = await this.derpProtocol.decryptPacket(this.sessionId, data);
                        if (this.receiveCallback) {
                            // Ensure we always return a new Uint8Array
                            const finalData = decryptedData instanceof Uint8Array ? 
                                decryptedData : 
                                new Uint8Array(decryptedData.buffer || decryptedData);
                            this.receiveCallback(finalData);
                        }
                    } catch (error) {
                        console.error("Failed to handle packet:", error);
                    }
                };
            });
        } catch (error) {
            console.error("Failed to connect:", error);
            return false;
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.websocket = null;

        // Calculate exponential backoff delay (2^n seconds)
        this.reconnectDelay = Math.min(
            1000 * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        );

        // Schedule reconnection
        if (!this.testMode) {
            setTimeout(() => this.connect(), this.reconnectDelay);
        }
        
        // Increment attempts after calculating delay
        this.reconnectAttempts++;
    }

    disconnect() {
        if (this.websocket) {
            const ws = this.websocket;
            this.websocket = null;
            this.connected = false;
            ws.close();
            
            // Calculate exponential backoff delay (2^n seconds)
            this.reconnectDelay = Math.min(
                1000 * Math.pow(2, this.reconnectAttempts),
                this.maxReconnectDelay
            );
            
            // Increment attempts after calculating delay
            this.reconnectAttempts++;
        }
    }

    async send(data) {
        // Ensure data is Uint8Array
        const packet = data instanceof Uint8Array ? 
            data : 
            new Uint8Array(data.buffer || data);
        
        if (!this.connected) {
            this.packetQueue.push(packet);
            return;
        }

        try {
            const encryptedData = await this.derpProtocol.encryptPacket(this.sessionId, packet);
            // Always send an ArrayBuffer
            const finalData = encryptedData instanceof ArrayBuffer ? 
                encryptedData : 
                (encryptedData.buffer || encryptedData);
            this.websocket.send(finalData);
        } catch (error) {
            console.error("Failed to send packet:", error);
            throw error;
        }
    }

    receive(callback) {
        this.receiveCallback = callback;
    }

    async flushPacketQueue() {
        const queue = [...this.packetQueue];
        this.packetQueue = [];
        
        for (const packet of queue) {
            if (this.connected) {
                await this.send(packet);
            } else {
                this.packetQueue.push(packet);
                break;
            }
        }
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = DerpNetworkAdapter;
}
