# Preview installation and updates

The commands below target `0.1.0-preview.48`.

This preview fixes situations that could leave a session or a server permanently blocked. The
protocol remains 0.1 and the database schema remains 15. **Update the server first**, then
**students update the client** (`marea update`). Students who were stuck on preview 46 or 47
recover once the server and their client are updated.

Sessions that no longer block:

- One event the server refuses (for example the diagnostic of a failed tutor startup) no longer
  stops every later event: the client sets it aside in its private failure log and keeps
  delivering, and the server logs the refusal on stderr. The server now accepts that diagnostic.
- An empty model reply is retried automatically; if it stays empty the student is told to use
  `/retry`. Empty messages already stored in a session are dropped, so those sessions heal.
- Rejecting an action without typing a reason no longer breaks the next message.
- Writing a new message after a failed turn closes the failed one. A computer left with several
  pending turns (which refused to start with "the pending student turn is ambiguous") recovers
  on the next start.
- Mistakes the model can correct (an `old_string` that is not in the file, a path that does not
  exist, a write or question with invalid arguments, a file changed after review) go back to the
  model as tool errors instead of failing the turn. Duplicate tool-call ids, `content_filter` and
  `error` finish reasons, very long text chunks and messages near the size limit are handled.
- Long sessions keep their local state bounded, and a failed lease recovery no longer leaves the
  run unusable until restart. A `session.json` written by a newer Marea is refused with an
  "update Marea" message instead of being set aside.

Student computers:

- Commands with quotes and accented output work in Windows `cmd.exe`.
- A Git failure while recording project changes (a file open in another program, a slow
  repository, a huge diff) no longer fails the turn; the teacher sees that the change could not
  be recorded.
- Git's "dubious ownership" no longer offers to create a new repository; Marea explains the
  `safe.directory` command instead. Folder comparisons on Windows ignore case and short names, and
  the local state of a project no longer depends on how its path was typed.

Teacher server:

- Backups and restores stream the database to disk, so databases of any size can be backed up
  before an update or a migration. The backup first checks the free disk space and names the
  required and available space if it is not enough.
- An update that fails before changing data returns to the previous release by itself, explains
  why, and can be retried.
- An initialization lock left by a crashed server is removed when its process no longer exists,
  and a server that does not start writes the reason to stderr.
- Turn diagnostics stay out of the student's history and the evaluation input.

Preview 47, the previous published release, helped students who start Marea in the wrong folder
and added a guide for students.

- Starting Marea in a subfolder of a Git repository shows both folders. At a terminal it offers
  to leave (the default, with the `cd` command to run) or to create a new repository in the
  current folder. Without a terminal it only explains and creates nothing. When the repository
  above is the home folder, Marea says it was probably created by mistake.
- [STUDENTS.md](STUDENTS.md) explains `marea logout`, the project root, several approvals in one
  turn, the `/usage` line and what to do after an error.

Preview 46, the previous published release, fixed the failures seen in the classroom test of
preview 43: a turn no longer
breaks when the model sends several actions or a malformed tool call, and the teacher can now
see why a turn failed. The protocol remains 0.1. The new fields only travel when the server
announces the new capabilities `marea.runs.turn-diagnostics` and `marea.models.context-window`.
The database schema remains 15. **Update the server first**; its first start backs up the
database and migrates it when needed. **Students must update the client** (`marea update`)
to receive the client fixes.

Server and dashboard:

- The new server migrates the database itself when it starts, after a backup, instead of
  relying on the previous version's updater. This also works on Windows installations reached
  through short names or junctions. One `schema-migration` line on stderr records it.
- Unexpected HTTP 500 responses write one JSON line to the `marea-teacher` stderr with the
  route, `requestId` and the exception. **End session** now explains whether the server was
  offline, refused the request, or failed, and shows the `requestId` to look up.
- Each failed student turn reaches the dashboard with its category, exception, stack, client
  version and what the model returned. The session view has a **copy** button for an issue
  report, and session exports include it.

Student computers:

- A model message with several actions asks about each one in order («Acción 1 de 3»). It
  lists what follows and offers **Autorizar todas** (key `A`). Rejecting one action no longer
  cancels the others.
