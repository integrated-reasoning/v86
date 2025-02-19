"use strict";

const { JSDOM } = require("jsdom");

// Create a browser-like environment
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost",
    runScripts: "dangerously",
    resources: "usable"
});

// Set up global browser environment
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.WebSocket = dom.window.WebSocket;

// Add test utilities
global.assert = require("assert");
global.sinon = require("sinon");

// Add v86 modules to global scope
require("../../build/libv86-debug");
