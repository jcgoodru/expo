/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { ExpoConfig, Platform } from '@expo/config';
import fs from 'fs';
import Bundler from 'metro/src/Bundler';
import { ConfigT } from 'metro-config';
import { Resolution, ResolutionContext, CustomResolutionContext } from 'metro-resolver';
import * as metroResolver from 'metro-resolver';
import path from 'path';
import resolveFrom from 'resolve-from';

import { createFastResolver } from './createExpoMetroResolver';
import { isNodeExternal, shouldCreateVirtualCanary, shouldCreateVirtualShim } from './externals';
import { isFailedToResolveNameError, isFailedToResolvePathError } from './metroErrors';
import { getMetroBundlerWithVirtualModules } from './metroVirtualModules';
import {
  type ExpoCustomMetroResolver,
  withMetroErrorReportingResolver,
  withMetroMutatedResolverContext,
  withMetroResolvers,
} from './withMetroResolvers';
import { Log } from '../../../log';
import { FileNotifier } from '../../../utils/FileNotifier';
import { env } from '../../../utils/env';
import { CommandError } from '../../../utils/errors';
import { installExitHooks } from '../../../utils/exit';
import { isInteractive } from '../../../utils/interactive';
import { loadTsConfigPathsAsync, TsConfigPaths } from '../../../utils/tsconfig/loadTsConfigPaths';
import { resolveWithTsConfigPaths } from '../../../utils/tsconfig/resolveWithTsConfigPaths';
import { isServerEnvironment } from '../middleware/metroOptions';
import { PlatformBundlers } from '../platformBundlers';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const debug = require('debug')('expo:start:server:metro:multi-platform') as typeof console.log;

function withWebPolyfills(
  config: ConfigT,
  {
    getMetroBundler,
  }: {
    getMetroBundler: () => Bundler;
  }
): ConfigT {
  const originalGetPolyfills = config.serializer.getPolyfills
    ? config.serializer.getPolyfills.bind(config.serializer)
    : () => [];

  const getPolyfills = (ctx: { platform: string | null }): readonly string[] => {
    const virtualEnvVarId = `\0polyfill:environment-variables`;

    getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
      virtualEnvVarId,
      (() => {
        return `//`;
      })()
    );

    const virtualModuleId = `\0polyfill:external-require`;

    getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
      virtualModuleId,
      (() => {
        if (ctx.platform === 'web') {
          return `global.$$require_external = typeof window === "undefined" ? require : () => null;`;
        } else {
          // Wrap in try/catch to support Android.
          return 'try { global.$$require_external = typeof expo === "undefined" ? require : (moduleId) => { throw new Error(`Node.js standard library module ${moduleId} is not available in this JavaScript environment`);} } catch { global.$$require_external = (moduleId) => { throw new Error(`Node.js standard library module ${moduleId} is not available in this JavaScript environment`);} }';
        }
      })()
    );

    if (ctx.platform === 'web') {
      return [
        virtualModuleId,
        virtualEnvVarId,
        // Ensure that the error-guard polyfill is included in the web polyfills to
        // make metro-runtime work correctly.
        // TODO: This module is pretty big for a function that simply re-throws an error that doesn't need to be caught.
        require.resolve('@react-native/js-polyfills/error-guard'),
      ];
    }

    // Generally uses `rn-get-polyfills`
    const polyfills = originalGetPolyfills(ctx);
    return [...polyfills, virtualModuleId, virtualEnvVarId];
  };

  return {
    ...config,
    serializer: {
      ...config.serializer,
      getPolyfills,
    },
  };
}

function normalizeSlashes(p: string) {
  return p.replace(/\\/g, '/');
}

export function getNodejsExtensions(srcExts: readonly string[]): string[] {
  const mjsExts = srcExts.filter((ext) => /mjs$/.test(ext));
  const nodejsSourceExtensions = srcExts.filter((ext) => !/mjs$/.test(ext));
  // find index of last `*.js` extension
  const jsIndex = nodejsSourceExtensions.reduce((index, ext, i) => {
    return /jsx?$/.test(ext) ? i : index;
  }, -1);

  // insert `*.mjs` extensions after `*.js` extensions
  nodejsSourceExtensions.splice(jsIndex + 1, 0, ...mjsExts);

  return nodejsSourceExtensions;
}

