import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GovernanceState } from "./governance-controller-contracts.js";
import { GovernanceController } from "./governance-controller.js";
import { parseClassExchangeText } from "./governance-exchange-text.boundary.js";
import { governanceMessages } from "./governance-messages.js";
import { GovernanceModule } from "./governance-module.js";
import {
  CLASS_A,
  USER_A,
  controllerClient,
  exchange,
  openTwoClassCenter,
} from "./governance-controller-test-support.fixture.js";

function markup(state: GovernanceState): string {
  const controller = new GovernanceController(controllerClient(), () => undefined);
  return renderToStaticMarkup(
    <GovernanceModule locale="en" state={state} controller={controller} />,
  );
}

function strings(value: object): readonly string[] {
  return Object.values(value).flatMap((entry: string | object | ((...args: never[]) => string)) =>
    typeof entry === "string" ? [entry] : typeof entry === "function" ? [] : strings(entry),
  );
}

async function openedClass(): Promise<GovernanceState> {
  const { controller } = await openTwoClassCenter();
  await controller.selectClass(CLASS_A);
  return controller.state;
}

async function previewedClass(): Promise<GovernanceState> {
  const { controller } = await openTwoClassCenter();
  await controller.selectClass(CLASS_A);
  controller.setImportPackage(exchange);
  await controller.previewClassImport();
  return controller.state;
}

describe("governance administration view states", () => {
  it("has non-empty copy for every message in both locales", () => {
    for (const locale of ["en", "es"] as const) {
      const m = governanceMessages(locale);
      expect(strings(m).every((text) => text.length > 0)).toBe(true);
      expect(strings(m.problems)).toHaveLength(7);
      expect(m.serverVersion("Row")).toContain("Row");
      expect(m.revokedAt("time:x")).toContain("time:x");
      expect(m.expiresAt("time:y")).toContain("time:y");
      expect(m.selection(2, 3)).toMatch(/2.*3/u);
    }
  });

  it("parses only valid package text", () => {
    expect(parseClassExchangeText(JSON.stringify(exchange))).toEqual(exchange);
    expect(parseClassExchangeText("{")).toBeNull();
    expect(parseClassExchangeText("{}")).toBeNull();
  });

  it("starts with no retained creates and ignores package text without a class", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, () => undefined);
    expect(controller.state.pendingClassCreates).toEqual([]);
    expect(controller.state.pendingAccountCreates).toEqual([]);
    const { controller: opened } = await openTwoClassCenter();
    opened.stageImportText("{");
    expect(opened.state.problem).toBeNull();
  });

  it("omits empty sections, unselected rows and absent results", async () => {
    const state = await openedClass();
    const html = markup(state);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Unconfirmed creations");
    expect(html).not.toContain("Exported package");
    expect(html).not.toContain("governance-staged");
    expect(html).not.toContain("governance-preview");
    expect(html.match(/Save name/gu)).toHaveLength(1);
    expect(html).not.toContain("Sessions ended");
    expect(markup({ ...state, accountId: USER_A })).not.toContain("Sessions ended");
    const noClass = markup({ ...state, classId: null });
    expect(noClass).not.toContain("Save name");
  });

  it("shows account state labels, revocation time and preview warnings only when they apply", async () => {
    const state = await openedClass();
    const withAccount = {
      ...state,
      accountId: USER_A,
      accounts: state.accounts.map((row) => ({ ...row, state: "pending" as const })),
      lastRevocation: { userId: USER_A, version: "version:r", revokedAt: "2099-01-01T00:00:00Z" },
    };
    expect(markup(withAccount)).toContain("Pending credential");
    expect(markup(withAccount)).toContain("Sessions ended at 2099-01-01T00:00:00Z");
    const staged = { ...(await previewedClass()), importPreviewReviewedId: null };
    const reviewed = markup({ ...staged, importPreviewReviewedId: "preview:a" });
    expect(reviewed).not.toContain("expired");
    expect(reviewed).not.toContain("Preview again in this session");
    const expired = markup({
      ...staged,
      importPreviewReviewedId: "preview:a",
      importPreviewExpired: true,
    });
    expect(expired).toContain("This preview expired");
    expect(markup(staged)).toContain("Preview again in this session");
    for (const problem of ["load", "invalid", "forbidden", "skill-unavailable"] as const)
      expect(markup({ ...state, problem })).toContain(governanceMessages("en").problems[problem]);
    const spanish = renderToStaticMarkup(
      <GovernanceModule
        locale="es"
        state={{
          ...withAccount,
          problem: "skill-unavailable",
          importPackage: staged.importPackage,
          importPreview: staged.importPreview,
          importPreviewExpired: true,
        }}
        controller={new GovernanceController(controllerClient(), () => undefined)}
      />,
    );
    for (const text of [
      "Credencial pendiente",
      "Esta vista previa ha caducado",
      "Vuelve a previsualizar en esta sesión",
      "Una habilidad seleccionada",
    ])
      expect(spanish).toContain(text);
    for (const problem of ["load", "invalid", "forbidden"] as const)
      expect(
        renderToStaticMarkup(
          <GovernanceModule
            locale="es"
            state={{ ...state, problem }}
            controller={new GovernanceController(controllerClient(), () => undefined)}
          />,
        ),
      ).toContain(governanceMessages("es").problems[problem]);
  });
});
