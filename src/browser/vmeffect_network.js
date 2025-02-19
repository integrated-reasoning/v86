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
    catch(e) {
        console.error("Failed to initialize VMEffect:", e);
    }
};

VMEffectNetworkAdapter.prototype.connect = function()
{
    if(this.ws)
    {
        return;
    }
    
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";
    
    this.ws.onopen = () => {
        // Wait for server key
        console.log("VMEffect: Connected to DERP relay");
    };
    
    this.ws.onmessage = async (event) => {
        try {
            const data = new Uint8Array(event.data);
            const header = this.derp.decodeFrameHeader(data);
            const payload = data.slice(FRAME_HEADER_LENGTH);
            
            switch(header.type) {
                case FRAME_TYPES.SERVER_KEY:
                    await this.handleServerKey(payload);
                    break;
                    
                case FRAME_TYPES.SERVER_INFO:
                    await this.handleServerInfo(payload);
                    break;
                    
                case FRAME_TYPES.RECV_PACKET:
                    this.handlePacket(payload);
                    break;
                    
                case FRAME_TYPES.PEER_GONE:
                case FRAME_TYPES.PEER_PRESENT:
                    this.derp.handlePeerState(header.type, payload);
                    break;
                    
                default:
                    console.warn("Unknown frame type:", header.type);
            }
        }
        catch(e) {
            console.error("Failed to handle message:", e);
            this.stats.packetsDropped++;
        }
    };
    
    this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        
        if(this.reconnectAttempts < this.maxReconnectAttempts)
        {
            this.reconnectAttempts++;
            setTimeout(() => this.connect(), this.reconnectDelay);
        }
    };
    
    this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
};

VMEffectNetworkAdapter.prototype.handleServerKey = async function(payload)
{
    try {
        this.derp.handleServerKey(payload);
        
        // Send client info
        const info = {
            version: PROTOCOL_VERSION,
            token: this.token,
            macAddress: this.macAddress
        };
        
        const clientInfo = await this.derp.createClientInfo(info);
        this.ws.send(clientInfo);
    }
    catch(e) {
        console.error("Failed to handle server key:", e);
        this.ws.close();
    }
};

VMEffectNetworkAdapter.prototype.handleServerInfo = async function(payload)
{
    try {
        const info = await this.derp.handleServerInfo(payload);
        console.log("VMEffect: Connected to DERP server:", info);
        this.connected = true;
        this.reconnectAttempts = 0;
    }
    catch(e) {
        console.error("Failed to handle server info:", e);
        this.ws.close();
    }
};

VMEffectNetworkAdapter.prototype.handlePacket = function(payload)
{
    try {
        const { srcKey, packet } = this.derp.handleRecvPacket(payload);
        this.stats.bytesReceived += packet.length;
        this.onPacket(packet);
    }
    catch(e) {
        console.error("Failed to handle packet:", e);
        this.stats.packetsDropped++;
    }
};

VMEffectNetworkAdapter.prototype.send = function(data)
{
    if(!this.connected || !this.derp)
    {
        this.stats.packetsDropped++;
        return;
    }
    
    try {
        // For now, we broadcast to all peers
        for(const [keyStr, peer] of this.derp.peerKeys)
        {
            const destKey = Buffer.from(keyStr, "hex");
            const frame = this.derp.createPacketFrame(data, destKey);
            this.ws.send(frame);
            this.stats.bytesSent += data.length;
        }
    }
    catch(e) {
        console.error("Failed to send packet:", e);
        this.stats.packetsDropped++;
    }
};

VMEffectNetworkAdapter.prototype.getStats = function()
{
    return { ...this.stats };
};

VMEffectNetworkAdapter.prototype.destroy = function()
{
    if(this.ws)
    {
        this.ws.close();
        this.ws = null;
    }
    
    this.connected = false;
    this.derp = null;
    this.keyPair = null;
};

if(typeof module !== "undefined" && module.exports)
{
    module.exports = { VMEffectNetworkAdapter };
}
