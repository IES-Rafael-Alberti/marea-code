import type { ClassSessionItem } from "@marea/protocol";
import type { ReactElement } from "react";

import type { sessionsMessages } from "./sessions-messages.js";

/** Tells the teacher when a student's client runs another software version than this server. */
export function VersionMismatch({
  messages,
  run,
}: {
  readonly messages: ReturnType<typeof sessionsMessages>;
  readonly run: Pick<ClassSessionItem, "versionMismatch"> | null | undefined;
}): ReactElement | null {
  if (run?.versionMismatch === undefined) return null;
  const { clientVersion, serverVersion } = run.versionMismatch;
  return (
    <small className="session-version">
      {messages.clientVersionDiffers
        .replace("{client}", () =>
          // Every student binary up to preview 49 announced this constant instead of its release.
          clientVersion === "0.2.0" ? messages.legacyClientVersion : clientVersion,
        )
        .replace("{server}", () => serverVersion)}
    </small>
  );
}
