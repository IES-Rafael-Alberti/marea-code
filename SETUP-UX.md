# Setup and settings

The first local server launch opens a five-step web setup: school and teacher,
model connection, student access, optional educational features, and review.
Password constraints and confirmation errors appear beside their fields on blur
and on submission. Feedback has reserved space, including two lines on narrow
screens; invalid styling does not change input dimensions or alignment. Secret
visibility controls only reveal newly entered text.
A stored key is represented by its presence; its value is never returned to the
browser. Multiline private keys retain their line breaks.

Setup creates unlimited usage policies and applies catalog prices when a model
is selected. Optional attention-map and report routes initially use that same
connection and model. Enabling the attention map also saves the class setting;
automatic evaluation selects the installed session-review method before enabling
it. Missing prerequisites fail provisioning before the staged school is promoted.
The network step lists detected LAN addresses; the administrator selects and copies
the student command in Network and installation after setup.
Existing installations and their teaching instructions, limits and prices are
not rewritten by these defaults.

Settings separate the selected class, shared server, personal dashboard and
school membership administration. Class panels stay mounted during navigation,
so switching between tutor, access and features preserves edits. Class changes ask before losing an educational or admission draft as well
as teaching and authoring drafts. Explicit saves and discard actions stay next
to their status. Network failures retain drafts. Configuration changes still only
affect new student sessions where that was already the contract.
Saving reveals and focuses invalid fields even inside a different section or a
closed disclosure. Model and identity forms share successful revision advances
only when they started from the same saved version, preserving both drafts and
conflict detection for changes made elsewhere.

## Skills workspace

**Skills** is a top-level workspace with three views: **This class**, **By student**
and **Library**. Practice skills and assessment methods are separate. The searchable
selection dialog keeps items in catalog order while checkboxes change; it saves the
whole selection once. Details open beside the list. Missing catalog entries can be
removed without discarding the rest of a selection.

Students inherit their class's didactic selection until a teacher chooses a personal
selection. A personal selection replaces the class selection, including when it is
empty, and persists across sessions. **Use the class selection** removes the override.
Teachers can select up to 100 enrolled students for one atomic assignment. Assessment
methods and other tutor policies remain class-wide. Personalization is scoped to the
student and class, never inferred from a browser name or a session ID.

**Create a skill** lives in Library; **Choose skills from library** assigns existing
skills to a class, while **Customize skills** edits a student selection.
**Remove from this class** changes an assignment; **Delete from library** removes
a personal definition after reviewing its usage.

The library shows human names, descriptions, curricular references and provenance. Built-in and school skills
are read-only; **Create my version** creates a personal draft. Both details and the
editor show the complete `SKILL.md`, including YAML, criteria and all four levels.
The teacher writes Markdown directly, with a commented template and an expandable
guide based on Testing. YAML validation shares the server's frontmatter contract.
The new UI does not add or manage companion files; existing files are preserved.
A new skill can choose its `name`; saved identities remain stable, while `metadata.title`
controls the displayed title.

**Help me draft it** accepts free-form topics, goals and criteria. The server uses the
current configured class model through the installed provider, with the complete
Testing example (and the assessment example for an assessment skill). It validates
its Markdown before inserting it directly into the unsaved editor. **Undo generation**
restores the previous draft, including its original Markdown. Errors preserve the text.
Teachers review and explicitly save; generation never publishes or assigns a skill.
No student conversation is sent. Usage is recorded in the independent educational
ledger under the teacher, using the configured tutoring limits and prices. Requests
have a two-minute timeout, propagate cancellation and allow one in flight per teacher.

Owners can delete personal skills after reviewing where they are used. Deletion checks
both the skill digest and assignment revision, withdraws class and individual selections,
and disables automatic evaluation if its method is removed. Historical revisions and
started sessions remain frozen. An assignment outside the owner's current authority
blocks deletion. Dashboard selection writes and deletions share a queue, preventing
an in-flight selection from reviving a deleted skill. Source removal uses an atomic
rename into an unpublished stage; interrupted cleanup finishes on recovery. If the
filesystem rejects removal after SQL withdrawal, the source remains readable and
can be deleted again after reloading its destinations.

Drafts remain in memory in the authenticated browser tab while navigating between
classes and sections; closing or reloading with unfinished work raises the browser's
unsaved-work warning. They are not written to browser persistent storage. Discard is
explicit. Closing the detail panel or editor does not discard the draft. A concurrent
edit never overwrites a newer library revision: the teacher can save the retained
draft as another skill, or explicitly discard it and reopen the current version.

Saving an edited personal skill updates its selected references in classes the teacher
currently teaches and in their students' personal selections. The editor displays the
impact before saving. The server checks the reviewed usage revision and all current
permissions again inside a transaction. Existing runs keep their frozen skill content;
only new runs use updated assignments. If the file was saved but applying it failed,
the editor retains that saved identity and offers destination review and application
retry, without saving another copy of the file.

