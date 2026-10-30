# @sqlbraid/webpack

A Webpack loader for guarded SQLBraid templates. It calls `@sqlbraid/compiler` directly.
It does not include the migration features of `@sqlbraid/migrate/vite`.

```sh
pnpm add --save-dev @sqlbraid/webpack
pnpm add @sqlbraid/template
```

Use Node.js 22.18.0 or later for this build tool. Application runtime requirements do not change.
The CommonJS entry exports the loader function. It loads the ESM compiler through dynamic import.
The package does not install Webpack. Rspack and Turbopack can run the same loader.

## Webpack

Run SQLBraid before TypeScript or JSX transpilation. Loader arrays execute from right to left.
Install `ts-loader` and `typescript` when using this example.

<!-- doc-snippet: skip -->

```js
// webpack.config.cjs
module.exports = {
  devtool: "source-map",
  resolve: { extensions: [".tsx", ".ts", ".js"] },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader", options: { transpileOnly: true } }, "@sqlbraid/webpack"],
      },
    ],
  },
};
```

Set `compilerOptions.sourceMap` to `true` in `tsconfig.json` when using `ts-loader`.
For existing transpilation rules, add a separate SQLBraid rule with `enforce: 'pre'`.
Exclude generated files through your bundler rules when necessary.
The loader transforms each matched file. It does not apply hidden path filters.

## Rspack

Use the same rule with Rspack. The tested configuration uses `ts-loader` with `transpileOnly: true`.
No Rspack-specific loader implementation or plugin is required.
Your existing JSX and TypeScript transpiler remains responsible for JavaScript output.

## Next.js

Configure Webpack and Turbopack separately. Webpack configuration does not configure Turbopack.

<!-- doc-snippet: skip -->

```js
// next.config.mjs
export default {
  webpack(config) {
    config.module.rules.push({
      test: /\.[cm]?[jt]sx?$/,
      exclude: /node_modules/,
      enforce: "pre",
      use: ["@sqlbraid/webpack"],
    });
    return config;
  },
  turbopack: {
    rules: {
      "*.{ts,tsx,js,jsx}": {
        condition: { not: "foreign" },
        loaders: ["@sqlbraid/webpack"],
      },
    },
  },
};
```

Use `next dev --webpack` and `next build --webpack` for Webpack.
Use `next dev --turbopack` and `next build --turbopack` for Turbopack.
Keep the original extensions. Do not set `as: '*.js'` for TypeScript output.
The tested Turbopack configuration processes the remaining TS and TSX syntax after the loader.

Keep database imports and execution in server-only modules. Add `import 'server-only'` to those modules.
The loader preserves `use client` and `use server` prologues. It does not enforce your application's server boundary.

## Evaluation and type checking

The compiler creates conditional evaluation code. It does not enumerate SQL variants or evaluate conditions during the build.
Conditions and interpolation values execute at runtime. Inactive branches do not evaluate their interpolation expressions.
The runtime renders SQL segments and bound values from the resulting query.

The loader does not perform semantic TypeScript checking. This matches `@sqlbraid/vite`.
SQLBraid's `checkSource()` checker understands narrowing across `@braid if` directives.
Plain `tsc`, `ts-loader` type checking and Next.js's original-source checker do not understand that narrowing.
Use SQLBraid compiler checking for guarded expressions and mapper output types.
Do not type-check the runtime lowering as a replacement for the compiler's checker overlay.

The integration fixture runs `checkSource()` for every TS and TSX input before building.
It then uses `transpileOnly` and Next.js `typescript.ignoreBuildErrors` because those checks read the original source.
Do not disable your application's type checks without a separate checking gate.
The Next.js example retains its default type checks. Guarded nullable property accesses require the separate checking workflow described above.

## Options, diagnostics and maps

The default options recognize first-party SQLBraid imports.
For a custom authoring module, use serializable loader options:

<!-- doc-snippet: skip -->

```js
{ loader: '@sqlbraid/webpack', options: {
  moduleSpecifiers: ['@app/sql'],
  tagExport: 'sql',
} }
```

Unknown options and invalid option values fail the build.
Compiler errors and warnings retain their code, file, line and column.
Errors fail the build. They never trigger an untransformed fallback.

The loader passes source maps to the next loader. It composes an incoming map with the compiler map.
Diagnostics also use incoming maps to recover original positions.
Files without a transformation retain their incoming map.
Enable your bundler's source maps when you need final bundle maps.

The transform reads only its source and options. The bundler owns its cache and watches the input file.
There are no additional configuration files or hidden file dependencies.

## Verification and compatibility

These are tested versions, not an exclusive support list. There are no exact-version runtime checks.
Webpack 5's loader API is the baseline. Other versions must provide the APIs used by this loader.
Required APIs are `resourcePath`, `getOptions`, `cacheable`, `async`, `emitError` and `emitWarning`.
Turbopack rules and CLI flags can differ in older Next.js versions.

| Environment            | Tested version | Evidence                                                                    |
| ---------------------- | -------------- | --------------------------------------------------------------------------- |
| Webpack                | 5.111.1        | Packed TS/TSX build, execution, maps, watch rebuild                         |
| Rspack                 | 2.2.8          | Same packed loader, TS/TSX build, execution, maps, watch rebuild            |
| Next.js with Webpack   | 16.4.3         | Development edits, hydration, server SQLite, production build and execution |
| Next.js with Turbopack | 16.4.3         | Same checks, original TS/TSX extensions, no `as` override                   |

The fixtures use TypeScript 5.9.3, ts-loader 9.6.2, React 19.3.0 and Node.js 22.18.0.
They assert inactive-branch laziness, ordered single evaluation, lexical `this`, mapper identity and output types.
The existing compiler and Vite regression tests remain part of unit validation.
These bundler checks do not promote any runtime/driver capability certification.

Run `pnpm run test:webpack` from the repository. Install Chromium with
`pnpm --dir tests exec playwright install chromium` before the browser checks.
The gate installs tarballs outside the workspace. It needs registry access for consumer dependencies.
Test dependencies and fixtures belong to the private `tests` package.

References: [Webpack loader API](https://webpack.js.org/api/loaders/),
[Rspack loader API](https://rspack.rs/api/loader-api/),
[Next.js Turbopack rules and limitations](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack),
[SQLBraid documentation](https://clickin.github.io/SQLBraid/).
