# @sqlbraid/vite

Vite plugin that lowers SQLBraid guarded SQL templates before Vite's normal
transforms.

```sh
npm install @sqlbraid/vite vite
```

`vite` is a peer dependency (`>=8.0.0`). Add `sqlbraid()` to the Vite plugins
list. The plugin supports TypeScript and JavaScript source and preserves
compiler diagnostics and source maps.

See the [Vite integration guide](https://clickin.github.io/SQLBraid/getting-started/vite/)
and the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
