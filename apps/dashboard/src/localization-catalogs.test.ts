import { insightsMessages } from "./modules/educational-insights/messages.js";
import { describe, expect, it } from "vitest";

import { governanceMessages } from "./modules/governance/governance-messages.js";
import { evaluationMessages } from "./modules/evaluation/evaluation-messages.js";
import { sessionMessages } from "./modules/session/session-messages.js";
import { sessionsMessages } from "./modules/sessions/sessions-messages.js";
import { skillAuthoringMessages } from "./modules/skill-authoring/skill-authoring-messages.js";
import { teachingMessages } from "./modules/teaching/teaching-messages.js";
import { usageMessages } from "./modules/usage/usage-messages.js";
import { healthMessages } from "./modules/health/health-messages.js";
import { reviewedEvidenceMessages } from "./modules/reviewed-evidence/messages.js";
import { profileMessages } from "./profiles/profile-messages.js";

const catalogs = {
  insights: insightsMessages,
  session: (locale: Parameters<typeof sessionMessages>[0]) => {
    const messages = sessionMessages(locale);
    return { ...messages, interpolated: { signedInAs: messages.signedInAs("Ada") } };
  },
  sessions: sessionsMessages,
  teaching: (locale: Parameters<typeof teachingMessages>[0]) => {
    const messages = teachingMessages(locale);
    return {
      ...messages,
      interpolated: {
        savedVersion: messages.savedVersion("v1"),
        switchPrompt: messages.switchPrompt("Physics"),
      },
    };
  },
  authoring: (locale: Parameters<typeof skillAuthoringMessages>[0]) => {
    const messages = skillAuthoringMessages(locale);
    return {
      ...messages,
      interpolated: {
        exportSaved: messages.exportSaved("out"),
        exportDraft: messages.exportDraft("out"),
        copySource: messages.copySource("skill:one"),
        pendingPrompt: messages.pendingPrompt("Physics"),
      },
    };
  },
  evaluation: evaluationMessages,
  governance: (locale: Parameters<typeof governanceMessages>[0]) => {
    const messages = governanceMessages(locale);
    return {
      ...messages,
      interpolated: {
        serverVersion: messages.serverVersion("v1"),
        selection: messages.selection(1, 2),
        expiresAt: messages.expiresAt("2026-09-21T12:00:00Z"),
        revokedAt: messages.revokedAt("2026-09-21T11:00:00Z"),
      },
    };
  },
  usage: usageMessages,
  health: healthMessages,
  profile: profileMessages,
  "reviewed-evidence": reviewedEvidenceMessages,
};

describe.each(Object.entries(catalogs))("%s localization catalog", (name, messages) => {
  it.each(["es", "en", "eu"] as const)("publishes the %s catalog", async (locale) => {
    await expect(messages(locale)).toMatchFileSnapshot(
      `./__snapshots__/localization/${name}/${locale}.snap`,
    );
  });
});
