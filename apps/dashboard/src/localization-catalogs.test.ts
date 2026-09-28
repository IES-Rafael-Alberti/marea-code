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

describe("dashboard localization catalogs", () => {
  it.each(["es", "en", "eu"] as const)("publishes every module catalog in %s", (locale) => {
    const session = sessionMessages(locale);
    const sessions = sessionsMessages(locale);
    const teaching = teachingMessages(locale);
    const authoring = skillAuthoringMessages(locale);
    const evaluation = evaluationMessages(locale);
    const governance = governanceMessages(locale);
    expect({
      session,
      sessions,
      teaching,
      authoring,
      evaluation,
      governance,
      usage: usageMessages(locale),
      health: healthMessages(locale),
      profile: profileMessages(locale),
      reviewedEvidence: reviewedEvidenceMessages(locale),
      interpolated: {
        signedInAs: session.signedInAs("Ada"),
        savedVersion: teaching.savedVersion("v1"),
        switchPrompt: teaching.switchPrompt("Physics"),
        exportSaved: authoring.exportSaved("out"),
        exportDraft: authoring.exportDraft("out"),
        copySource: authoring.copySource("skill:one"),
        pendingPrompt: authoring.pendingPrompt("Physics"),
        serverVersion: governance.serverVersion("v1"),
        selection: governance.selection(1, 2),
        expiresAt: governance.expiresAt("2026-09-21T12:00:00Z"),
        revokedAt: governance.revokedAt("2026-09-21T11:00:00Z"),
      },
    }).toMatchSnapshot();
  });
});
