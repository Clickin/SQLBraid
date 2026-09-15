# Security policy

SQLBraid accepts reports for vulnerabilities in the source repository,
published packages, documentation site, build/release workflows, and
first-party database adapters.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Submit a
[private vulnerability report through GitHub](https://github.com/Clickin/SQLBraid/security/advisories/new).
Private vulnerability reporting is enabled for this repository. Include the
affected version, a minimal reproduction, and the security impact; do not
include live credentials or unrelated private data.

There is no guaranteed response time, service-level agreement, or bounty
program.

## Examples of security-sensitive reports

- a value interpolation or binding path that permits SQL injection;
- a way to bypass the explicit trusted boundary of `sql.raw`;
- credential or secret exposure through logs, observers, diagnostics, or
  release artifacts;
- a release workflow or package artifact integrity compromise.