/**
 * Apply custom resolvers to do the following:
 * - Disable `.native.js` extensions on web.
 * - Alias `react-native` to `react-native-web` on web.
 * - Redirect `react-native-web/dist/modules/AssetRegistry/index.js` to `@react-native/assets/registry.js` on web.
 * - Add support for `tsconfig.json`/`jsconfig.json` aliases via `compilerOptions.paths`.
 * - Alias react-native renderer code to a vendored React canary build on native.
 */
export function withExtendedResolver(
  config: ConfigT,
  {
    tsconfig,
    isTsconfigPathsEnabled,
    isFastResolverEnabled,
    isExporting,
    isReactCanaryEnabled,
    isReactNativeStrictVersionEnabled,
    getMetroBundler,
  }: {
    tsconfig: TsConfigPaths | null;
    isTsconfigPathsEnabled?: boolean;
    isFastResolverEnabled?: boolean;
    isExporting?: boolean;
    isReactCanaryEnabled?: boolean;
    isReactNativeStrictVersionEnabled?: boolean;
    getMetroBundler: () => Bundler;
  }
) {
  if (isFastResolverEnabled) {
    Log.warn(`Experimental bundling features are enabled.`);
  }
  if (isReactCanaryEnabled) {
    Log.warn(`Experimental React Canary version is enabled.`);
  }
  if (isReactNativeStrictVersionEnabled) {
    Log.warn(`Experimental React Native strict version is enabled.`);
  }

  let _assetRegistryPath: string | null = null;

  // Fetch this lazily for testing purposes.
  function getAssetRegistryPath() {
    if (_assetRegistryPath) {
      return _assetRegistryPath;
    }

    // Get the `transformer.assetRegistryPath`
    // this needs to be unified since you can't dynamically
    // swap out the transformer based on platform.
    if (
      config.transformer.assetRegistryPath &&
      path.isAbsolute(config.transformer.assetRegistryPath)
    ) {
      _assetRegistryPath = fs.realpathSync(config.transformer.assetRegistryPath);
      return _assetRegistryPath;
    }

    const assetRegistryPath = fs.realpathSync(
      path.resolve(
        resolveFrom(
          config.projectRoot,
          config.transformer.assetRegistryPath ?? '@react-native/assets-registry/registry.js'
        )
      )
    );
    _assetRegistryPath = assetRegistryPath;
    return assetRegistryPath;
  }

  const defaultResolver = metroResolver.resolve;
  const resolver = isFastResolverEnabled
    ? createFastResolver({
        preserveSymlinks: config.resolver?.unstable_enableSymlinks ?? true,
        blockList: Array.isArray(config.resolver?.blockList)
          ? config.resolver?.blockList
          : [config.resolver?.blockList],
      })
    : defaultResolver;

  const aliases: { [key: string]: Record<string, string> } = {
    web: {
      'react-native': 'react-native-web',
      'react-native/index': 'react-native-web',
      'react-native/Libraries/Image/resolveAssetSource': 'expo-asset/build/resolveAssetSource',
    },
  };

  let _universalAliases: [RegExp, string][] | null;

  function getUniversalAliases() {
    if (_universalAliases) {
      return _universalAliases;
    }

    _universalAliases = [];

    // This package is currently always installed as it is included in the `expo` package.
    if (resolveFrom.silent(config.projectRoot, '@expo/vector-icons')) {
      debug('Enabling alias: react-native-vector-icons -> @expo/vector-icons');
      _universalAliases.push([/^react-native-vector-icons(\/.*)?/, '@expo/vector-icons$1']);
    }

    return _universalAliases;
  }

  const preferredMainFields: { [key: string]: string[] } = {
    // Defaults from Expo Webpack. Most packages using `react-native` don't support web
    // in the `react-native` field, so we should prefer the `browser` field.
    // https://github.com/expo/router/issues/37
    web: ['browser', 'module', 'main'],
  };

  let tsConfigResolve =
    isTsconfigPathsEnabled && (tsconfig?.paths || tsconfig?.baseUrl != null)
      ? resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
          paths: tsconfig.paths ?? {},
          baseUrl: tsconfig.baseUrl ?? config.projectRoot,
          hasBaseUrl: !!tsconfig.baseUrl,
        })
      : null;

  // TODO: Move this to be a transform key for invalidation.
  if (!isExporting && isInteractive()) {
    if (isTsconfigPathsEnabled) {
      // TODO: We should track all the files that used imports and invalidate them
      // currently the user will need to save all the files that use imports to
      // use the new aliases.
      const configWatcher = new FileNotifier(config.projectRoot, [
        './tsconfig.json',
        './jsconfig.json',
      ]);
      configWatcher.startObserving(() => {
        debug('Reloading tsconfig.json');
        loadTsConfigPathsAsync(config.projectRoot).then((tsConfigPaths) => {
          if (tsConfigPaths?.paths && !!Object.keys(tsConfigPaths.paths).length) {
            debug('Enabling tsconfig.json paths support');
            tsConfigResolve = resolveWithTsConfigPaths.bind(resolveWithTsConfigPaths, {
              paths: tsConfigPaths.paths ?? {},
              baseUrl: tsConfigPaths.baseUrl ?? config.projectRoot,
              hasBaseUrl: !!tsConfigPaths.baseUrl,
            });
          } else {
            debug('Disabling tsconfig.json paths support');
            tsConfigResolve = null;
          }
        });
      });

      // TODO: This probably prevents the process from exiting.
      installExitHooks(() => {
        configWatcher.stopObserving();
      });
    } else {
      debug('Skipping tsconfig.json paths support');
    }
  }

  let nodejsSourceExtensions: string[] | null = null;

  function getStrictResolver(
    { resolveRequest, ...context }: ResolutionContext,
    platform: string | null
  ) {
    return function doResolve(moduleName: string): Resolution {
      return resolver(context, moduleName, platform);
    };
  }

  function getOptionalResolver(context: ResolutionContext, platform: string | null) {
    const doResolve = getStrictResolver(context, platform);
    return function optionalResolve(moduleName: string): Resolution | null {
      try {
        return doResolve(moduleName);
      } catch (error) {
        // If the error is directly related to a resolver not being able to resolve a module, then
        // we can ignore the error and try the next resolver. Otherwise, we should throw the error.
        const isResolutionError =
          isFailedToResolveNameError(error) || isFailedToResolvePathError(error);
        if (!isResolutionError) {
          throw error;
        }
      }
      return null;
    };
  }

  // If Node.js pass-through, then remap to a module like `module.exports = $$require_external(<module>)`.
  // If module should be shimmed, remap to an empty module.
  const externals: {
    match: (context: ResolutionContext, moduleName: string, platform: string | null) => boolean;
    replace: 'empty' | 'node';
  }[] = [
    {
      match: (context: ResolutionContext, moduleName: string) => {
        if (
          // Disable internal externals when exporting for production.
          context.customResolverOptions.exporting ||
          // These externals are only for Node.js environments.
          !isServerEnvironment(context.customResolverOptions?.environment)
        ) {
          return false;
        }

        // Extern these modules in standard Node.js environments in development to prevent API routes side-effects
        // from leaking into the dev server process.
        return /^(source-map-support(\/.*)?|react|react-native-helmet-async|@radix-ui\/.+|@babel\/runtime\/.+|react-dom(\/.+)?|debug|acorn-loose|acorn|css-in-js-utils\/lib\/.+|hyphenate-style-name|color|color-string|color-convert|color-name|fontfaceobserver|fast-deep-equal|query-string|escape-string-regexp|invariant|postcss-value-parser|memoize-one|nullthrows|strict-uri-encode|decode-uri-component|split-on-first|filter-obj|warn-once|simple-swizzle|is-arrayish|inline-style-prefixer\/.+)$/.test(
          moduleName
        );
      },
      replace: 'node',
    },
  ];

  // React Native strict version validates the imported React Native versions against the project's version.
  // Using only this version of React Native prevents multiple versions from being bundled.
  function createReactNativeStrictVersionResolver(enabled = false): ExpoCustomMetroResolver {
    // Load the "correct" version of React Native based on the project's version
    const reactNativePath = path.dirname(
      resolveFrom(config.projectRoot, 'react-native/package.json')
    );

    // Only warn once, put extra information in the debug logs
    let warnedMultipleReactNativeVersions = false;

    return (context, moduleName, platform) => {
      // Only validate when enabled
      // Only validate React Native imports
      if (!enabled || !(moduleName === 'react-native' || moduleName.startsWith('react-native/'))) {
        return null;
      }

      const resolver = getStrictResolver(context, platform);
      const resolved = resolver(moduleName);

      // Ignore non-source files from strict version validation
      // Ignore correct React Native version imports
      if (resolved.type !== 'sourceFile' || resolved.filePath.startsWith(reactNativePath)) {
        return resolved;
      }

      // Validation failed, redirect to the correct version of React Native
      const redirectPath = context.redirectModulePath(
        moduleName.replace('react-native', reactNativePath)
      );

      // Ignore empty module redirects
      if (redirectPath === false) return null;

      // Resolve the proper redirected React Native version
      const redirectResolved = resolver(redirectPath);

      // Inform the user of the resolution change
      if (!warnedMultipleReactNativeVersions) {
        warnedMultipleReactNativeVersions = true;
        Log.warn(`Multiple React Native versions detected, resolving only: ${reactNativePath}`);
      }

      // Provide all information in the debug logs
      debug(
        `Redirecting React Native module "${moduleName}" to "${redirectPath}", imported from: ${context.originModulePath}`
      );

      return redirectResolved;
    };
  }

  const metroConfigWithCustomResolver = withMetroResolvers(config, [
    // Mock out production react imports in development.
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      // This resolution is dev-only to prevent bundling the production React packages in development.
      // @ts-expect-error: dev is not on type.
      if (!context.dev) return null;

      if (
        // Match react-native renderers.
        (platform !== 'web' &&
          context.originModulePath.match(/[\\/]node_modules[\\/]react-native[\\/]/) &&
          moduleName.match(/([\\/]ReactFabric|ReactNativeRenderer)-prod/)) ||
        // Match react production imports.
        (moduleName.match(/\.production(\.min)?\.js$/) &&
          // Match if the import originated from a react package.
          context.originModulePath.match(/[\\/]node_modules[\\/](react[-\\/]|scheduler[\\/])/))
      ) {
        debug(`Skipping production module: ${moduleName}`);
        // /Users/path/to/expo/node_modules/react/index.js ./cjs/react.production.min.js
        // /Users/path/to/expo/node_modules/react/jsx-dev-runtime.js ./cjs/react-jsx-dev-runtime.production.min.js
        // /Users/path/to/expo/node_modules/react-is/index.js ./cjs/react-is.production.min.js
        // /Users/path/to/expo/node_modules/react-refresh/runtime.js ./cjs/react-refresh-runtime.production.min.js
        // /Users/path/to/expo/node_modules/react-native/node_modules/scheduler/index.native.js ./cjs/scheduler.native.production.min.js
        // /Users/path/to/expo/node_modules/react-native/node_modules/react-is/index.js ./cjs/react-is.production.min.js
        return {
          type: 'empty',
        };
      }
      return null;
    },
    // tsconfig paths
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      return (
        tsConfigResolve?.(
          {
            originModulePath: context.originModulePath,
            moduleName,
          },
          getOptionalResolver(context, platform)
        ) ?? null
      );
    },

    // Node.js externals support
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      const isServer =
        context.customResolverOptions?.environment === 'node' ||
        context.customResolverOptions?.environment === 'react-server';

      const moduleId = isNodeExternal(moduleName);
      if (!moduleId) {
        return null;
      }

      if (
        // In browser runtimes, we want to either resolve a local node module by the same name, or shim the module to
        // prevent crashing when Node.js built-ins are imported.
        !isServer
      ) {
        // Perform optional resolve first. If the module doesn't exist (no module in the node_modules)
        // then we can mock the file to use an empty module.
        const result = getOptionalResolver(context, platform)(moduleName);

        if (!result && platform !== 'web') {
          // Preserve previous behavior where native throws an error on node.js internals.
          return null;
        }

        return (
          result ?? {
            // In this case, mock the file to use an empty module.
            type: 'empty',
          }
        );
      }

      const contents = `module.exports=$$require_external('node:${moduleId}');`;
      debug(`Virtualizing Node.js "${moduleId}"`);
      const virtualModuleId = `\0node:${moduleId}`;
      getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
        virtualModuleId,
        contents
      );
      return {
        type: 'sourceFile',
        filePath: virtualModuleId,
      };
    },

    // Custom externals support
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      // We don't support this in the resolver at the moment.
      if (moduleName.endsWith('/package.json')) {
        return null;
      }

      for (const external of externals) {
        if (external.match(context, moduleName, platform)) {
          if (external.replace === 'empty') {
            debug(`Redirecting external "${moduleName}" to "${external.replace}"`);
            return {
              type: external.replace,
            };
          } else if (external.replace === 'node') {
            const contents = `module.exports=$$require_external('${moduleName}')`;
            const virtualModuleId = `\0node:${moduleName}`;
            debug('Virtualizing Node.js (custom):', moduleName, '->', virtualModuleId);
            getMetroBundlerWithVirtualModules(getMetroBundler()).setVirtualModule(
              virtualModuleId,
              contents
            );
            return {
              type: 'sourceFile',
              filePath: virtualModuleId,
            };
          } else {
            throw new CommandError(
              `Invalid external alias type: "${external.replace}" for module "${moduleName}" (platform: ${platform}, originModulePath: ${context.originModulePath})`
            );
          }
        }
      }
      return null;
    },

    // Basic moduleId aliases
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      // Conditionally remap `react-native` to `react-native-web` on web in
      // a way that doesn't require Babel to resolve the alias.
      if (platform && platform in aliases && aliases[platform][moduleName]) {
        const redirectedModuleName = aliases[platform][moduleName];
        return getStrictResolver(context, platform)(redirectedModuleName);
      }

      for (const [matcher, alias] of getUniversalAliases()) {
        const match = moduleName.match(matcher);
        if (match) {
          const aliasedModule = alias.replace(
            /\$(\d+)/g,
            (_, index) => match[parseInt(index, 10)] ?? ''
          );
          const doResolve = getStrictResolver(context, platform);
          debug(`Alias "${moduleName}" to "${aliasedModule}"`);
          return doResolve(aliasedModule);
        }
      }

      return null;
    },

    // React Native strict version detection for monorepos with possible multiple versions of React Native
    createReactNativeStrictVersionResolver(isReactNativeStrictVersionEnabled),

    // TODO: Reduce these as much as possible in the future.
    // Complex post-resolution rewrites.
    (context: ResolutionContext, moduleName: string, platform: string | null) => {
      const doResolve = getStrictResolver(context, platform);

      if (
        platform === 'web' &&
        context.originModulePath.match(/node_modules[\\/]react-native-web[\\/]/) &&
        moduleName.includes('/modules/AssetRegistry')
      ) {
        return {
          type: 'sourceFile',
          filePath: getAssetRegistryPath(),
        };
      }

      const result = doResolve(moduleName);

      if (result.type !== 'sourceFile') {
        return result;
      }

      if (platform === 'web') {
        if (result.filePath.includes('node_modules')) {
          // Replace with static shims

          const normalName = normalizeSlashes(result.filePath)
            // Drop everything up until the `node_modules` folder.
            .replace(/.*node_modules\//, '');

          const shimFile = shouldCreateVirtualShim(normalName);
          if (shimFile) {
            const virtualId = `\0shim:${normalName}`;
            const bundler = getMetroBundlerWithVirtualModules(getMetroBundler());
            if (!bundler.hasVirtualModule(virtualId)) {
              bundler.setVirtualModule(virtualId, fs.readFileSync(shimFile, 'utf8'));
            }
            debug(`Redirecting module "${result.filePath}" to shim`);

            return {
              ...result,
              filePath: virtualId,
            };
          }
        }
      } else {
        // When server components are enabled, redirect React Native's renderer to the canary build
        // this will enable the use hook and other requisite features from React 19.
        if (isReactCanaryEnabled && result.filePath.includes('node_modules')) {
          const normalName = normalizeSlashes(result.filePath)
            // Drop everything up until the `node_modules` folder.
            .replace(/.*node_modules\//, '');

          const canaryFile = shouldCreateVirtualCanary(normalName);
          if (canaryFile) {
            debug(`Redirecting React Native module "${result.filePath}" to canary build`);
            return {
              ...result,
              filePath: canaryFile,
            };
          }
        }
      }

      return result;
    },
  ]);

  // Ensure we mutate the resolution context to include the custom resolver options for server and web.
  const metroConfigWithCustomContext = withMetroMutatedResolverContext(
    metroConfigWithCustomResolver,
    (
      immutableContext: CustomResolutionContext,
      moduleName: string,
      platform: string | null
    ): CustomResolutionContext => {
      const context: Mutable<CustomResolutionContext> = {
        ...immutableContext,
        preferNativePlatform: platform !== 'web',
      };

      if (isServerEnvironment(context.customResolverOptions?.environment)) {
        // Adjust nodejs source extensions to sort mjs after js, including platform variants.
        if (nodejsSourceExtensions === null) {
          nodejsSourceExtensions = getNodejsExtensions(context.sourceExts);
        }
        context.sourceExts = nodejsSourceExtensions;

        context.unstable_enablePackageExports = true;
        context.unstable_conditionsByPlatform = {};

        if (platform === 'web') {
          // Node.js runtimes should only be importing main at the moment.
          // This is a temporary fix until we can support the package.json exports.
          context.mainFields = ['main', 'module'];
        } else {
          // In Node.js + native, use the standard main fields.
          context.mainFields = ['react-native', 'main', 'module'];
        }

        // Enable react-server import conditions.
        if (context.customResolverOptions?.environment === 'react-server') {
          context.unstable_conditionNames = ['node', 'require', 'react-server', 'workerd'];
        } else {
          context.unstable_conditionNames = ['node', 'require'];
        }
      } else {
        // Non-server changes

        if (!env.EXPO_METRO_NO_MAIN_FIELD_OVERRIDE && platform && platform in preferredMainFields) {
          context.mainFields = preferredMainFields[platform];
        }
      }

      return context;
    }
  );

  return withMetroErrorReportingResolver(metroConfigWithCustomContext);
}

