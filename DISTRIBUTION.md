# Preview installation and updates

The commands below are for a **published** `0.1.0-preview.5`. Substitute another
published preview tag when appropriate. Adding this guide does not publish that
version: first complete the native release workflow described below.

## Teacher server

macOS Apple Silicon or Linux x64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.5/install.sh | sh -s -- server
```

Windows x64, in PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.5/install.ps1'))) -Component server
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

Use the **same version as the school's server** and replace the example origin.
macOS Apple Silicon or Linux x64/ARM64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.5/install.sh | sh -s -- student --server https://marea.example.edu
```

Windows x64/ARM64:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.5/install.ps1'))) -Component student -Server https://marea.example.edu
```

Run `marea` from the project directory. The managed installation keeps student
session state under `~/.marea-preview/student/student-state`; it does not reuse
the old manual installation's `~/.marea` state. `MAREA_SERVER_URL` and
`MAREA_STATE_HOME` still allow explicit overrides.

## Updates and recovery

- `marea --version` / `marea-teacher --version`: installed preview version.
- `--status`: managed installation details, with no credentials.
- `--update`: check and ask to update without starting the application.
- Ordinary interactive startup also offers updates; a noninteractive start never
  accepts one. Discovery has a short timeout and failure leaves the current
  installation usable.
- The server follows published `*-preview.N` versions. Students follow the exact
  version advertised by their server, including a previously retained version.
  Stable releases, drafts and release candidates are not part of this channel.

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

## Publish a version

1. Review the change and pass `bun run release:audit` and `bun run quality`.
2. Commit the complete tested source, including the MIT license, dependency patch
   and workflows. Create and push an immutable tag such as `v0.1.0-preview.5`.
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
