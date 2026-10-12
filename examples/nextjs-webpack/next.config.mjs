// Run the SQLBraid loader before Next.js transpiles TypeScript.
// Webpack and Turbopack have separate settings. This example sets both.
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
