const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

// Monorepo root — two levels up from ./mobile
const monorepoRoot = path.resolve(__dirname, '..');

/**
 * Metro configuration for monorepo
 *
 * Key additions vs the default config:
 *
 * watchFolders   — tells Metro to watch the monorepo root so changes to
 *                  packages/core are picked up without a full restart.
 *
 * resolver.nodeModulesPaths — tells Metro where to look for node_modules
 *                  when resolving imports. Without this, @clawdaddy/core
 *                  resolves to mobile/node_modules/@clawdaddy/core (doesn't
 *                  exist) instead of the symlink in the root node_modules.
 *
 * resolver.disableHierarchicalLookup — prevents Metro from walking up the
 *                  directory tree and accidentally picking up the wrong
 *                  version of react or react-native from the root
 *                  node_modules (which would cause "two copies of React" errors).
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [monorepoRoot],

  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],

    // Prevent Metro picking up a second copy of react/react-native
    // from the root node_modules when the mobile app has its own copy.
    // Mobile's own node_modules always win for these.
    extraNodeModules: {
      react:        path.resolve(__dirname, 'node_modules/react'),
      'react-native': path.resolve(__dirname, 'node_modules/react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);