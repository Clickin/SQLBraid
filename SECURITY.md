# Security policy

SQLBraid accepts reports for vulnerabilities in the source repository,
published packages, documentation site, build/release workflows, and
first-party database adapters.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use the private
vulnerability-reporting mechanism enabled for this repository in GitHub. If
that mechanism is not available, do not disclose exploit details publicly;
contact a maintainer through a non-public channel already established for this
project. The maintainers will document the concrete private reporting path
here when the repository configuration is confirmed.

There is no guaranteed response time, service-level agreement, or bounty
program.

## Examples of security-sensitive reports

- a value interpolation or binding path that permits SQL injection;
- a way to bypass the explicit trusted boundary of `sql.raw`;
- credential or secret exposure through logs, observers, diagnostics, or
  release artifacts;
- a release workflow or package artifact integrity compromise.