- A malformed tool call from the model (non-text arguments, broken JSON, a missing name or
  id) is repaired or answered as a tool error, so the turn continues. Recoverable failures
  are retried automatically up to two times before an error is shown, and the provider's
  usage is accounted for even when the response fails.
- The tutor's read tools use the standard names `read_file`, `ls`, `glob` and `grep`, with
  declared parameters. A call to a tool that does not exist lists the available tools instead
  of failing the turn.
- Long sessions are summarized before reaching the gateway's 256-message limit, and very large
  tool results are shortened with a notice to the model.
- `/usage` (or `/uso`) shows or hides a line with the session's input and output tokens and,
  when the server reports the model's context window, how much of it the latest call used.
  The counts survive a restart; the preference is saved.
- `marea logout` forgets the stored sign-in of the current server and project, so the next
  `marea` asks how to sign in. It keeps the session and does not contact the server.
- Error messages are in the student's language. The technical detail is behind `/details`,
  which also names a private local log of failed attempts.

Previews 44 and 45 were not published; their immutable tags are retained for traceability. Native
acceptance found two tests to update and a real failure: on Windows, a server whose database
needed migrating refused to start, because the pre-migration backup compared the configured
installation path with its physically resolved form. Preview 46 fixes it. Preview 43, the previous published release, made classroom sessions more resilient and let
runs end on their own. It kept protocol 0.1 and moved the database schema to 15 (new
`closed_by` column recording which teacher ended a run).

Sessions and runs:

- Student sign-ins slide with activity up to an 8-hour cap, and teacher dashboard
  sessions slide as well. Presence and lease renewal count as activity.
- The server closes runs with no connection for 60 minutes, or past the 8-hour cap,
  so automatic evaluation can start. Teachers can use **End session** or
  **End all sessions** in the dashboard; evaluation follows the class setting.
  Students see why a session ended and start a new one by running `marea` again.
- A closed or refused run can be restarted with a fresh run, and runs are recovered
  when reopened. Local state of closed runs is cleaned up and bounded to 20 MiB.
- The terminal is suspended while a re-authentication prompt is shown.

Student computers:

- Project folder names with `_`, `(` and `)`, spaces in paths and any other openable
  folder name no longer break history, writing or opening a run.
- Windows private-state checks report typed diagnostics, and damaged local state is
  quarantined instead of blocking startup. The client shows diagnostic codes you can
  report.
- Agent commands may run for up to 10 minutes, keeping the head and tail of long
  output.

Server and dashboard:

- HTTP responses slower than 10 seconds are no longer cut by the idle timeout.
- Class reports are tolerant, bounded and diagnosable, and the dashboard explains
  failed reports and refused requests. Larger session exports are supported.
- Google group membership checks run in parallel; external sign-in completions
  queue instead of being rejected at capacity.
- Hono is updated to 4.13.16.

Preview 40 and 41 were not published; their immutable tags are retained for
traceability. Preview 42 (the previous published and recommended release) fixed
installation and update downloads on slow connections: transfers stop after 30 seconds
without data, with unchanged signature, hash and size checks.

Selected didactic skills are now loaded in full before the tutor starts. Missing,
unverifiable or oversized required materials block the turn with a clear error;
resumed sessions retain their captured versions. Private evaluation materials
remain separate from the tutor context. Preview 42 retained protocol 0.1 and database schema 14.

