# Preview installation and updates

The commands below target `0.1.0-preview.8`, the first preview with independent
recommendations and managed uninstall. **Publish and recommend that version before
sharing these commands.** Version 6 predates this policy; its immutable installers
still use its original update behavior. Updating an existing installation to version
8 or later enables the policy below.

## Teacher server

macOS Apple Silicon or Linux x64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.8/install.sh | sh -s -- server
```

Windows x64, in PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.8/install.ps1'))) -Component server
```

The wizard creates a new installation under `~/.marea-preview/server`, asks for
the teacher password without displaying or storing plaintext, and creates the
first center and class. It does not modify `~/marea-prueba` or adopt existing data.
It prints the launch command. On Windows, reopen the terminal after installation
to pick up the per-user PATH entry.

Choose an HTTPS origin accessible from student computers. Configure your reverse
proxy to forward to `127.0.0.1:18787` (or the chosen port), preserving the public
Host and Origin. TLS certificates, DNS, firewall access and reverse-proxy setup
are environment-specific and are not provisioned by this installer. HTTP is
accepted only for testing on the same machine.

Start `marea-teacher`, open `/dashboard/`, sign in and configure the model provider
under Settings → Server. Enable the common route and save the teaching
configuration for the first class before inviting students. API keys stay in the
private installation; do not include them in student installation commands.

The optional Google prompts accept a desktop OAuth client ID, client secret and
school domain. Domain administration, OAuth consent and trusting the application
for minors still happen in Google Workspace. Group membership additionally needs
service-account configuration.

## Student computers

Student computers need Git installed and available on `PATH` for project snapshots
and change tracking. The application runtime is included in the package.

Installation selects the recommended client without querying the school server.
Replace the example origin with the address supplied by the teacher.
macOS Apple Silicon or Linux x64/ARM64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.8/install.sh | sh -s -- student --server https://marea.example.edu
```

Windows x64/ARM64:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.8/install.ps1'))) -Component student -Server https://marea.example.edu
```

Run `marea` from the project directory. The managed installation keeps student
session state under `~/.marea-preview/student/student-state`; it does not reuse
the old manual installation's `~/.marea` state. `MAREA_SERVER_URL` and
`MAREA_STATE_HOME` still allow explicit overrides.

## Updates and recovery

- `marea --version` / `marea-teacher --version`: installed preview version.
- `status` (or `--status`): managed installation details, with no credentials.
- `update` (or `--update`): check the latest **published** preview and ask to install
  it, without starting the application. Publishing alone does not notify everyone.
- `update --version 0.1.0-preview.8`: try a specific published preview.
- Ordinary startup offers only a **recommended** version for this component and
  wire protocol. Declining keeps the installed version. A noninteractive start
  never accepts updates; discovery failures leave the current installation usable.
- Client and server release numbers need not match. A common protocol and the
  required baseline capabilities determine compatibility; optional capabilities
  remain optional. Support is bounded to the advertised protocol generation,
  rather than an indefinite collection of historical adapters.
- If the school reports an incompatible protocol, the launcher offers its concrete
  release as a compatible client. Refusal or a failed verified download prevents
  that connection. It never installs unsigned code supplied by the school.
- Recommendations never automatically downgrade an installation. An explicit
  student version or a required protocol repair may select an older signed client.
  Server downgrades require backup recovery; they cannot open migrated data.

For a fresh pilot install before recommendation, append `--version 0.1.0-preview.8`
to the POSIX command, or `-Version 0.1.0-preview.8` on PowerShell. With no explicit
version and no recommendation, installation stops with a useful message.

Stop the server before accepting an update. Its existing exclusive installation
lock prevents an update while a teacher host or another offline operation owns
the data. A deletion-aware backup precedes migration; the matching dashboard and
server version change together. Settings and credentials are preserved.

An interrupted server update leaves `installation/state/preview-update-pending.json`
with the backup location and previous host configuration. The managed launcher
refuses to start until recovery has been performed. Keep this file and the backup;
do not delete the journal or point an old executable at a migrated database.
Use the existing `marea-operations backup restore` command with a private JSON
input containing `bundlePath` and a **new** `destinationRoot`. That operation
enforces deletion authority. Inspect the restored installation and explicitly
select its matching program version before resuming. Retained executables alone
are not a database rollback.