Schema 14 adds `marea_student_skill_assignments`, storing frozen didactic bundles and
an optimistic revision per `(class_id, student_id)`. Missing rows inherit; an empty JSON
array explicitly selects no skills. Run creation composes this selection with the
latest class policy inside its existing authorization path. Removing an account or
class cascades to its assignments. Backups include the table. Migrations 1–13 retain
their checksums. The new dashboard endpoint does not change baseline student protocol
schemas or require a matching client release.

## Curricular references

Optional `curriculo` frontmatter declares `modulos` and a `fuente` (source text or URL).
Each module supplies a quoted string `codigo`, a `nombre`, or both. Each criterion
retains its own stable `codigo` and may add `referencias`: objects with `modulo`,
positive integer `ra` (for example `3`) and string `criterio` (for example `f`).
The display formats this as `Programación · 0485 · RA3.f`. Criterion statements and
four progression levels remain teacher-authored indicators; a skill assessment is
not automatic certification of an entire official learning outcome.

The library and assignment picker search names, module codes and RA/criterion labels,
and filter by module or lack of curricular links. Module codes take precedence for
grouping. Names ignore case and repeated spaces; a name-only module maps to a code
only if the visible catalog establishes exactly one corresponding code. No external
curriculum database, source fetch or invented code is required. The generation prompt
preserves supplied references and omits them when the teacher has supplied none.

Testing now uses `testing-casos`, `testing-unitarias` and `testing-limites`, linked to
0485 RA3.f in [Royal Decree 405/2023](https://www.boe.es/buscar/doc.php?id=BOE-A-2023-13221).
The old RA5 identifiers were incorrect curricular labels. Existing frozen sessions,
evaluations and progress records are not recoded or merged with the corrected example.
Updating the release refreshes the library, not previously captured class or student
selections. To adopt the corrected Testing version for a class, open its library
detail, choose **Use in this class**, and save the selection. Individual overrides
remain explicit; reselect Testing or restore class inheritance to update them.
New frontmatter remains inside `SKILL.md`; baseline bundle/criterion wire shapes are
unchanged. Only library requests with `includeCurriculum: true` receive the optional
curriculum summary, so older strict dashboard requests retain their response shape.

## Dashboard entry and language

GET and HEAD on `/` redirect to `/dashboard/`; product `/api/` and `/v1/` routes retain
their behavior. Startup prints separately labelled dashboard URLs and student commands.
Web setup saves the selected language on the first teacher's account. On later logins,
the account preference overrides browser detection and local storage; teachers can
change it immediately in **Settings → My dashboard**. The dedicated authenticated
`/api/v1/dashboard/profiles/language` endpoint leaves strict profile documents unchanged.
The preference is namespaced account metadata in the existing SQLite database, included
in backups and removed by account retention. Database schema 14 remains unchanged.

## Identity providers

Installed plugins own their labels, optional configuration groups and HTTPS help
links. Guides can associate distinct optional fields with an explanation; the
host renders this metadata without knowing provider names. Inference providers
continue to own their model discovery and pricing metadata.

The administrator's server-settings endpoint adds `identity-read` and
`identity-save` operations. Saves use the existing shared revision and private,
atomic settings store. `identity-status` exposes only installed-provider help and
runtime admission readiness to authenticated teachers. It exposes no settings or
secrets. These are dashboard operations; the student protocol and its baseline
identity responses are unchanged.

Identity changes require a server restart. The UI distinguishes saved settings
from the running configuration and explains that saving validates fields, while
external authorization is established during a real sign-in. Optional credential
groups can be explicitly cleared without removing the school's email sign-in.

On first use, the editor imports configured installed providers from the existing
private identity files. After a web save, `identityConnections` in the private
`config/server-settings.json` is authoritative. The old files are retained but
are no longer read for runtime credentials. Settings for removed plugins are
retained privately and are not displayed or activated. Removing a plugin also
removes its help; restoring it requires the usual catalog rebuild and restart.

## Validation

The native browser setup smoke covers password errors, visibility, model discovery,
all five steps, optional feature persistence, identity draft retention and discard,
secret replacement, automatic sign-in and reload with `URL.parse`, `AbortSignal.any`,
`Map.groupBy`, `Object.groupBy` and `Promise.withResolvers` removed to exercise the
Safari 17.1 API baseline. The handoff must load Sessions, Map, Progress and Reports
with successful class data, both immediately after setup and after reloading;
the presence of navigation or working settings alone is insufficient. Module
requests, subscriptions and navigation retain cancellation on class changes and
release listeners on completion without relying on `AbortSignal.any`.
Focused tests cover secret projections, optimistic revisions,
removed plugins, explicit group credential removal and retained drafts. Release
checks use the built native dashboard and executable, not a standalone mock UI.
