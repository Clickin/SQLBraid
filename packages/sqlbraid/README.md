# sqlbraid

The unscoped SQLBraid command-line convenience package.

```sh
npm install --save-dev sqlbraid
npx sqlbraid codegen --check
```

This package forwards to `@sqlbraid/cli`. Runtime and application packages
remain available under the `@sqlbraid/*` scope; this package does not include
database drivers or a runtime umbrella API.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
