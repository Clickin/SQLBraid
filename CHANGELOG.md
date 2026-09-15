# Changelog

This changelog covers the lockstep SQLBraid workspace release train. It
summarizes durable compatibility and release information; detailed behavior
and support evidence live in the [public API audit](docs/public-api-audit.md),
[release notes](docs/SQLBraid_0.1.0_release_notes.md), and
[versioned support records](support/targets/).

## Unreleased

- RC2 hardening documents the compatibility discipline for the Application,
  SPI, serialized metadata, compiler, and tooling surfaces.
- Prepared-query calling semantics are explicit: input factories use the
  required-input form by default (or `{ input: "required" }`), while
  zero-input factories must declare `{ input: "none" }` and remain
  options-only at execution. Implementations must not infer the form from
  JavaScript `Function.length` or option-shaped input values.
- Any metadata identity or format migration must be called out here with its
  format version and migration guidance before release.

## 0.1.0

Initial pre-release SQL-first surface:

- tagged SQL templates with safe value binds, bounded `@braid` directives,
  explicit result kinds, Standard Schema mapping, and structural helpers;
- direct and pooled execution with explicit sessions, transactions,
  savepoints, streams, bulk operations, observers, and capability-driven
  unsupported errors;
- prepared queries, first-party dialect and driver adapters, metadata
  inspection, deterministic code generation, CLI/LSP/Vite tooling, and the
  browser playground;
- exact-value representation policies and tuple-specific support evidence.

See [SQLBraid 0.1.0 release notes](docs/SQLBraid_0.1.0_release_notes.md) for
the complete surface and deliberate nonfeatures. This pre-release does not
authorize package, GitHub, Marketplace, or Pages publication.
