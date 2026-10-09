# Preview installation and updates

The commands below target `0.1.0-preview.25`. This preview simplifies first-run
setup and organizes settings by task. It adds inline password validation, optional
educational features, web-managed school accounts and clearer Google group setup.
Drafts survive section changes, saved keys remain private, and saving reveals any
invalid field. It also fixes the blank dashboard on browsers without `URL.parse`.
Fresh teacher installations open a browser setup wizard on their first launch.
The wizard collects the school,
teacher account, model connection and classroom access, then saves a usable first
class and opens the dashboard. Existing schools retain their data and settings.
This version adds authorized session ZIP exports and optional full-content
observability through Langfuse or an OTLP collector. Delivery is off by default
and configured by a server administrator. Existing teaching choices and the
configurable tutor writing gate are preserved. Earlier installation, LAN HTTP,
model catalog, unlimited usage defaults and plugin-driven setup are included.

Published installers and tags remain immutable.

## Teacher server

macOS Apple Silicon or Linux x64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.25/install.sh | sh -s -- server
```

Windows x64, in PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.25/install.ps1'))) -Component server
```

The installer puts programs and launchers under `~/.marea-preview/server`.
It does not ask for school data in the terminal. On Windows, reopen the terminal
after installation to pick up the per-user PATH entry, then run:

```sh
marea-teacher
```

On the first launch, a browser opens a five-step wizard:

1. School, first class and teacher account, with password validation beside the fields.
2. Provider key and model, with connection verification and model suggestions.
3. Local-only, classroom LAN HTTP or a configured HTTPS origin; optional school accounts.
4. Optional attention map, reports, automatic evaluation and example testing skill.
5. Review and creation. Progress is visible while the installation is prepared.

The first class is saved in tutoring mode with student approval required for
project changes. Usage defaults to unlimited. Automatic evaluation is disabled
unless selected; enabling it also selects the bundled session-review method.
Optional map and report models initially use the verified main connection.
Prices, usage limits and separate feature models can be adjusted later in settings.
The local dashboard opens already signed in. HTTPS installations use their normal
login page. Further launches start the existing school without showing the wizard.
The LAN choice is remembered by the managed launcher.

If the browser cannot open, use the private setup link printed in the terminal
on the same computer. Setup listens only on loopback and requires the random
capability in that link, an exact Host and a same-origin POST. Passwords and API
keys remain in memory or private installation files; they are never put in the URL.
`~/marea-prueba` and other existing installations are not adopted or modified.

For HTTPS, choose an origin accessible from student computers and configure your
reverse proxy to forward to `127.0.0.1:18787` (or the chosen port), preserving the
public Host and Origin. Certificates, DNS and proxy setup are not provisioned by
the installer.

For a classroom LAN without a proxy or certificates, start with:

```sh
marea-teacher --allow-http
```

The server listens on all IPv4 interfaces and prints the addresses students can
use. Open `http://TEACHER_IP:18787/dashboard/` for the panel. Allow the selected
port through the teacher computer's firewall. HTTP carries passwords, sessions
and classroom traffic without encryption; use it only on a trusted network.
An explicit flag applies to that invocation. When LAN access was selected in the
first-run wizard, the managed launcher supplies the flag on subsequent launches.
Exact Host and Origin checks remain enabled for the computer's local IPs.
Download verification and release signatures are unchanged.

The student installation panel uses the running server's admitted addresses.
Opening the dashboard on `localhost` no longer puts localhost in student commands.
A single available address is selected automatically; when several networks are
available, choose the classroom address. A dashboard opened through a remote
HTTP or HTTPS address retains that address. With no reachable address, the panel
explains how to enable access instead of offering a loopback command.

After setup, change the model under Settings → Server and the teaching choices
under Settings → This class. New installations use the common connection and
model in every class. Installations with imported class-specific routes also
show the option to replace those routes. Additional classes still need their
teaching configuration saved before admitting students. API keys stay in the
private installation; do not include them in student installation commands.

Entering an OpenRouter key checks it and loads the account's available models.
The model field offers suggestions and also accepts a manually entered ID.
Selecting a catalog model fills its input/output prices, shown in USD per million
tokens; they remain editable. Unknown or manually entered models require a price
review. These estimates omit provider caching and discounts.

New model budgets have usage limits disabled; recorded usage and costs remain
available. Existing saved limits are preserved on update. To remove an old limit,
select **Unlimited usage** for the relevant purpose and save. Open sessions retain
the configuration they captured when they started.

Fresh installs and updates add `testing` only when the installation has no skill
with that name; an edited local copy is preserved.

The optional Google fields accept a desktop OAuth client ID, client secret and
school domain. Domain administration, OAuth consent and trusting the application
for minors still happen in Google Workspace. Group membership additionally needs
service-account configuration, explained in its own optional section. Administrators
can change these connections under Settings → Server → School accounts; saved
identity changes require a server restart. Class admission addresses and groups
remain under Settings → This class → Student access. These controls only
appear when the identity plugin is bundled. Model connections likewise come from
installed inference plugins; neither the wizard nor the dashboard requires OpenRouter.
If a model provider is removed, the server can still start so its administrator can
select a replacement. Saved credentials are retained, but never read for absent plugins.

Under Settings → This class, **Tutor writing gate** offers **Off**, **Block the first
attempt**, and **Block up to three attempts**. It pauses exercise-code writes/edits
without a prior structured question in the current student turn. The attempt limit
prevents an endless retry loop. Student approval is still required afterward. Setup
files, shell commands and free mode are excluded. New classes start with the first-attempt
mode; existing classes keep their previous behavior. Changes affect new sessions only.
Clients predating this feature must run `marea update` before joining a class that
enables it. Restarting the client does not reset the policy or retry history of a turn.

