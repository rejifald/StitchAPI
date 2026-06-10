// Isolated jest config for the StitchAPI v1 prototype harness.
// Deliberately does NOT load the repo's ./test/setup.js (which enables a global
// fetch mock) — these scenarios exercise real fetch against a local mock server.
const path = require('path');

module.exports = {
    rootDir: __dirname,
    testEnvironment: 'node',
    testMatch: ['**/*.spec.ts'],
    transform: {
        '^.+\\.[tj]sx?$': [
            'babel-jest',
            { configFile: path.join(__dirname, '..', 'babel.config.json') },
        ],
    },
    collectCoverage: false,
    testTimeout: 15000,
};