/** @returns `true` if the incoming resolution should be swapped. */
export function shouldAliasModule(
  input: {
    platform: string | null;
    result: Resolution;
  },
  alias: { platform: string; output: string }
): boolean {
  return (
    input.platform === alias.platform &&
    input.result?.type === 'sourceFile' &&
    typeof input.result?.filePath === 'string' &&
    normalizeSlashes(input.result.filePath).endsWith(alias.output)
  );
}

/** Add support for `react-native-web` and the Web platform. */
export async function withMetroMultiPlatformAsync(
  projectRoot: string,
  {
    config,
    exp,
    platformBundlers,
    isTsconfigPathsEnabled,
    webOutput,
    isFastResolverEnabled,
    isExporting,
    isReactCanaryEnabled,
    isReactNativeStrictVersionEnabled,
    getMetroBundler,
  }: {
    config: ConfigT;
    exp: ExpoConfig;
    isTsconfigPathsEnabled: boolean;
    platformBundlers: PlatformBundlers;
    webOutput?: 'single' | 'static' | 'server';
    isFastResolverEnabled?: boolean;
    isExporting?: boolean;
    isReactCanaryEnabled: boolean;
    isReactNativeStrictVersionEnabled: boolean,
    getMetroBundler: () => Bundler;
  }
) {
  if (!config.projectRoot) {
    // @ts-expect-error: read-only types
    config.projectRoot = projectRoot;
  }

  // Required for @expo/metro-runtime to format paths in the web LogBox.
  process.env.EXPO_PUBLIC_PROJECT_ROOT = process.env.EXPO_PUBLIC_PROJECT_ROOT ?? projectRoot;

  if (['static', 'server'].includes(webOutput ?? '')) {
    // Enable static rendering in runtime space.
    process.env.EXPO_PUBLIC_USE_STATIC = '1';
  }

  // This is used for running Expo CLI in development against projects outside the monorepo.
  if (!isDirectoryIn(__dirname, projectRoot)) {
    if (!config.watchFolders) {
      // @ts-expect-error: watchFolders is readonly
      config.watchFolders = [];
    }
    // @ts-expect-error: watchFolders is readonly
    config.watchFolders.push(path.join(require.resolve('metro-runtime/package.json'), '../..'));
    if (isReactCanaryEnabled) {
      // @ts-expect-error: watchFolders is readonly
      config.watchFolders.push(path.join(require.resolve('@expo/cli/package.json'), '..'));
    }
  }

  // @ts-expect-error
  config.transformer._expoRouterWebRendering = webOutput;
  // @ts-expect-error: Invalidate the cache when the location of expo-router changes on-disk.
  config.transformer._expoRouterPath = resolveFrom.silent(projectRoot, 'expo-router');

  let tsconfig: null | TsConfigPaths = null;

  if (isTsconfigPathsEnabled) {
    tsconfig = await loadTsConfigPathsAsync(projectRoot);
  }

  let expoConfigPlatforms = Object.entries(platformBundlers)
    .filter(
      ([platform, bundler]) => bundler === 'metro' && exp.platforms?.includes(platform as Platform)
    )
    .map(([platform]) => platform);

  if (Array.isArray(config.resolver.platforms)) {
    expoConfigPlatforms = [...new Set(expoConfigPlatforms.concat(config.resolver.platforms))];
  }

  // @ts-expect-error: typed as `readonly`.
  config.resolver.platforms = expoConfigPlatforms;

  config = withWebPolyfills(config, { getMetroBundler });

  return withExtendedResolver(config, {
    tsconfig,
    isExporting,
    isTsconfigPathsEnabled,
    isFastResolverEnabled,
    isReactCanaryEnabled,
    getMetroBundler,
  });
}

function isDirectoryIn(targetPath: string, rootPath: string) {
  return targetPath.startsWith(rootPath) && targetPath.length >= rootPath.length;
}
