# Security policy

SQLBraid accepts reports about vulnerabilities in these areas:

- the source repository;
- the published packages;
- the documentation site;
- the build and release workflows;
- the first-party database adapters.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Send a
[private vulnerability report through GitHub](https://github.com/Clickin/SQLBraid/security/advisories/new).
This repository has private vulnerability reporting enabled.

Include these items in the report:

- the affected version;
- a minimal reproduction;
- the security impact.

Do not include live credentials or unrelated private data.

There is no guaranteed response time, no service-level agreement and no bounty
program.

## Examples of security-sensitive reports

- A value interpolation or binding path that permits SQL injection.
- A method to bypass the explicit trusted boundary of `sql.raw`.
- Credentials or secrets that become visible through logs, observers,
  diagnostics or release artifacts.
- A compromise of the integrity of a release workflow or a package artifact.
