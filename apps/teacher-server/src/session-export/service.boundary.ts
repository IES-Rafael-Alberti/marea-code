import { SessionExportQuerySchema } from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { sessionZip } from "../platform/session-export/zip.js";
import {
  SessionExportError,
  type ExportSession,
  type SessionExportRepository,
} from "./contracts.js";
import { sessionMarkdown, sessionSummary } from "./render.js";

function decodeQuery(input: Uint8Array) {
  try {
    return SessionExportQuerySchema.parse(JSON.parse(new TextDecoder().decode(input)));
  } catch {
    throw new SessionExportError(400);
  }
}

function pseudonyms(sessions: readonly ExportSession[]): readonly ExportSession[] {
  const users = new Map<string, string>();
  const classes = new Map<string, string>();
  const alias = (map: Map<string, string>, key: string, prefix: string) => {
    const value = map.get(key) ?? `${prefix}-${String(map.size + 1)}`;
    map.set(key, value);
    return value;
  };
  return sessions.map((s, index) => {
    const studentId = alias(users, s.studentId, "student");
    const classId = alias(classes, s.classId, "class");
    return {
      ...s,
      runId: `session-${String(index + 1)}`,
      studentId,
      studentName: studentId,
      classId,
      className: classId,
      projectName: `project-${String(index + 1)}`,
    };
  });
}
const README = `Marea session export, format 1\n\nTimes use UTC. Date filters select session opening time; the end is exclusive.\nActive sessions are a consistent snapshot at download time, not a live feed.\n\nconversations/: readable Markdown; events.jsonl: stored events and session headers;\nusage.jsonl: model attempts, recorded times and policy cost units; sessions.csv: summary.\nMissing usage is null/blank, not zero. Totals include only settled attempts and may be partial.\nCost units are estimates under the session policy, not a provider invoice.\nTruncated content remains marked; old clients may not have captured model or tool details.\n\nPseudonyms replace identity fields in the export. Free text, code, paths and conversation\ncontent can still identify people: this is NOT an anonymous dataset. Review before sharing.\nNo server configuration, credentials or session authentication tokens are included.\n`;
export class SessionExportService {
  constructor(readonly repository: SessionExportRepository) {}
  students(identity: AuthenticatedIdentity) {
    return this.repository.students(identity);
  }
  download(identity: AuthenticatedIdentity, input: Uint8Array): Uint8Array<ArrayBuffer> {
    const query = decodeQuery(input);
    const data = this.repository.read(identity, query);
    const sessions = query.identities === "pseudonyms" ? pseudonyms(data) : data;
    const events = sessions
      .flatMap((session) => [
        JSON.stringify({ type: "session", ...session, events: undefined, usage: undefined }),
        ...session.events.map((event) =>
          JSON.stringify({ type: "event", runId: session.runId, event }),
        ),
      ])
      .join("\n");
    const usage = sessions
      .flatMap((session) =>
        session.usage.map((attempt) => JSON.stringify({ runId: session.runId, ...attempt })),
      )
      .join("\n");
    const csv =
      "session,class,student,project,opened_at,closed_at,duration_ms,events,model_attempts,unknown_attempts,known_input_tokens,known_output_tokens,known_cost_by_unit,turn_errors,model_diagnostics\r\n" +
      sessions.map(sessionSummary).join("\r\n");
    return sessionZip([
      { name: "README.txt", content: README },
      { name: "sessions.csv", content: csv },
      { name: "events.jsonl", content: events },
      { name: "usage.jsonl", content: usage },
      ...sessions.map((session, index) => ({
        name: `conversations/session-${String(index + 1)}.md`,
        content: sessionMarkdown(session),
      })),
    ]);
  }
}
