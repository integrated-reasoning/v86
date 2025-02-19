"use strict";

import DerpNetworkAdapter from "./derp_network_adapter.js";

/**
 * Network adapter implementation
 *
 * @constructor
 *
 * @param {{
 *     url: string,
 *     bus: BusConnector,
 *     id: (number|undefined),
 *     vmEffect: (boolean|undefined),
 *     vmEffectToken: (string|undefined),
 *     mac_address: (string|undefined),
 *     type: (string|undefined)
 * }} options
 */
function NetworkAdapter(options)
{
    var url = options.url;
    
    if(!url)
    {
        return;
    }

    // Support for DERP networking
    if(options.type === "derp")
    {
        this.adapter = new DerpNetworkAdapter({
            relay_url: url,
            mac_address: options.mac_address,
        });
        
        this.adapter.receive((data) => {
            this.handle_packet(data);
        });
        
        this.send_packet = function(data)
        {
            this.adapter.send(data);
        };
        
        this.destroy = function()
        {
            this.adapter.disconnect();
        };
        
        return;
    }

    // Support for vmEffect networking
    if(options.vmEffect)
    {
        this.adapter = new VMEffectNetworkAdapter({
            url: url,
            token: options.vmEffectToken,
            macAddress: options.mac_address,
            onPacket: (data) => {
                this.handle_packet(data);
            }
        });
        
        this.send_packet = function(data)
        {
            this.adapter.send(data);
        };
        
        this.destroy = function()
        {
            this.adapter.destroy();
        };
        
        return;
    }

    this.bus = options.bus;
    this.socket = undefined;
    this.id = options.id || 0;

    // TODO: circular buffer?
    this.send_queue = [];
    this.url = url;

    this.reconnect_interval = 10000;
    this.last_connect_attempt = Date.now() - this.reconnect_interval;
    this.send_queue_limit = 64;
    this.destroyed = false;

    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);
}

NetworkAdapter.prototype.handle_message = function(e)
{
    if(this.bus)
    {
        this.bus.send("net" + this.id + "-receive", new Uint8Array(e.data));
    }
};

NetworkAdapter.prototype.handle_close = function(e)
{
    //console.log("onclose", e);

    if(!this.destroyed)
    {
        this.connect();
        setTimeout(this.connect.bind(this), this.reconnect_interval);
    }
};

NetworkAdapter.prototype.handle_open = function(e)
{
    //console.log("open", e);

    for(var i = 0; i < this.send_queue.length; i++)
    {
        this.send(this.send_queue[i]);
    }

    this.send_queue = [];
};

NetworkAdapter.prototype.handle_error = function(e)
{
    //console.log("onerror", e);
};

NetworkAdapter.prototype.destroy = function()
{
    this.destroyed = true;
    if(this.socket)
    {
        this.socket.close();
    }
};

NetworkAdapter.prototype.connect = function()
{
    if(typeof WebSocket === "undefined")
    {
        return;
    }

    if(this.socket)
    {
        var state = this.socket.readyState;

        if(state === 0 || state === 1)
        {
            // already or almost there
            return;
        }
    }

    var now = Date.now();

    if(this.last_connect_attempt + this.reconnect_interval > now)
    {
        return;
    }

    this.last_connect_attempt = Date.now();

    try
    {
        this.socket = new WebSocket(this.url);
    }
    catch(e)
    {
        console.error(e);
        return;
    }

    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = this.handle_open.bind(this);
    this.socket.onmessage = this.handle_message.bind(this);
    this.socket.onclose = this.handle_close.bind(this);
    this.socket.onerror = this.handle_error.bind(this);
};

NetworkAdapter.prototype.send = function(data)
{
    //console.log("send", data);

    if(!this.socket || this.socket.readyState !== 1)
    {
        this.send_queue.push(data);

        if(this.send_queue.length > 2 * this.send_queue_limit)
        {
            this.send_queue = this.send_queue.slice(-this.send_queue_limit);
        }

        this.connect();
    }
    else
    {
        this.socket.send(data);
    }
};

NetworkAdapter.prototype.change_proxy = function(url)
{
    this.url = url;

    if(this.socket)
    {
        this.socket.onclose = function() {};
        this.socket.onerror = function() {};
        this.socket.close();
        this.socket = undefined;
    }
};
