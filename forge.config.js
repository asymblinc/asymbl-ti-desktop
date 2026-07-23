const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: {
      unpackDir: "node_modules/@recallai"
    },
    osxSign: {
      continueOnError: false,
      optionsForFile: (_) => {
        // Here, we keep it simple and return a single entitlements.plist file.
        // You can use this callback to map different sets of entitlements
        // to specific files in your packaged app.
        return {
          entitlements: './Entitlements.plist'
        };
      }
    },
    icon: './asymbl',
    extendInfo: {
      NSUserNotificationAlertStyle: "alert",
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg'
    },
    // {
    //   name: '@electron-forge/maker-squirrel',
    //   config: {},
    // },
    // {
    //   name: '@electron-forge/maker-zip',
    //   platforms: ['darwin'],
    // },
    // {
    //   name: '@electron-forge/maker-deb',
    //   config: {},
    // },
    // {
    //   name: '@electron-forge/maker-rpm',
    //   config: {},
    // },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        devContentSecurityPolicy: "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem: mediastream: file:;",
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/index.html',
              js: './src/renderer.js',
              name: 'main_window',
              preload: {
                js: './src/preload.js',
              },
            },
            {
              // Screen 01 (menu-bar tray popover) - a separate frameless
              // BrowserWindow, not a native Tray context menu, since the
              // design needs custom cards/gradients/buttons a native macOS
              // menu can't render. Own preload - only exposes what the
              // popover needs, not the full main-window electronAPI surface.
              html: './src/popover.html',
              js: './src/popover-renderer.js',
              name: 'popover_window',
              preload: {
                js: './src/popover-preload.js',
              },
            },
            {
              // Screen 01b/01c (meeting-notification panel) - replaces the
              // generic native Electron Notification shown on meeting-
              // detected with the real designed pill/dropdown (task #37).
              // Own preload, same pattern as popover_window - exposes only
              // the 4 dropdown actions, nothing else.
              html: './src/meeting-notification.html',
              js: './src/meeting-notification-renderer.js',
              name: 'notification_window',
              preload: {
                js: './src/meeting-notification-preload.js',
              },
            },
          ],
        },
      },
    },
    {
      name: "@timfish/forge-externals-plugin",
      config: {
        externals: ["@recallai/desktop-sdk"],
        includeDeps: true
      }
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
