import type { SubmitEvent } from "react";

import type { SkillAuthoringMessages } from "./skill-authoring-messages.js";

export interface SkillAuthoringCopyFormProperties {
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly dirty: boolean;
  readonly copySource: { readonly skillId: string; readonly digest: string };
  readonly copy: (sourceSkillId: string, sourceDigest: string, slug: string) => Promise<void>;
  readonly messages: SkillAuthoringMessages;
}

function formText(event: SubmitEvent<HTMLFormElement>, name: string): string {
  const value = new FormData(event.currentTarget).get(name);
  return typeof value === "string" ? value : "";
}

export function SkillAuthoringCopyForm({
  busy,
  blocked,
  dirty,
  copySource,
  copy,
  messages: m,
}: SkillAuthoringCopyFormProperties) {
  const disabled = busy || blocked || dirty;
  return (
    <form
      className="skill-authoring-copy"
      onSubmit={(event) => {
        event.preventDefault();
        const slug = formText(event, "destinationSlug");
        if (slug.length > 0 && !disabled) void copy(copySource.skillId, copySource.digest, slug);
      }}
    >
      <fieldset disabled={disabled}>
        <legend>{m.copy}</legend>
        <p>{m.copySource(copySource.skillId)}</p>
        <p className="skill-authoring-note">{m.copyHint}</p>
        <label htmlFor="skill-authoring-copy-slug">{m.destinationSlug}</label>
        <input
          id="skill-authoring-copy-slug"
          maxLength={64}
          name="destinationSlug"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          defaultValue=""
        />
        <button disabled={disabled} type="submit">
          {disabled ? m.copyBlocked : m.copy}
        </button>
      </fieldset>
    </form>
  );
}