## Session exports and optional observability

Teachers can download conversations, events and usage from **Sessions**, filtered
by class, student and UTC dates, using names or pseudonyms. Administrators can
configure **Settings → Server → External traces**, test a synthetic connection, and
explicitly enable delivery with content. Langfuse supports self-hosted base URLs;
OTLP accepts an HTTP collector. No student-side credentials are needed.

Managed updates back up and migrate the database to schema 13. Export authorization,
content limits, retries and local/external retention are documented in
[Observability](OBSERVABILITY.md). Existing clients remain compatible; their traces
contain only the diagnostic detail they actually recorded.

## Student computers

Student computers need Git installed and available on `PATH` for project snapshots
and change tracking. The application runtime is included in the package.

Installation selects the recommended client without querying the school server.
Replace the example origin with the address supplied by the teacher, including
`http://` when the server was started with `--allow-http`. After installation,
a different server can be selected for one invocation:

```sh
marea --server http://192.168.1.20:18787
```

`--server` takes precedence over `MAREA_SERVER_URL` and the saved installation
address. Compatibility discovery uses the same selected server. It does not
change the saved address or silently downgrade an HTTPS connection.
macOS Apple Silicon or Linux x64/ARM64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.25/install.sh | sh -s -- student --server https://marea.example.edu
```

Windows x64/ARM64:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.25/install.ps1'))) -Component student -Server https://marea.example.edu
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
- `update --version 0.1.0-preview.25`: try a specific published preview.
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

For a fresh pilot install before recommendation, append `--version 0.1.0-preview.25`
to the POSIX command, or `-Version 0.1.0-preview.25` on PowerShell. With no explicit
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

If first-time browser setup is interrupted, run `marea-teacher` again. The
pending marker keeps setup separate from an active school; a failed attempt
leaves only private staging data. A complete school is promoted atomically, and
a stale marker after promotion is reconciled on restart. Uninstall also works
before setup is completed. Close the wizard process before uninstalling.

## Uninstall

Close other Marea sessions first. Run `marea uninstall` to remove the managed
student programs, launchers, saved credentials and session state, and the exact
PATH entries installed by Marea. Project directories outside the managed root
are preserved. An explicit external `MAREA_STATE_HOME` is not owned or deleted.

`marea-teacher uninstall` asks whether to also erase the center data, credentials
and backups, then requires typing `DESINSTALAR` to confirm the displayed scope.
Answer `s` to remove everything managed by Marea, or `n` (the default) to keep
the data under `~/.marea-preview/server/installation`. `--purge-data` selects
complete removal explicitly. `--yes` skips these confirmations and **preserves** center
data unless combined with `--purge-data`.
The server must be stopped; uninstall takes its exclusive installation lock before
removing files.

A forced shutdown can leave installation lock files even after reboot. Interactive
uninstall offers the same abandoned-lock recovery as server startup, before removing
any programs or data. Answer `y` only after checking that no Marea process is using
this installation; an existing recorded process is reported in the prompt. Declining,
interrupting, running without a terminal, or a lock changing while the prompt is open
leaves the installation in place. `--yes` does not authorize breaking a lock.

If only preserved server data remains, running the installer again explains the
previous uninstall and offers a fresh installation. Type `BORRAR` to permanently
erase the retained data and backups before creating a new center; any other answer
cancels without deleting anything. This is also supported for data left by earlier
previews. It does not recover the old center automatically. Keep or move the data
if you need to recover it. Unknown or partially installed directories are never
adopted or erased by this flow.

Windows runs uninstall through a temporary copy so it can remove its executable.
An installation upgraded from the version 6 launcher may ask you to run uninstall
once more after upgrading the owned launcher. Customized launchers are not
silently rewritten. Unknown files in the managed root are preserved. Linked or
otherwise unsafe shell profiles are preserved and reported for manual PATH cleanup.

## Publish a version

1. Review the change and pass `bun run release:audit` and `bun run quality`.
2. Commit the complete tested source, including the MIT license, dependency patch
   and workflows. Create and push an immutable tag such as `v0.1.0-preview.25`.
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
6. After publication, a disposable public-download test installs the server,
   uninstalls while keeping data, cancels a reinstall, explicitly starts afresh,
   checks the new teacher credentials, and uninstalls completely. It must pass
   before the separate job updates the small static availability index.
   If this metadata job fails, rerun that job; it never replaces signed assets.
7. Ask pilot users to run `update` (or install the explicit version). After classroom
   testing, recommend it separately; publication never recommends automatically.

## Recommend a tested preview

Run the **Recommend preview** workflow on `main`, choosing the published version
and `student`, `server`, or `both`. From a maintainer terminal:

```sh
gh workflow run recommend-preview.yml --ref main -f version=0.1.0-preview.25 -f component=both
```

Promotion requires a successful native publication workflow for the exact source,
downloads and verifies the complete signed publication, checks its protocol metadata,
and updates `preview.json` on the dedicated `marea-preview-channel` branch. It
preserves assets, tags and release notes. Recommendations are forward only and
idempotent; older protocols keep their previous recommendations.

The metadata-only branch is maintained by the workflows, with compare-and-swap
writes and readback to prevent lost promotions. Clients fetch its small JSON file
from GitHub's static content service, without listing release assets or sharing
the REST API quota among a classroom. Do not edit it manually. No auxiliary
software release or pull request is created for promotion.

Keep published versions available for installed clients and explicit protocol
repairs. For a bad recommendation, publish and recommend a corrected preview;
restore server backups when a database rollback is needed.

The optional **Managed installation smoke** workflow exercises Windows paths,
permissions, launchers and uninstall before allocating an immutable preview tag.
It does not publish anything or replace the full native release gates.

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
