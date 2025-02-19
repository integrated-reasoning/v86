"use strict";

const assert = require("assert");
const sinon = require("sinon");
const DerpNetworkAdapter = require("../../src/browser/derp_network_adapter");

// Mock WebSocket for testing
class MockWebSocket {
    constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        this.readyState = 0;
        this.binaryType = null;
        this.send = sinon.spy();
    }

    close() {
        if (this.onclose) {
            this.onclose();
        }
    }
}

describe("DerpNetworkAdapter", () => {
    let adapter;
    let clock;
    let mockProtocol;
    let wsCount = 0;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        mockProtocol = {
            generateKeyPair: async () => new Uint8Array([1, 2, 3, 4]),
            createSession: async () => "test-session",
            encryptPacket: async (sessionId, data) => data,
            decryptPacket: async (sessionId, data) => data instanceof Uint8Array ? data : new Uint8Array(data),
        };

        // Set up WebSocket mock
        global.WebSocket = MockWebSocket;
        wsCount = 0;

        adapter = new DerpNetworkAdapter({
            relay_url: "wss://test.example.com",
            testMode: true,
            derpProtocol: mockProtocol,
        });
    });

    afterEach(() => {
        clock.restore();
    });

    describe("Connection Management", () => {
        it("should connect to WebSocket server", async () => {
            const connectPromise = adapter.connect();
            adapter.websocket.onopen();
            const result = await connectPromise;
            assert.strictEqual(result, true);
            assert.strictEqual(adapter.connected, true);
        });

        it("should handle connection failures", async () => {
            const connectPromise = adapter.connect();
            adapter.websocket.onerror(new Error("Connection failed"));
            adapter.websocket.onclose();
            const result = await connectPromise;
            assert.strictEqual(result, false);
            assert.strictEqual(adapter.connected, false);
        });

        it("should implement exponential backoff", () => {
            // First attempt
            adapter.handleDisconnect();
            assert.strictEqual(adapter.reconnectDelay, 1000, "Should use exponential backoff for attempt 0");

            // Second attempt
            adapter.handleDisconnect();
            assert.strictEqual(adapter.reconnectDelay, 2000, "Should use exponential backoff for attempt 1");

            // Third attempt
            adapter.handleDisconnect();
            assert.strictEqual(adapter.reconnectDelay, 4000, "Should use exponential backoff for attempt 2");
        });
    });

    describe("Packet Handling", () => {
        it("should queue packets when disconnected", async () => {
            const testData = new Uint8Array([1, 2, 3]);
            await adapter.send(testData);
            assert.deepStrictEqual(adapter.packetQueue[0], testData);
        });

        it("should send queued packets upon connection", async () => {
            const testData = new Uint8Array([1, 2, 3]);
            await adapter.send(testData);
            assert.strictEqual(adapter.packetQueue.length, 1);

            const connectPromise = adapter.connect();
            adapter.websocket.onopen();
            await connectPromise;
            await clock.runAllAsync();

            assert.strictEqual(adapter.packetQueue.length, 0);
            assert(adapter.websocket.send.calledOnce);
        });

        it("should handle received packets", async () => {
            const testData = new Uint8Array([1, 2, 3]);
            let receivedData = null;

            adapter.receive((data) => {
                receivedData = data;
            });

            const connectPromise = adapter.connect();
            adapter.websocket.onopen();
            await connectPromise;

            await adapter.websocket.onmessage({ data: testData });
            assert(receivedData instanceof Uint8Array, "Should receive Uint8Array");
            assert.deepStrictEqual(receivedData, testData);
        });
    });

    describe("Encryption", () => {
        it("should encrypt outgoing packets", async () => {
            const testData = new Uint8Array([1, 2, 3]);
            const encryptSpy = sinon.spy(mockProtocol, "encryptPacket");

            const connectPromise = adapter.connect();
            adapter.websocket.onopen();
            await connectPromise;
            await adapter.send(testData);
            await clock.runAllAsync();

            assert(encryptSpy.calledOnce);
            assert.deepStrictEqual(encryptSpy.firstCall.args[1], testData);
            assert(adapter.websocket.send.calledOnce);
            
            encryptSpy.restore();
        });

        it("should decrypt incoming packets", async () => {
            const testData = new Uint8Array([1, 2, 3]);
            let receivedData = null;

            adapter.receive((data) => {
                receivedData = data;
            });

            const connectPromise = adapter.connect();
            adapter.websocket.onopen();
            await connectPromise;

            await adapter.websocket.onmessage({ data: testData });
            assert(receivedData instanceof Uint8Array, "Should receive Uint8Array");
            assert.deepStrictEqual(receivedData, testData);
        });
    });
});
