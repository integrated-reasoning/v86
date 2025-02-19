const { DERPProtocol, DERPCrypto, FRAME_HEADER_LENGTH, FRAME_TYPES, PROTOCOL_VERSION } = require("./derp_protocol");

/**
 * vmEffect WebSocket-based network adapter for v86
 * Implements secure networking through DERP relay infrastructure
 */

/**
 * @constructor
 * @param {{
 *     url: string,
 *     token: string,
 *     macAddress: string,
 *     onPacket: function(Uint8Array): void
 * }} options
 */
function VMEffectNetworkAdapter(options)
{
    this.url = options.url;
    this.token = options.token;
    this.macAddress = options.macAddress;
    this.onPacket = options.onPacket;
    
    // DERP state
    this.derp = null;
    this.keyPair = null;
    
    // Connection state
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    
    // Statistics
    this.stats = {
        bytesSent: 0,
        bytesReceived: 0,
        packetsDropped: 0
    };
    
    // Initialize
    this.init();
}

VMEffectNetworkAdapter.prototype.init = async function()
{
    try {
        // Generate key pair
        this.keyPair = await DERPCrypto.generateKeyPair();
        this.derp = new DERPProtocol(this.keyPair);
        
        // Connect
        this.connect();
    }
    catch(err) {
        console.error("Failed to initialize VMEffect:", err);
    }
};

VMEffectNetworkAdapter.prototype.connect = function()
{
    try {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = "arraybuffer";
        
        this.ws.onopen = () => {
            console.log("VMEffect: Connected to DERP relay");
            this.connected = true;
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = new Uint8Array(event.data);
                if(data.length < FRAME_HEADER_LENGTH) {
                    throw new Error("Invalid frame header");
                }
                
                const header = this.derp.decodeFrameHeader(data);
                const payload = data.slice(FRAME_HEADER_LENGTH);
                
                switch(header.type) {
                    case FRAME_TYPES.SERVER_KEY:
                        this.handleServerKey(payload);
                        break;
                        
                    case FRAME_TYPES.SERVER_INFO:
                        this.handleServerInfo(payload);
                        break;
                        
                    case FRAME_TYPES.RECV_PACKET:
                        this.handlePacket(payload);
                        break;
                        
                    case FRAME_TYPES.PEER_GONE:
                    case FRAME_TYPES.PEER_PRESENT:
                        this.derp.handlePeerState(header.type, payload);
                        break;
                        
                    default:
                        console.warn("VMEffect: Unknown frame type:", header.type);
                }
            }
            catch(err) {
                console.error("Failed to handle message:", err);
                this.stats.packetsDropped++;
            }
        };
        
        this.ws.onclose = () => {
            console.log("VMEffect: Disconnected from DERP relay");
            this.connected = false;
            this.ws = null;
            
            if(this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                this.reconnectDelay *= 2;
                
                console.log("VMEffect: Reconnecting in", this.reconnectDelay, "ms");
                setTimeout(() => this.connect(), this.reconnectDelay);
            }
            else {
                console.error("VMEffect: Max reconnection attempts reached");
            }
        };
        
        this.ws.onerror = (err) => {
            console.error("VMEffect: WebSocket error:", err);
        };
    }
    catch(err) {
        console.error("Failed to connect to DERP relay:", err);
    }
};

VMEffectNetworkAdapter.prototype.handleServerKey = async function(payload)
{
    try {
        await this.derp.handleServerKey(payload);
        
        // Send client info
        const info = {
            version: PROTOCOL_VERSION,
            token: this.token,
            macAddress: this.macAddress
        };
        
        const clientInfo = await this.derp.createClientInfo(info);
        this.ws.send(clientInfo.buffer);
    }
    catch(err) {
        console.error("Failed to handle server key:", err);
        this.ws.close();
    }
};

VMEffectNetworkAdapter.prototype.handleServerInfo = async function(payload)
{
    try {
        await this.derp.handleServerInfo(payload);
        this.connected = true;
        this.reconnectAttempts = 0;
    }
    catch(err) {
        console.error("Failed to handle server info:", err);
        this.ws.close();
    }
};

VMEffectNetworkAdapter.prototype.handlePacket = function(payload)
{
    try {
        const { packet } = this.derp.handleRecvPacket(payload);
        this.stats.bytesReceived += packet.length;
        this.onPacket(packet);
    }
    catch(err) {
        console.error("Failed to handle packet:", err);
        this.stats.packetsDropped++;
    }
};

VMEffectNetworkAdapter.prototype.send = async function(data, destKey)
{
    try {
        if(this.connected && this.ws) {
            const frame = this.derp.createPacketFrame(data, destKey);
            this.ws.send(frame.buffer);
            this.stats.bytesSent += data.length;
        }
    }
    catch(err) {
        console.error("Failed to send packet:", err);
        this.stats.packetsDropped++;
    }
};

VMEffectNetworkAdapter.prototype.getStats = function()
{
    return this.stats;
};

VMEffectNetworkAdapter.prototype.destroy = function()
{
    if(this.ws) {
        this.ws.close();
        this.ws = null;
    }
    
    this.connected = false;
    this.reconnectAttempts = 0;
};

if(typeof module !== "undefined" && module.exports)
{
    module.exports = { VMEffectNetworkAdapter };
}
