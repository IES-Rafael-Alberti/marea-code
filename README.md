# Marea Code

Marea is a programming tutor for the classroom. Students work in a terminal with
their own project; teachers configure teaching, review sessions and manage classes
in a web dashboard. Model credentials and private teaching instructions stay on
the teacher server. Google Workspace sign-in is optional.

Marea is under active development. The `preview` channel is for supervised pilots,
not a stable release. Google Workspace still needs a real-school acceptance test;
automated identity tests use simulated Google responses.

## Try a preview

Published previews, when available, are listed in
[GitHub Releases](https://github.com/IES-Rafael-Alberti/marea-code/releases).
Use the version's `install.sh` or `install.ps1` as described in the
[installation and update guide](DISTRIBUTION.md). The server installer asks for
the initial school, teacher and class. Students only need their school's server
address. Bun, Node and a source checkout are not required to install a package.
Student computers need Git on `PATH` for project snapshots and change tracking.

| System              | Student | Teacher server |
| ------------------- | ------- | -------------- |
| Windows x64         | Yes     | Yes            |
| Windows ARM64       | Yes     | No             |
| Linux x64           | Yes     | Yes            |
| Linux ARM64         | Yes     | No             |
| macOS Apple Silicon | Yes     | Yes            |
| macOS Intel         | Not yet | Not yet        |

Each target must pass the native release workflow before it is published. Being
listed here does not imply that the current working tree has passed that matrix.
The server listens on loopback; access from other computers needs an HTTPS reverse
proxy and a school-reachable address. A local `127.0.0.1` address cannot be shared
with students on other computers.

Managed installations offer **recommended** updates at startup; `marea update`
and `marea-teacher update` let a pilot group try the latest published preview first.
Client and server software versions can differ while their wire protocol and
required capabilities remain compatible. Teachers update a stopped server, with a
backup before migration. Download failures do not replace the installed program.
See [distribution](DISTRIBUTION.md) for recommendation, recovery and uninstall commands.

## Develop

Install **Bun 1.4.2**, then:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run release:audit
bun run quality
```

The quality suite checks formatting, lint, TypeScript, Bun compatibility,
architecture boundaries, unused code, duplication, complexity, per-file coverage
and mutation testing. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance
and [SECURITY.md](SECURITY.md) for reporting and the documented dependency mitigation.

The main applications are `apps/student`, `apps/teacher-server` and
`apps/dashboard`; shared contracts live in `packages`, and first-party extensions
in `plugins`. Distribution code lives in `scripts/release`.

## License

Marea Code is distributed under the [MIT License](LICENSE). Third-party dependencies
retain their own licenses; release packages include their available notices and
the dependency inventory.
