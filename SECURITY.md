# Security policy

## Supported versions

Only the current development line (`main`) is supported until a release
policy is published. Older snapshots may not receive security fixes.

The `preview` channel is for supervised classroom pilots. Update the server first;
managed student installations follow the server's exact preview version. A preview
is not a stable-release or production-readiness claim.

## Temporary dependency mitigation

`braces@3.0.3` remains listed under
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), with no
upstream patched version as of 2026-10-05. The committed Bun patch bounds parser
stack depth before the recursive AST walkers are reached. It covers string inputs
through parse, compile, expand and stringify, including parentheses; it is not a
general guarantee for caller-constructed AST objects. Marea does not pass externally
provided AST objects to these APIs.

`bun run release:audit` first verifies the installed patch and regression cases,
then excludes only that advisory from the high-severity audit. An unpatched install
fails before the exclusion is used. All other high/critical advisories remain
blocking. Plain `bun audit` intentionally continues to report the upstream advisory.
Remove the patch and exclusion together once upstream provides a reviewed fix.
The separate `brace-expansion` advisories are addressed by upgrading to 5.0.12.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting or a private security advisory for this
repository when that feature is enabled. If it is unavailable, contact the
repository maintainers through a private channel listed in the repository
profile and ask them to enable private reporting.

Include the affected commit or version, impact, reproduction steps, and any
safe mitigation. Do not include credentials, real student information,
private school configuration, or other sensitive data in a report.

Maintainers will acknowledge the report privately, verify the impact, and
coordinate remediation and disclosure timing with the reporter. Do not publish
details until that coordination is complete.

## Security baseline

Changes must preserve Marea's trust boundaries: server credentials, real model
identifiers, student data, and private teaching or evaluation instructions must
not leak to clients, logs, fixtures, or pull-request output.
GitHub Actions run dependency review for high-or-higher introduced advisories,
`bun audit` at the high threshold, and CodeQL for JavaScript/TypeScript.
Repository administrators must enable the dependency graph, Dependabot alerts,
secret scanning, and private vulnerability reporting in repository settings
where available.

## Preview baseline CodeQL review

The CodeQL report for commit `622226e` was reviewed on 2026-10-05. Its three
results do not establish an exploitable vulnerability in that revision:

- `js/polynomial-redos`, `packages/i18n/src/locale.ts`: the suffix expression
  consumes disjoint delimiter and payload character sets and has no trailing
  constraint that would force backtracking through successful repetitions.
  Failed starting positions are constant work. Adversarial checks with repeated
  hyphens and alternating delimiters up to one million repetitions showed linear
  scaling. Reassess this finding if the expression gains overlapping alternatives
  or a trailing constraint.
- `js/bad-code-sanitization`, `apps/teacher-server/src/platform/operations/host/host.test.ts`:
  this test encodes generated temporary paths as JavaScript string literals with
  `JSON.stringify`, then passes the source directly to Bun as an argument, without
  shell interpolation. It does not concatenate raw path text into executable code.
- `js/shell-command-injection-from-environment`,
  `apps/teacher-server/smoke/compiled-host-process.ts`: the shell program is a fixed
  literal. Executable paths and arguments travel through quoted positional
  parameters (`"$@"`), never through interpolated shell source. This is a local
  acceptance harness, not a server request handler.

These are revision-specific assessments, not suppressed queries. CI retains the
SARIF report as a review artifact, including while the repository is private;
public repositories also upload the results to GitHub code scanning. Review new
results and changed call paths independently.
