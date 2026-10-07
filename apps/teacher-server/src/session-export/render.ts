import type { CanonicalRunEvent } from "@marea/protocol";
import type { ExportSession } from "./contracts.js";

/** Indentation prevents student Markdown/HTML from introducing document structure. */
function block(text: string) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
function eventText(event: CanonicalRunEvent): string {
  switch (event.eventType) {
    case "student-message":
    case "assistant-message":
    case "assistant-progress":
      return event.content;
    case "tool-started":
      return `${event.name}\n${event.target}\n${event.arguments}`;
    case "tool-finished":
      return `${event.failed ? "FAILED" : "COMPLETED"}\n${event.result}`;
    default:
      return JSON.stringify(event, null, 2);
  }
}
export function sessionMarkdown(session: ExportSession): string {
  return (
    `# Marea session\n\n${block(`${session.studentName}\n${session.className}\n${session.projectName}`)}\n\n` +
    `Opened: ${session.openedAt}\n\nClosed: ${session.closedAt ?? "still open"}\n\n` +
    session.events
      .map(
        (event) =>
          `## ${String(event.sequence)}. ${event.eventType} · ${event.occurredAt}\n\n${block(eventText(event))}\n` +
          ("truncated" in event && event.truncated
            ? "\n[Content was truncated at capture.]\n"
            : ""),
      )
      .join("\n")
  );
}
export function csvRow(values: readonly (string | number | null)[]): string {
  return values
    .map((value) => {
      if (value === null) return "";
      const raw = String(value);
      const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    })
    .join(",");
}
export function sessionSummary(session: ExportSession): string {
  const settled = session.usage.filter((item) => item.inputTokens !== null);
  const unknown = session.usage.length - settled.length;
  const tokens = (key: "inputTokens" | "outputTokens") =>
    settled.length === 0 ? null : settled.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const costs = new Map<string, number>();
  for (const item of session.usage) {
    if (item.costUnits !== null)
      costs.set(item.costUnit, (costs.get(item.costUnit) ?? 0) + item.costUnits);
  }
  return csvRow([
    session.runId,
    session.className,
    session.studentName,
    session.projectName,
    session.openedAt,
    session.closedAt,
    session.closedAt === null ? null : Date.parse(session.closedAt) - Date.parse(session.openedAt),
    session.events.length,
    session.usage.length,
    unknown,
    tokens("inputTokens"),
    tokens("outputTokens"),
    costs.size === 0 ? null : JSON.stringify(Object.fromEntries(costs)),
    session.events.filter((e) => e.eventType === "turn-failed").length,
    session.events.some((e) => e.eventType === "model-diagnostic") ? "available" : "not captured",
  ]);
}
