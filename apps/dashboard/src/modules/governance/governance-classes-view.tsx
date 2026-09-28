import type { ReactElement } from "react";

import { GovernanceExchangeView } from "./governance-exchange-view.js";
import {
  PendingSwitch,
  ReadbackNotice,
  SelectedNameEditor,
  formText,
  type GovernanceViewProperties,
} from "./governance-view-parts.js";

export function GovernanceClassesView({
  m,
  state,
  controller,
}: GovernanceViewProperties): ReactElement {
  const selected = state.classes.find((row) => row.classId === state.classId);
  return (
    <section className="governance-classes" aria-label={m.classes}>
      <h3>{m.classes}</h3>
      <ul className="governance-list">
        {state.classes.map((row) => (
          <li key={row.classId}>
            <span>{row.displayName}</span>
            {!row.operatorReady && <small>{m.problems.unconfigured}</small>}
            <button
              aria-current={row.classId === state.classId ? "true" : undefined}
              onClick={() => {
                void controller.selectClass(row.classId);
              }}
            >
              {m.select}
            </button>
          </li>
        ))}
      </ul>
      {state.pendingClassId !== null && (
        <PendingSwitch
          m={m}
          confirm={(discard) => {
            void controller.confirmClassSwitch(discard);
          }}
        />
      )}
      <form
        className="governance-create"
        onSubmit={(event) => {
          void controller.createClass(formText(event, "classId"), formText(event, "displayName"));
        }}
      >
        <label>
          {m.classId}
          <input name="classId" maxLength={128} />
        </label>
        <label>
          {m.displayName}
          <input name="displayName" maxLength={120} />
        </label>
        <button type="submit" disabled={state.busy}>
          {m.create}
        </button>
      </form>
      {state.pendingClassCreates.length > 0 && (
        <div className="governance-pending-creates">
          <h4>{m.pendingCreates}</h4>
          <ul>
            {state.pendingClassCreates.map((draft) => (
              <li key={draft.classId}>
                <span>
                  {draft.classId} · {draft.displayName}
                </span>
                <button
                  onClick={() => {
                    controller.resumeClassCreateDraft(draft.centerId, draft.classId);
                  }}
                >
                  {m.resume}
                </button>
                <button
                  disabled={state.busy}
                  onClick={() => {
                    void controller.createClass(draft.classId, draft.displayName);
                  }}
                >
                  {m.retry}
                </button>
                <button
                  onClick={() => {
                    controller.dismissClassCreateDraft(draft.centerId, draft.classId);
                  }}
                >
                  {m.dismiss}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.classCreateRecovery !== null && (
        <ReadbackNotice
          m={m}
          name={state.classCreateRecovery.displayName}
          accept={() => {
            controller.acceptReadback();
          }}
        />
      )}
      {selected !== undefined && (
        <div className="governance-selected">
          <SelectedNameEditor
            m={m}
            value={state.classDraft?.displayName ?? selected.displayName}
            busy={state.busy}
            recoveryName={state.classRecovery?.displayName ?? null}
            edit={(displayName) => {
              controller.editClass(displayName);
            }}
            rename={() => {
              void controller.renameClass();
            }}
            accept={() => {
              controller.acceptReadback();
            }}
          />
          <GovernanceMembershipsView m={m} state={state} controller={controller} />
          <GovernanceExchangeView m={m} state={state} controller={controller} />
        </div>
      )}
    </section>
  );
}

function GovernanceMembershipsView({
  m,
  state,
  controller,
}: GovernanceViewProperties): ReactElement | null {
  if (!state.membershipsLoaded) return null;
  const nameOf = (userId: string) =>
    state.accounts.find((row) => row.userId === userId)?.displayName ?? userId;
  return (
    <section className="governance-memberships" aria-label={m.memberships}>
      <h4>{m.memberships}</h4>
      <ul className="governance-list">
        {state.memberships.map((row) => (
          <li key={row.userId}>
            <span>
              {nameOf(row.userId)} · {m.roles[row.role]} · {m.membershipStates[row.state]}
            </span>
            <button
              disabled={state.busy}
              onClick={() => {
                void controller.changeMembership(
                  row.userId,
                  row.state === "active" ? "revoked" : "active",
                );
              }}
            >
              {row.state === "active" ? m.revoke : m.activate}
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          void controller.changeMembership(formText(event, "userId"), "active");
        }}
      >
        <label>
          {m.member}
          <select name="userId">
            {state.accounts.map((row) => (
              <option key={row.userId} value={row.userId}>
                {row.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={state.busy}>
          {m.activate}
        </button>
      </form>
    </section>
  );
}
