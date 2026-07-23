module.exports = {
  test: {
    include: ['test/**/*.test.js'],
    // Neither vi.mock('electron', ...) nor Vite's resolve.alias/deps.inline
    // intercept require('electron') in this project: most main-process
    // files are plain CJS with zero ESM syntax, so vite-node hands them to
    // Node's native CJS loader untouched. This setup file patches
    // Module._resolveFilename instead - the one layer every require() must
    // pass through regardless of loader. See TODOS.md #6b.
    setupFiles: ['./test/setup-electron-mock.cjs'],
  },
};
