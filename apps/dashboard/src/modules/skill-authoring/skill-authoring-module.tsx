import "./skill-authoring.css";

import type { SkillAuthoringModuleProperties } from "./skill-authoring-contracts.js";
import {
  createBrowserSkillAuthoringFileExchange,
  type SkillAuthoringFileExchange,
} from "./skill-authoring-files.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import { SkillAuthoringView } from "./skill-authoring-view.js";

const defaultSkillAuthoringFiles = createBrowserSkillAuthoringFileExchange();

export interface SkillAuthoringModuleViewProperties extends SkillAuthoringModuleProperties {
  /** Tests and hosts may inject browser file operations; no operation occurs during render. */
  readonly files?: SkillAuthoringFileExchange;
  /** Hosts using an injected adapter retain the same guarded lifecycle by default. */
  readonly liveFileOperations?: boolean;
}

function defaultSkillAuthoringLiveFileOperations(): boolean {
  return true;
}

export const DEFAULT_SKILL_AUTHORING_LIVE_FILE_OPERATIONS =
  defaultSkillAuthoringLiveFileOperations();

export function SkillAuthoringModule({
  locale,
  state,
  controller,
  files,
  liveFileOperations = defaultSkillAuthoringLiveFileOperations(),
}: SkillAuthoringModuleViewProperties) {
  const messages = skillAuthoringMessages(locale);
  return (
    <section
      className="dashboard-module skill-authoring-module"
      aria-labelledby="skill-authoring-heading"
      aria-busy={state.busy}
    >
      <h2 id="skill-authoring-heading">{messages.heading}</h2>
      {state.busy && <p role="status">{messages.busy}</p>}
      <SkillAuthoringView
        controller={controller}
        files={files ?? defaultSkillAuthoringFiles}
        liveFileOperations={liveFileOperations}
        messages={messages}
        state={state}
      />
    </section>
  );
}
