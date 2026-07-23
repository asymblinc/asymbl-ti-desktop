// Makes every require('electron') in this test run resolve to the manual
// mock at test/mocks/electron.cjs - intercepting at Node's own module
// loader is necessary (not sufficient to do via vi.mock/resolve.alias)
// because most main-process files here are plain CJS with zero ESM syntax
// (require/module.exports only); vite-node hands those straight to Node's
// native CJS loader untouched, bypassing vitest's own mock/alias graph
// entirely. Module._resolveFilename is the one layer every require() call
// must pass through regardless of which loader initiated it. See TODOS.md
// #6b and docs/DECISIONS.md for the full diagnosis.
const Module = require('node:module');
const path = require('node:path');

const mockPath = path.resolve(__dirname, 'mocks/electron.cjs');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') {
    return mockPath;
  }
  return originalResolveFilename.call(this, request, ...args);
};
