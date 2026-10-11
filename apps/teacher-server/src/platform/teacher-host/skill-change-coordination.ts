import type { ProductTeachingConfigurationService } from "../../teaching/configuration/dashboard-contracts.js";
import type { SkillWorkspaceService } from "../../teaching/skills/workspace-service.boundary.js";

/** Keep a concurrent selection from publishing a captured skill after its deletion. Model
 * generation does not hold this queue; the teacher explicitly saves its result afterwards. */
export function coordinateSkillChanges(
  teaching: ProductTeachingConfigurationService,
  workspace: Pick<SkillWorkspaceService, "execute"> | undefined,
) {
  if (workspace === undefined) return { teachingConfiguration: teaching };
  let pending = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  return {
    teachingConfiguration: {
      classes: teaching.classes.bind(teaching),
      read: teaching.read.bind(teaching),
      catalog: teaching.catalog.bind(teaching),
      save: (...args: Parameters<ProductTeachingConfigurationService["save"]>) =>
        serial(() => teaching.save(...args)),
    },
    skillWorkspace: {
      execute: (...args: Parameters<SkillWorkspaceService["execute"]>) =>
        args[1].kind === "generate"
          ? workspace.execute(...args)
          : serial(() => workspace.execute(...args)),
    },
  };
}
