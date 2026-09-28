import type { ReactElement, SubmitEvent } from "react";
import { SafeDisplayNameSchema } from "@marea/protocol";

import type {
  GovernanceControllerActions,
  GovernanceState,
} from "./governance-controller-contracts.js";
import type { GovernanceMessages } from "./governance-messages.js";

export interface GovernanceViewProperties {
  readonly m: GovernanceMessages;
  readonly state: GovernanceState;
  readonly controller: GovernanceControllerActions;
}

/** Reads one named text field from a submitted form; missing fields are empty. */
export function formText(event: SubmitEvent<HTMLFormElement>, name: string): string {
  event.preventDefault();
  const value = new FormData(event.currentTarget).get(name);
  return typeof value === "string" ? value : "";
}

export function PendingSwitch({
  m,
  confirm,
}: {
  readonly m: GovernanceMessages;
  readonly confirm: (discard: boolean) => void;
}): ReactElement {
  return (
    <div className="governance-pending" role="group" aria-label={m.pendingSwitch}>
      <p>{m.pendingSwitch}</p>
      <button
        onClick={() => {
          confirm(true);
        }}
      >
        {m.discardAndSwitch}
      </button>
      <button
        onClick={() => {
          confirm(false);
        }}
      >
        {m.stay}
      </button>
    </div>
  );
}

export function ReadbackNotice({
  m,
  name,
  accept,
}: {
  readonly m: GovernanceMessages;
  readonly name: string;
  readonly accept: () => void;
}): ReactElement {
  return (
    <p className="governance-readback">
      {m.serverVersion(name)} <button onClick={accept}>{m.acceptReadback}</button>
    </p>
  );
}

function RenameForm({
  m,
  label,
  value,
  busy,
  save,
}: {
  readonly m: GovernanceMessages;
  readonly label: string;
  readonly value: string;
  readonly busy: boolean;
  readonly save: (displayName: string) => void;
}): ReactElement {
  return (
    <form
      className="governance-rename"
      onSubmit={(event) => {
        save(formText(event, "displayName"));
      }}
    >
      <label>
        {label}
        <input key={value} name="displayName" defaultValue={value} maxLength={120} />
      </label>
      <button type="submit" disabled={busy}>
        {m.rename}
      </button>
    </form>
  );
}

/** Edits a selected row's name and presents an explicit server readback when one exists. */
export function SelectedNameEditor({
  m,
  value,
  busy,
  recoveryName,
  edit,
  rename,
  accept,
}: {
  readonly m: GovernanceMessages;
  readonly value: string;
  readonly busy: boolean;
  readonly recoveryName: string | null;
  readonly edit: (displayName: string) => void;
  readonly rename: () => void;
  readonly accept: () => void;
}): ReactElement {
  return (
    <>
      <RenameForm
        m={m}
        label={m.displayName}
        value={value}
        busy={busy}
        save={(displayName) => {
          edit(displayName);
          if (SafeDisplayNameSchema.safeParse(displayName).success) rename();
        }}
      />
      {recoveryName !== null && <ReadbackNotice m={m} name={recoveryName} accept={accept} />}
    </>
  );
}
