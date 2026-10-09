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
so switching between tutor, access, features and the skill library preserves
edits. Class changes ask before losing an educational or admission draft as well
as teaching and authoring drafts. Explicit saves and discard actions stay next
to their status. Network failures retain drafts. Configuration changes still only
affect new student sessions where that was already the contract.
Saving reveals and focuses invalid fields even inside a different section or a
closed disclosure. Model and identity forms share successful revision advances
only when they started from the same saved version, preserving both drafts and
conflict detection for changes made elsewhere.

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
secret replacement, automatic sign-in and reload with
`URL.parse` removed. Focused tests cover secret projections, optimistic revisions,
removed plugins, explicit group credential removal and retained drafts. Release
checks use the built native dashboard and executable, not a standalone mock UI.
