import { Sha256DigestSchema } from "@marea/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

import type { InstallationCapability } from "../../governance/authority.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import { NOW } from "../operations/retention/retention.fixture.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";
import { cleanupOperationsInstallations, operationsInstallation } from "./operations.fixture.js";

afterEach(cleanupOperationsInstallations);

describe("operations application ownership", () => {
  it("requires ownership before composing and before every maintenance run", async () => {
    const f = operationsInstallation();
    const lost = new OperatorCliError("installation-lost");
    let owned = false;
    const capability: InstallationCapability = {
      kind: "exclusive-installation-owner",
      installationRoot: f.root,
      assertOwned: () => {
        if (!owned) throw lost;
        return undefined;
      },
    };
    const config = readOperationsConfig(f.root);
    expect(() => createOperationsApplication(capability, config, () => NOW)).toThrow(lost);
    owned = true;
    const application = createOperationsApplication(capability, config, () => NOW);
    expect(application.activate()).toEqual({ schemaVersion: 9 });
    const reopened = createOperationsApplication(capability, config, () => NOW);
    try {
      const artifact = await reopened.preview({
        requestId: "request:one",
        previewId: "preview:one",
        policyRevision: "policy:explicit",
        targets: [f.runNode("run:closed")],
      });
      owned = false;
      await expect(reopened.confirm(artifact)).rejects.toBe(lost);
      await expect(reopened.createBackup("backup-a")).rejects.toBe(lost);
    } finally {
      reopened.close();
      application.close();
    }
  });

  it("continues recovery under a clock that advances between readings", async () => {
    const f = operationsInstallation();
    const capability: InstallationCapability = {
      kind: "exclusive-installation-owner",
      installationRoot: f.root,
      assertOwned: () => undefined,
    };
    const config = readOperationsConfig(f.root);
    createOperationsApplication(capability, config, () => NOW).activate();
    let tick = 0;
    const application = createOperationsApplication(capability, config, () =>
      new Date(Date.parse(NOW) + tick++).toISOString(),
    );
    try {
      expect(
        await application.continueExact({
          operationId: "preview:unknown",
          expectedIndexGeneration: 0,
          artifactDigest: Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`),
        }),
      ).toMatchObject({ state: "blocked", reasonCode: "evidence-mismatch" });
    } finally {
      application.close();
    }
  });
});
