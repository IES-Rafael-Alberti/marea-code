import type { DashboardLocale } from "../messages.js";
import { ProfileShell, type ProfileRuntime } from "./profile-shell.js";
import { workspaceMessages } from "./workspace-navigation.js";
import { ServerSettingsView } from "../modules/server-settings/view.js";
import { ExternalAccessView } from "../modules/external-access/view.js";
import { TeachingModule } from "../modules/teaching/teaching-module.js";
import type { TeachingModuleProperties } from "../modules/teaching/teaching-contracts.js";
import { SkillAuthoringModule } from "../modules/skill-authoring/skill-authoring-module.js";
import type { SkillAuthoringModuleProperties } from "../modules/skill-authoring/skill-authoring-contracts.js";
import {
  GovernanceModule,
  type GovernanceModuleProperties,
} from "../modules/governance/governance-module.js";
export function TeacherWorkspace({
  locale,
  profiles,
  teaching,
  authoring,
  governance,
}: {
  readonly locale: DashboardLocale;
  readonly profiles: ProfileRuntime;
  readonly teaching: Omit<TeachingModuleProperties, "locale"> | undefined;
  readonly authoring: Omit<SkillAuthoringModuleProperties, "locale"> | undefined;
  readonly governance: Omit<GovernanceModuleProperties, "locale"> | undefined;
}) {
  const w = workspaceMessages(locale);
  return (
    <ProfileShell
      locale={locale}
      runtime={profiles}
      classes={teaching?.state.classes ?? []}
      classBusy={teaching?.state.busy === true || authoring?.state.busy === true}
      hasClassDrafts={teaching?.state.dirty === true || authoring?.state.dirty === true}
      onClassChange={async (classId) => {
        await teaching?.controller.selectClass(classId);
        await teaching?.controller.confirmClassSwitch(true);
        await authoring?.controller.selectClass(classId);
        await authoring?.controller.confirmNavigation(true);
      }}
      settings={{
        classroom: (
          <>
            {teaching !== undefined && (
              <TeachingModule locale={locale} {...teaching} classSelection={false} />
            )}
            <ExternalAccessView
              locale={locale}
              fetchRequest={profiles.fetch}
              classId={teaching?.state.classId ?? null}
            />
            {authoring !== undefined && (
              <details className="workspace-advanced">
                <summary>{w.skills}</summary>
                <SkillAuthoringModule locale={locale} {...authoring} classSelection={false} />
              </details>
            )}
          </>
        ),
        server: (
          <ServerSettingsView
            locale={locale}
            fetchRequest={profiles.fetch}
            classNames={Object.fromEntries(
              (teaching?.state.classes ?? []).map((item) => [item.classId, item.displayName]),
            )}
          />
        ),
        ...(governance?.state.access?.administrator === true
          ? { administration: <GovernanceModule locale={locale} {...governance} /> }
          : {}),
      }}
    />
  );
}
