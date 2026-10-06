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
