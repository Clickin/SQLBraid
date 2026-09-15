# Security policy

SQLBraid accepts reports for vulnerabilities in the source repository,
published packages, documentation site, build/release workflows, and
first-party database adapters.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. GitHub's private
vulnerability-reporting feature is not enabled for this repository at this
revision, so this policy does not claim a private URL that does not exist.
Maintainers must enable a private reporting path and update this section
before release. Until then, use only a non-public maintainer channel already
established for this project; do not disclose exploit details publicly if no
such channel is available.

There is no guaranteed response time, service-level agreement, or bounty
program.

## Examples of security-sensitive reports

- a value interpolation or binding path that permits SQL injection;
- a way to bypass the explicit trusted boundary of `sql.raw`;
- credential or secret exposure through logs, observers, diagnostics, or
  release artifacts;
- a release workflow or package artifact integrity compromise.
