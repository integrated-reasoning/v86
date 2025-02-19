"use strict";

module.exports = {
    require: ["./tests/browser/setup.js"],
    timeout: 5000,
    exit: true,
    recursive: true,
    "check-leaks": true,
    reporter: "spec"
};
