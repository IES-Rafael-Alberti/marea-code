import * as z from "zod";
import { expect, it } from "vitest";
import { createDashboardModuleSelectionSchema } from "@marea/protocol";
import {
  profileHarness,
  release,
  selected,
  encode,
  request,
  write,
  teacher,
} from "./profile.fixture.js";
import { createDashboardProfileService } from "./service.boundary.js";
it("never lets permission for one module grant another module access", () => {
  const h = profileHarness();
  try {
    const deniedId = "org.marea.denied-module";
    const selection = z.union([
      release.selection,
      createDashboardModuleSelectionSchema(
        deniedId,
        1,
        z.strictObject({ limit: z.number() }),
        release.modules[0].supportedPlacements,
      ),
    ]);
    const mixed = {
      ...release,
      selection,
      modules: [...release.modules, { ...release.modules[0], id: deniedId }],
    };
    const service = createDashboardProfileService({
      store: h.store,
      release: mixed,
      authority: { permits: (_identity, _scope, module) => module.id !== deniedId },
      clock: { now: () => "2026-09-22T12:00:00Z" },
      ids: { createId: () => "revision" },
      currentCatalogRevision: () => release.revision,
    });
    expect(service.execute(teacher, "catalog", encode(request("catalog")))).toMatchObject({
      modules: release.modules,
    });
    expect(() =>
      service.execute(
        teacher,
        "save",
        encode(
          write({ value: { ...release.defaults, modules: [{ ...selected, moduleId: deniedId }] } }),
        ),
      ),
    ).toThrow(expect.objectContaining({ status: 403 }));
    expect(h.read().personal.revision).toBeNull();
  } finally {
    h.database.close();
  }
});
