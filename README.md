# Marea Code

Marea is a programming tutor for the classroom. Students work in a terminal with
their own project; teachers configure teaching, review sessions and manage classes
in a web dashboard. Model credentials and private teaching instructions stay on
the teacher server. Google Workspace sign-in is optional.

Marea is under active development. The `preview` channel is for supervised pilots,
not a stable release. Google Workspace sign-in with individual student addresses has been tried in a real
school. Group membership still needs that acceptance test; automated identity tests
use simulated Google responses.

## Try a preview

Published previews, when available, are listed in
[GitHub Releases](https://github.com/IES-Rafael-Alberti/marea-code/releases).
Use the version's `install.sh` or `install.ps1` as described in the
[installation and update guide](DISTRIBUTION.md). The first server launch opens a web wizard for
the school, teacher, model and first class. Students only need their school's server
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
The server listens on loopback by default. For other classroom computers, choose
LAN HTTP during setup or start with `marea-teacher --allow-http` on a trusted
network. HTTPS uses a reverse proxy and a school-reachable address. A local
`127.0.0.1` address cannot be shared with students on other computers.

Managed installations offer **recommended** updates at startup; `marea update`
and `marea-teacher update` let a pilot group try the latest published preview first.
Client and server software versions can differ while their wire protocol and
required capabilities remain compatible. Teachers update a stopped server; on its
first start the new server backs up the database and migrates it to its schema. Download failures do not replace the installed program.
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

## Mandatory didactic materials

Before the tutor startup or a resumed turn can execute, the production client reads
all selected `SKILL.md` files through the immutable run skill reader. Each bundle's
identity, snapshot, digest and canonical bytes are checked before its full document
is admitted. A failed or cancelled load never admits partial instructions; the same
turn can retry. Auxiliary files remain available through the exact-id read tool.

The verified documents are part of the runtime system prompt, for both startup and
conversation, rather than tool results in conversation history. Reopening a client
reloads the session's frozen versions; teacher edits apply only to new sessions.
Explicit class instructions and Marea safety/permission rules take precedence over
skill content. Evaluation material remains on the separate private evaluator path.
The student sees a localized loading status, not the instruction content.

Admission never truncates or automatically summarizes mandatory documents. The
client reserves space for project and harness instructions inside the existing
64K-character gateway message envelope (48,000 characters for materials plus the
snapshot prompt). This transport limit is independent of the model context window.
A larger model cannot remove that transport limit.

The production OpenRouter provider checks every full inference request against the
account's model catalog, cached for five minutes. It uses the smaller advertised
model/top-provider context limit, a conservative UTF-8 byte-based token estimate,
a 4,096-token framing allowance, and an explicit output reserve. This is not an
exact tokenizer: it may reject requests that would fit. Unknown capacity blocks
inference with a retryable error; excessive context requires reducing materials or
selecting a larger model and starting a new session. Preflight refusals settle with
zero inference tokens/cost. The catalog requires network access when refreshed.

Provider metadata follows the [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/get-models).
Other inference plugins must supply their own admission check; this does not add
model identifiers or provider secrets to the student protocol.

## License

Marea Code is distributed under the [MIT License](LICENSE). Third-party dependencies
retain their own licenses; release packages include their available notices and
the dependency inventory.