Preview 39 updated Zod to 4.6.7 throughout the application and dependency tree,
fixing [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
Oversized constrained collections are rejected before validating their elements.
An included compatibility patch preserves existing Unicode passwords and protocol
text limits while keeping the upstream collection-size security fix.
It also updates both server Hono dependencies to 4.13.11 for
[GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7).
The protocol remains 0.1 and the database schema remains 14. Existing installations
retain their data, credentials and settings when updated.

Preview 35 validated the existing direct OTLP exporter against Langfuse 4.68.0
and added a repeatable check of the stored observations through the modern API.
No Langfuse SDK or collector migration is needed in Marea. See
[Observability](OBSERVABILITY.md) for verified fields, retry semantics and costs.
It also updated the dashboard build tool to Vite 8.2.4 to address
[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm).

Preview 34 fixed Windows installation and startup, including Windows PowerShell
5.1 on ARM64. Architecture detection uses the native processor, the bootstrap waits
for installation in the same console, and cleanup warnings preserve the installer's
result. All Marea executables explicitly run with the invoking user's privileges,
so installation and ordinary startup do not require administrator rights.
The complete bootstrap, managed launcher and uninstall are tested under a standard
Windows account on x64 and ARM64, with both PowerShell 5.1 and PowerShell 7.

Preview 33 added optional curriculum links to didactic `SKILL.md` files. Modules
can be identified by name, quoted code, or both; learning outcomes use numeric `ra`
values. Library search and module filters use these references. The bundled Testing
example corrects its former RA5 labels and links its own indicators to Programación
0485, RA3.f, with the normative source recorded in the Markdown.
If a class already uses the previous Testing revision, open Testing in Library,
choose **Use in this class**, and save the selection to use the corrected version
for new sessions. Existing sessions and individual selections retain their captured
version until the teacher changes those selections.

Generated skill drafts now appear directly in the editor with an undo action.
Creation belongs in Library; assigning and removing class skills have distinct labels.
The dashboard restores each teacher's saved language, including the choice made in
web setup. Visiting the server root opens the dashboard, and startup prints its URLs.

Managed server updates check installation ownership and offer abandoned-lock recovery
before downloading. The activation step still rechecks ownership to protect against
a server starting during the download. The updated server migrates the database to schema 15 when it
first starts, after a backup in `installation/backups/`; the migration only adds the teacher who ended a
session (`marea_runs.closed_by`); existing
sessions keep their frozen skill content, and compatible students continue to connect.

Download progress now distinguishes files received from verified files reused locally,
and reports the transferred bytes. The counter covers the whole signed inventory;
reused files are not presented as additional downloads.

Downloads are compressed,
and initial installations reuse the installer and signature verifier already
fetched by the bootstrap script. Updates reuse installed files only after their
bytes match the newly signed inventory; damaged or changed files are downloaded.
The signature verifier ships without debugging symbols, and application code is
minified. Every platform still includes its native runtime and works without a
separate Bun or Node installation.

Existing updaters remain compatible: releases also retain the original raw assets
and manifest format. Updating from preview 26 or earlier uses the old downloader
once; subsequent updates use compression and verified reuse. New installations
benefit immediately. Download sizes differ by platform and by the files changed
between releases.

This preview retains the Safari 17.1 dashboard fixes, interrupted-install recovery,
abandoned-lock recovery, stable password validation layout and restored Marea Code
heading from preview 26.

Fresh teacher installations open a browser setup wizard on their first launch.
Existing schools retain their data and settings. Earlier features remain available:
LAN HTTP, Google sign-in, provider model discovery, unlimited usage defaults,
the tutor writing gate, the example testing skill, session ZIP exports and optional
full-content observability through Langfuse or an OTLP collector.

Published installers and tags remain immutable.

## Next preview: learning notes

The next preview keeps a dated history of each student's learning notes that teachers can view,
edit and summarize from **Progress** (see [SETUP-UX.md](SETUP-UX.md#learning-notes)). Its first
start backs up the database and migrates it to schema 16, which keeps notes when their session is
deleted and dates existing notes. The protocol and the student client are unchanged.

## Teacher server

macOS Apple Silicon or Linux x64:

```sh
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.48/install.sh | sh -s -- server
```

Windows x64, in PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.48/install.ps1'))) -Component server
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
with that name; an edited local copy is preserved. Manage selections and authoring in
**Skills → This class / By student / Library**. Personal selections replace the class
selection until **Use the class selection** is chosen. Updates to a selected personal
skill apply to new sessions; existing conversations retain their frozen content. See
[Skills workspace](SETUP-UX.md#skills-workspace).

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

The updated server backs up and migrates the database to schema 15 when it first starts. Export authorization,
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
curl -fsSL https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.48/install.sh | sh -s -- student --server https://marea.example.edu
```

Windows x64/ARM64:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://github.com/IES-Rafael-Alberti/marea-code/releases/download/v0.1.0-preview.48/install.ps1'))) -Component student -Server https://marea.example.edu
```

Use **PowerShell**, identified by a prompt such as `PS C:\Users\david>`, for the
installation command. From Command Prompt (`cmd.exe`), first run
`powershell -NoProfile`. Reopen the terminal after installation to load the new
per-user PATH entry. Normal installation and startup use an ordinary, non-elevated
terminal.

Preview 34 queries the native Windows architecture through CIM, including from an
emulated shell, and waits for the installer in the same console. A temporary-file
cleanup failure produces a warning without replacing the installer's result.
The Windows executable manifests explicitly request `asInvoker`; Bun's existing
manifest settings are preserved before the files are hashed and signed.

If an existing **preview 33** installation requests elevation or opens a console
that immediately closes when running `marea`, its old launcher must be updated once.
Open PowerShell as administrator **using the same Windows account that installed
Marea** and run:

```powershell
marea update --version 0.1.0-preview.34
```

Accept the update, close that administrator terminal, and run `marea` from an
ordinary terminal. Do not reinstall over the existing root or delete its student
state. If Windows asks for credentials belonging to a different administrator
account, cancel rather than updating that account's installation.

The [student guide](STUDENTS.md) explains `marea logout`, the project root, several
approvals in one turn, the `/usage` line and what to do after an error.

Run `marea` from the project directory. The managed installation keeps student
session state under `~/.marea-preview/student/student-state`; it does not reuse
the old manual installation's `~/.marea` state. `MAREA_SERVER_URL` and
`MAREA_STATE_HOME` still allow explicit overrides.

## Updates and recovery

- `marea --version` / `marea-teacher --version`: installed preview version.
- `status` (or `--status`): managed installation details, with no credentials.
- `update` (or `--update`): check the latest **published** preview and ask to install
  it, without starting the application. Publishing alone does not notify everyone.
- `update --version 0.1.0-preview.31`: try a specific published preview.
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

For a fresh pilot install before recommendation, append `--version 0.1.0-preview.31`
to the POSIX command, or `-Version 0.1.0-preview.31` on PowerShell. With no explicit
version and no recommendation, installation stops with a useful message.

Stop the server before accepting an update. Its existing exclusive installation
lock prevents an update while a teacher host or another offline operation owns
the data. Before downloading, the managed updater offers the same abandoned-lock
recovery as server startup. Accepting an update is not consent to remove a lock:
recovery requires its own explicit confirmation in a terminal. Declining, losing
input, or detecting a changed lock stops the update before any release download.
Close a running host with Ctrl+C before retrying; do not remove its lock while it
owns the installation. Activation checks ownership again in case a process started
during the download. There is no need to start and stop the server to recover an
abandoned lock before updating.
A deletion-aware backup precedes activation, and the new server takes its own
backup before migrating the database at startup (one JSON line on stderr records the
detected schema, the final schema and the backup path). If that backup or the migration
fails, the database is left unchanged and the server does not start. The matching
dashboard and server version change together. Settings and credentials are preserved.

Before activation the server update writes
`installation/state/preview-update-pending.json`. It records the backup location,
the previous host configuration, the previous `active.json` pointer and the database
schema version at that moment. The journal is removed only when the new release is
fully selected.

The new server binary migrates the database itself at startup, so an update that
stops before the server has run cannot have changed any data. When the update fails
(for example a locked `active.json` on Windows, a failed example-skill copy or an
invalid configuration), or the process dies and the next launch finds the journal,
the launcher compares the current schema version with the recorded one. If they
match, it restores the previous `active.json` pointer and `teacher-host.json`,
removes the unpublished program directory and the journal, starts the previous
release, and prints why the update failed. Retry with `marea-teacher update`; the
failed attempt leaves nothing behind. The original error is always printed.

Manual restore is only needed when the schema version differs, meaning the new
binary already ran and may have migrated data, or when the journal is from an older
launcher that did not record the schema. In that case the launcher refuses to start
and keeps the journal and the backup: do not delete the journal or point an old
executable at a migrated database. Use the existing `marea-operations backup restore`
command with a private JSON input containing `bundlePath` and a **new**
`destinationRoot`. That operation enforces deletion authority. Inspect the restored
installation and explicitly select its matching program version before resuming.
Retained executables alone are not a database rollback.

A crash during SQLite initialization used to leave its lock file
(`.marea-init-<hash>.lock`, next to the database) behind. The lock now records its
process id and host. At the next start, if that process no longer exists on this
host, the lock is removed and one JSON line (`initialization-lock-removed`) is
written to stderr. A lock held by a live process, or by another host, is never
removed. A lock without a recorded owner, written by an older release, is removed
only when it is older than ten minutes, far longer than any initialization.

When the teacher host cannot start, it prints one operator-private JSON line to
stderr (`teacher-host-start-failed`) with the reason and the underlying error name,
code and, where it cannot quote input, message. Credentials, keys and student content
are never included.

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

## Installer recovery

First installation now prepares the verified programs, activation pointer, launchers,
preview settings and first-run marker in a private sibling scratch directory. The
launchers and settings refer to the final location. A single directory rename makes
the complete installation available before configuring PATH or reporting success.
Caught download, verification or write failures remove their scratch tree; a killed
process can leave a hidden sibling scratch directory, but it does not occupy or
block the installation path. Repeating installation starts a separate attempt.
An installation created concurrently is never overwritten. A shell-profile or
Windows PATH failure leaves the complete installation usable at its printed path.

For older previews, an interrupted download can leave a root containing only
`.download-XXXXXX` directories, without a launcher or school data. This installer
recognizes this specific case and asks to remove the downloads before retrying.
Close other installers first. Declining, encountering a linked directory, or entries
changing while confirmation is open prevents cleanup. Roots containing programs,
school data, student state or unknown entries are not treated as disposable downloads.
Uninstall also removes recognized download scratch directories within its managed
root, so an old interrupted update does not leave an otherwise uninstalled root blocked.

On published preview 25, inspect the directory before manual cleanup. If the launcher
exists, run it by its full path to distinguish a PATH issue from missing programs.
If only download scratch directories remain, removing those directories and then
the empty root allows the same installation command to run again. Do not delete
`installation/` or `student-state/` as download residue.

## Test this preview in a classroom

1. Update the teacher server (`marea-teacher update`) and start it, then update a Windows student
   PC (`marea update`) and check that `marea --version` shows `0.1.0-preview.48`.
2. A student who could not start Marea, or whose session stopped reaching the dashboard, starts
   `marea` again: confirm the session works and appears in **Sessions**.
3. Reject an action without typing a reason, then send another message: the tutor answers.
4. Ask the tutor to edit a file with text that is not in it: the turn continues and the tutor
   corrects itself.
5. Run a command with quotes and accents, for example `python -c "print('canción')"`.
6. Open the project with a file locked in another program and send a message: the turn works.

Report back: the preview and OS, which step failed, and any diagnostic code shown by the client
or the dashboard (do not send student passwords or API keys).

## Publish a version

1. Review the change and pass `bun run release:audit` and `bun run quality`.
2. Commit the complete tested source, including the MIT license, dependency patch
   and workflows. Create and push an immutable tag such as `v0.1.0-preview.48`.
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
   If its tooling needs a fix, run the corrected `publish-preview-channel.mjs`
   with the repository and existing version from `main` after the public-download
   test has passed. This repairs the availability index without rebuilding binaries.
7. Ask pilot users to run `update` (or install the explicit version). After classroom
   testing, recommend it separately; publication never recommends automatically.

## Recommend a tested preview

Run the **Recommend preview** workflow on `main`, choosing the published version
and `student`, `server`, or `both`. From a maintainer terminal:

```sh
gh workflow run recommend-preview.yml --ref main -f version=0.1.0-preview.31 -f component=both
```

Promotion requires successful native publication for the exact source,
downloads and verifies the complete signed publication, checks its protocol metadata,
and updates `preview.json` on the dedicated `marea-preview-channel` branch. It
preserves assets, tags and release notes. Recommendations are forward only and
idempotent; older protocols keep their previous recommendations.

A completed run whose only failed step in the availability job was advertising
the metadata can be recovered after its publisher and public-install test succeeded.
Failed or skipped installation tests, other failed availability steps and incomplete
runs do not qualify. The independent signature and full-asset verification still runs
before every recommendation. GitHub JSON responses have a bounded 16 MiB command
buffer to accommodate releases with both raw and compressed assets.

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

## Ending student sessions

The server closes sessions nobody is connected to (no activity for 60 minutes, or past the
8-hour sign-in cap with no live sign-in) so automatic evaluation can start, and teachers can
end one session or all listed sessions of a class from the dashboard (**Sessions** and the
attention map). Students see why their session ended and start a new one by running `marea`
again. See [Security policy](SECURITY.md#ending-student-sessions).
