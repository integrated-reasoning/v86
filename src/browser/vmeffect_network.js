"use strict";

/**
 * vmEffect WebSocket-based network adapter for v86
 * Implements secure networking through DERP relay infrastructure
 */
class VMEffectNetworkAdapter {
    constructor(options) {
        this.url = options.url;
        this.token = options.token;
        this.onPacket = options.onPacket;
        this.macAddress = options.macAddress;
        
        // Connection state
        this.ws = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        
        // Session management
        this.sessionToken = null;
        this.refreshToken = null;
        this.tokenRefreshTimeout = null;
        
        // Statistics
        this.stats = {
            bytesSent: 0,
            bytesReceived: 0,
            packetsDropped: 0,
            latency: 0
        };
        
        // Initialize
        this.connect();
    }
    
    /**
     * Establish WebSocket connection to DERP relay
     */
    connect() {
        if (this.ws) {
            return;
        }
        
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
            this.authenticate();
        };
        
        this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };
        
        this.ws.onclose = () => {
            this.handleDisconnect();
        };
        
        this.ws.onerror = (error) => {
            console.error("VMEffect WebSocket error:", error);
            this.stats.packetsDropped++;
        };
    }
    
    /**
     * Authenticate with the DERP relay
     */
    authenticate() {
        const authMessage = {
            type: "auth",
            token: this.token,
            macAddress: this.macAddress
        };
        
        this.ws.send(JSON.stringify(authMessage));
    }
    
    /**
     * Handle incoming messages from DERP relay
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case "auth_response":
                    this.handleAuthResponse(message);
                    break;
                    
                case "packet":
                    this.handlePacket(message);
                    break;
                    
                case "token_refresh":
                    this.handleTokenRefresh(message);
                    break;
                    
                default:
                    console.warn("Unknown message type:", message.type);
            }
        } catch (error) {
            console.error("Error handling message:", error);
        }
    }
    
    /**
     * Handle authentication response
     */
    handleAuthResponse(message) {
        if (message.success) {
            this.connected = true;
            this.sessionToken = message.sessionToken;
            this.refreshToken = message.refreshToken;
            
            // Schedule token refresh
            const refreshIn = (message.expiresIn - 300) * 1000; // Refresh 5 minutes before expiry
            this.scheduleTokenRefresh(refreshIn);
            
            console.log("VMEffect authentication successful");
        } else {
            console.error("VMEffect authentication failed:", message.error);
        }
    }
    
    /**
     * Handle incoming network packet
     */
    handlePacket(message) {
        const packet = new Uint8Array(message.data);
        this.stats.bytesReceived += packet.length;
        this.onPacket(packet);
    }
    
    /**
     * Handle token refresh response
     */
    handleTokenRefresh(message) {
        if (message.success) {
            this.sessionToken = message.sessionToken;
            this.scheduleTokenRefresh((message.expiresIn - 300) * 1000);
        } else {
            console.error("Token refresh failed:", message.error);
            this.reconnect();
        }
    }
    
    /**
     * Schedule token refresh
     */
    scheduleTokenRefresh(delay) {
        if (this.tokenRefreshTimeout) {
            clearTimeout(this.tokenRefreshTimeout);
        }
        
        this.tokenRefreshTimeout = setTimeout(() => {
            const refreshMessage = {
                type: "token_refresh",
                refreshToken: this.refreshToken
            };
            
            this.ws.send(JSON.stringify(refreshMessage));
        }, delay);
    }
    
    /**
     * Handle WebSocket disconnection
     */
    handleDisconnect() {
        this.connected = false;
        this.ws = null;
        
        if (this.tokenRefreshTimeout) {
            clearTimeout(this.tokenRefreshTimeout);
            this.tokenRefreshTimeout = null;
        }
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            setTimeout(() => {
                this.reconnectAttempts++;
                this.connect();
            }, this.reconnectDelay * Math.pow(2, this.reconnectAttempts));
        } else {
            console.error("Max reconnection attempts reached");
        }
    }
    
    /**
     * Send network packet through DERP relay
     */
    send(data) {
        if (!this.connected || !this.ws) {
            this.stats.packetsDropped++;
            return;
        }
        
        const packet = {
            type: "packet",
            sessionToken: this.sessionToken,
            data: Array.from(data)
        };
        
        try {
            this.ws.send(JSON.stringify(packet));
            this.stats.bytesSent += data.length;
        } catch (error) {
            console.error("Error sending packet:", error);
            this.stats.packetsDropped++;
        }
    }
    
    /**
     * Get current network statistics
     */
    getStats() {
        return { ...this.stats };
    }
    
    /**
     * Clean up resources
     */
    destroy() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        if (this.tokenRefreshTimeout) {
            clearTimeout(this.tokenRefreshTimeout);
            this.tokenRefreshTimeout = null;
        }
    }
}

// Export for v86 integration
if (typeof module !== "undefined" && module.exports) {
    module.exports = VMEffectNetworkAdapter;
} else {
    window.VMEffectNetworkAdapter = VMEffectNetworkAdapter;
}