If first-time setup is interrupted, `preview.json` is absent and the launcher
cannot start. Preserve the partial directory for diagnosis; retry with a new
`--root` on POSIX or move the incomplete directory aside after checking that it
contains no classroom data. The installer never silently deletes existing state.

## Uninstall

Close other Marea sessions first. Run `marea uninstall` to remove the managed
student programs, launchers, saved credentials and session state, and the exact
PATH entries installed by Marea. Project directories outside the managed root
are preserved. An explicit external `MAREA_STATE_HOME` is not owned or deleted.

`marea-teacher uninstall` removes programs and launchers but **preserves** the
center data under `~/.marea-preview/server/installation`. To remove that data,
including credentials and backups, use `marea-teacher uninstall --purge-data`.
The server must be stopped; its exclusive installation lock prevents deletion
while it is running. Confirmation requires typing `DESINSTALAR`; `--yes` is the
explicit noninteractive alternative. Inspect and move preserved data before
installing anew at the same managed root.

Windows runs uninstall through a temporary copy so it can remove its executable.
An installation upgraded from the version 6 launcher may ask you to run uninstall
once more after upgrading the owned launcher. Customized launchers are not
silently rewritten. Unknown files in the managed root are preserved. Linked or
otherwise unsafe shell profiles are preserved and reported for manual PATH cleanup.

## Publish a version

1. Review the change and pass `bun run release:audit` and `bun run quality`.
2. Commit the complete tested source, including the MIT license, dependency patch
   and workflows. Create and push an immutable tag such as `v0.1.0-preview.8`.
3. Run **Native preview releases** on that tag with the matching version. Leave
   `publish` false for a rehearsal; enable it for an actual prerelease.
   `native_only` avoids duplicating an already-running quality check during a
   rehearsal. Enabling publication always runs every quality gate.
4. The workflow runs quality and audit, builds and tests every supported native
   target, signs manifests using the exact workflow/tag identity, and tests
   installation, update and recovery. Publication requires the complete matrix.
5. All assets upload to a draft first. Only after every upload succeeds is it made
   available as a prerelease, never as GitHub's latest stable release. A failed upload
   leaves a draft for inspection; do not overwrite a published version.
6. Ask pilot users to run `update` (or install the explicit version). After classroom
   testing, recommend it separately; publication never recommends automatically.

## Recommend a tested preview

Run the **Recommend preview** workflow on `main`, choosing the published version
and `student`, `server`, or `both`. From a maintainer terminal:

```sh
gh workflow run recommend-preview.yml --ref main -f version=0.1.0-preview.8 -f component=both
```

Promotion requires a successful native publication workflow for the exact source,
downloads and verifies the complete signed publication, checks its protocol metadata, and adds a component/protocol marker to the release
notes. It preserves assets, tag and existing notes. Recommendations are forward
only and idempotent; an older protocol keeps its previous recommendation. Do not
edit these markers manually. Keep published versions available so existing
installations and explicit protocol repairs can still download them.

There is no additional “recommended release” or mutable executable feed. For a
bad recommendation, publish a corrected preview and recommend that; restore
server backups when a database rollback is needed.

Native validation and prerelease creation can run while the repository is private,
using the organization's GitHub Actions allowance. The one-command installers
require public release downloads; make the repository public before distributing
them to colleagues. Build artifacts retained for review expire after seven days;
published release assets are the distribution source. Installer scripts pin the bootstrap executable and signature verifier by
SHA-256. Subsequent downloads require a Sigstore signature tied to this repository,
workflow and exact tag, plus a closed per-file hash inventory. The distribution
does not extract untrusted archives or obtain commands from the school server.

The workflow signature is not macOS notarization or Windows Authenticode signing.
Operating-system protection and school application-control policies may still
require administrators to approve these preview binaries. Do not disable those
protections globally.

On Windows, student checkpoints flush the temporary file, atomically replace the
checkpoint, and flush the resulting file. This supports recovery after the client
exits or crashes. Windows does not support POSIX directory synchronization, so
checkpoint directory-entry durability across a sudden power loss is not guaranteed.
File synchronization errors remain fatal; they are never silently ignored.

To verify an existing publication without rebuilding or modifying it, run
**Native preview releases** on `main`, set its version and enable only
`verify_published`. This downloads every release asset and checks all eight
Sigstore identities, the tagged source commit, the closed file inventory and
every checksum. It does not replace the native tests required for publication.
