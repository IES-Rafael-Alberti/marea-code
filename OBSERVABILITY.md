# Session exports and observability

Marea stores canonical session events and model usage in its local SQLite database.
External observability is optional, disabled by default, and configured only by a
server administrator. Students do not need exporter credentials or a direct
connection to the collector.

## Download sessions

In **Sessions**, expand **Export sessions**. Select a class, optionally a student,
and UTC opening-date bounds. The end date is exclusive. You can also download the
selected session from its detail view. Active sessions are a consistent snapshot
at download time.

The ZIP contains:

- `conversations/session-N.md`: readable messages, tools and other recorded events.
- `events.jsonl`: session headers followed by canonical events, with full stored content.
- `usage.jsonl`: model attempts, states, timestamps, token counts and policy cost units.
- `sessions.csv`: duration, event and attempt counts, known token/cost totals, errors
  and whether model diagnostics were captured.
- `README.txt`: format and interpretation notes.

Teacher access is checked against current class membership for every download.
Selection is bounded to 100 sessions, 20,000 events, 20,000 usage attempts and
32 MiB of stored event content. Reduce the filters when the selection is too large.
The student selector refuses more than 2,000 student/class pairs rather than
silently omitting entries.

Choose **Names** or **Pseudonyms**. Pseudonyms replace session header identities,
class and project labels consistently within the download. They do not scrub free
text, code, paths or event contents. Such exports are not anonymous datasets.
CSV cells are escaped against spreadsheet formula interpretation; Markdown event
content is indented rather than interpreted as document structure.

Missing usage is blank/null, never invented as zero. Totals can be partial; costs
are estimates in the session policy's units, not invoices. Capture truncation is
preserved. Older clients may have recorded less diagnostic detail. No export can
reconstruct content that was never captured.

## Configure an external destination

1. Update the server. Managed preview updates back up and migrate SQLite to schema 13.
   Manual installations must use the offline installation upgrade procedure.
2. As an administrator, open **Settings → Server → Observability**.
3. Select an installed exporter and complete its fields.
4. Use **Test connection**. This sends a small synthetic trace without student data
   and does not activate session delivery.
5. Select **Enable delivery with content** and save.

Langfuse requires its base URL, project public key and project secret key. A
self-hosted URL is supported; Marea appends `/api/public/otel/v1/traces` to that base.
Generic OTLP accepts an HTTP collector endpoint and optional Authorization value.
The supplied exporters use OTLP HTTP JSON, not gRPC.

Only new completed/failed turns are queued after activation; existing history is
not backfilled. There is no content-level selector: enabling this feature sends
recorded conversation, model diagnostics, tool inputs/results, questions and
approvals. Known configured secrets and common credential patterns are masked,
but arbitrary personal information inside the content is retained.

Configuration uses the installation's private, owner-only server settings file.
Secret values are never returned to the dashboard; leaving a saved secret blank
preserves it. Settings use optimistic revision checks to reject concurrent edits.
Only an administrator can read, change, test or retry observability delivery.

## Trace meaning

A trace represents one tutoring turn. It groups model requests and their recorded
attempts, tools, approval waits, questions and failures. Stable hashed identifiers
link the trace to its session, student and class without transmitting display names
as identifiers. Content can still identify students.

The server derives traces from committed canonical events. Model usage is attached
to attempts once, rather than duplicated on the model request group. Unknown values
remain absent. Retry inputs/outputs and timing are limited to what the usage ledger
and client diagnostics actually recorded. Missing child completion times remain
absent, and detected clock skew is marked. This is not an exact reconstruction of
unrecorded provider internals or a new student-side tracing dependency.

Langfuse receives native observation types, input/output, model, usage, session and
parent links. Marea uses the v4 ingestion header; delivery and read-back were also
verified against a self-hosted Langfuse 3.206.0 server. Generic OTLP receives the
same structure through standard spans and `gen_ai`/Marea attributes.

## Delivery, failures and deletion

The server owns a SQLite queue of references to session events, not a second copy
of their content. A background worker sends sequential batches of at most eight
turns, with a ten-second deadline per request. The queue survives restarts and
retries with stable trace/span IDs. Delivery is at least once; the destination
must support idempotent identifiers to avoid duplicate observations after an
ambiguous acknowledgement.

The queue holds at most 1,000 turns. Excess turns increment the displayed dropped
counter. Failed attempts back off, up to five minutes; after eight failures they
remain available for **Retry failed deliveries**. Oversized traces fail without
repeated automatic attempts. A turn is bounded to 1,000 events, 128 KiB of stored
content and 1,000 attempts before rendering; exporter requests are capped at
256 KiB. These failures affect delivery status, not student session requests.

Use **Refresh status** to see pending, failed, sent and dropped counts and the last
successful delivery. Disabling delivery or changing its destination discards pending
references and starts a new capture boundary. Rotating only secret keys preserves
the queue. Disabling does not delete previously delivered data.

Removing the exporter from a build pauses delivery while preserving private
configuration. Its missing entry can still be disabled in the dashboard. As with
other plugins, source deletion requires regenerating the catalog and rebuilding;
it cannot remove code embedded in an already compiled release.

The normal offline session-retention operation removes queue/progress rows with
the session. It cannot retract content already delivered to a collector. Configure
and apply retention/deletion separately in Langfuse or the OTLP destination.

## Developer acceptance

The trace extension belongs to `@marea/plugin-api`. Installed telemetry exporters
provide descriptors and a pure `create(values)` function. The host owns authorization,
private settings, deadlines, retries and queue state; it does not hard-code a vendor's
form or credentials. Existing operational metrics keep their restricted payload path.

Run the synthetic Langfuse acceptance explicitly with an ignored environment file:

```sh
bun --env-file=docs/.env apps/teacher-server/smoke/observability-langfuse.mjs
```

The file supplies `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`), `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY`. The smoke uses an isolated database and synthetic messages,
and writes a private receipt to `/tmp/marea-langfuse-acceptance.json` by default
(`MAREA_ACCEPTANCE_RECEIPT` overrides it). It never reads the school's installation.

After ingestion, read the trace with the Langfuse CLI and compare session ID,
parent links, content and usage against the receipt. Set `LANGFUSE_HOST` explicitly
to the configured base URL. On a v3 server, use an available v3 CLI API snapshot
(e.g. `--api-version 3.200.0`); v4-only read endpoints are not a valid acceptance test
for an older self-hosted server. Keep credentials out of command arguments and logs.

For the dashboard journey, build `apps/dashboard` and compile
`apps/teacher-server/smoke/dashboard-host.ts`. Run
`node apps/dashboard/browser/observability.mjs` with `MAREA_PROFILE_HOST` pointing
to that executable, `PLAYWRIGHT_PACKAGE` to an installed Playwright `package.json`,
and `CHROMIUM_EXECUTABLE` to its Chromium binary. The test starts a synthetic host
on port 5196 and a local OTLP collector, configures and reloads private settings,
checks delivery of a synthetic connection test, and downloads a class-scoped ZIP
with pseudonyms. It records screenshots and the ZIP in a temporary artifact folder.
