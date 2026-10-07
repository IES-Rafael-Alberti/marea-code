# Contributing to Marea Code

Marea Code is built with Bun workspaces and strict TypeScript. Engineering
code, commits, tests, and documentation are written in English.
Educational content may use the language used with students.

## Before you start

- Install Bun 1.4.2. The `packageManager` and `engines` fields in the root
  `package.json` are the version contract.
- Keep generated output, private installation state and local research notebooks
  out of changes. Shared behavior and setup instructions belong in tracked documentation.

## Local setup

From a clean checkout:

```sh
bun install --frozen-lockfile
```

Run the complete repository quality suite before opening a pull request:

```sh
bun run quality
```

For a faster focused loop, use `bun run test`, `bun run lint`,
`bun run typecheck`, `bun run compatibility:bun`, and `bun run format:check` as
appropriate. A pull request must leave the full `quality` command passing; do
not bypass a failing gate.

First-party plugins are discovered from the public `plugins/` tree at build
time. After adding, removing, or changing a plugin manifest, regenerate the
checked-in catalog and verify it has no drift:

```sh
bun run catalog:generate
bun run catalog:check
```

Identity and inference setup forms use installed plugin descriptors. The local web
setup accepts generic identity settings, validates them with the selected plugin,
and stores them in separate private files. Removed plugins are ignored before their
credential files are read; configuration on disk is retained. Model routes pointing
to an absent provider still need an administrator to select an installed replacement.
Removal takes effect after regenerating the catalog and rebuilding/reinstalling the
executables, not by deleting source files beside an already compiled binary.

## Commits and pull requests

Use an English [Conventional Commit](https://www.conventionalcommits.org/)
for commits and pull request titles. For example:

```text
feat(server): add resumable session controller
fix(protocol): reject duplicate event sequences
docs(security): clarify token handling
```

Keep commits focused and independently testable. The pull request description
should explain behavior, risk, security or privacy impact, and validation. Do
not commit secrets, student data, local state, or dependency churn unrelated to
the change. Generated output is untracked unless its owning workflow explicitly
requires a reviewed artifact, as the plugin catalog does.

For changes to architecture, security boundaries, persistence, the public protocol
or the plugin API, explain the decision, alternatives and validation in the pull
request and update the relevant tracked documentation.

The CI workflows run the quality suite, validate the title with the repository
commitlint configuration, review dependency changes, audit dependencies, and
run CodeQL. A maintainer may request additional platform or integration checks.

Routine Dependabot version PRs are paused during the first classroom pilot with
`open-pull-requests-limit: 0` for Bun and GitHub Actions. Closing a grouped PR alone
does not prevent Dependabot from proposing those versions again. This limit does
not apply to security update PRs; dependency auditing also continues on every CI
run and on the Security schedule. We do not ignore vulnerable dependency versions.

When routine updates resume, raise that limit and review major upgrades as explicit
migrations. The monthly groups keep coupled tools such as Vitest and its coverage
provider together. A failing update is not merged just to clear the queue; retain
the validated versions until its compatibility failures are resolved.

## Preview compatibility and promotion

A release number identifies the executable; a protocol version identifies the wire
contract. Keep existing request/response shapes and baseline capabilities compatible
within a protocol generation. Gate optional features on advertised capabilities;
if a change would break an older peer (including a strict schema), bump the protocol
instead of silently requiring equal software versions. Do not add historical adapters
without a concrete need. Keep focused negotiation tests for older/newer software
versions and the native client/server journeys in the release workflow.

The optional Socratic writing gate is advertised as `marea.tutoring.socratic-gate`.
New students and dashboard clients send `x-marea-socratic-gate: 1` to opt into
`socraticMode` (`off`, `normal`, `strict`) in snapshots and teaching settings.
Headerless responses keep the strict baseline shape. A tutoring run with an active
gate refuses a headerless client with `protocol.incompatible` inside the open-run
transaction, before changing any lease. Free mode and legacy/disabled policies remain
compatible. A baseline editor omitting the field preserves the saved policy.
The policy is frozen in each run; the adapter derives attempts and completed
structured questions from the current turn's durable messages. There is no mutable
process counter. HITL and execution use the same predicate, excluding sibling results
from the current tool batch, so a skipped approval can only produce a blocked result.
This is a teaching aid, not a sandbox: shell commands retain their separate approval.

Publishing makes a preview available to explicit `update` commands. Recommendation
is a separate maintainer operation after pilot testing; see [distribution](DISTRIBUTION.md).
Never move signed tags, replace published assets, or use recommendation as a database
rollback. The recommendation workflow verifies the successful native publication
and signed protocol metadata before updating the small static channel index.

Session exports and optional full-content telemetry are documented in
[Observability](OBSERVABILITY.md). Export permissions follow current class membership;
external configuration is administrator-only. Exporter plugins declare their own setup
fields through the session-trace API. Do not send session content through the existing
operational-metrics sanitizer or weaken its allowlist. Schema 13 adds only delivery
references and counters; earlier migration checksums remain immutable.
