import type { ReactElement } from "react";

import {
  PendingSwitch,
  ReadbackNotice,
  SelectedNameEditor,
  formText,
  type GovernanceViewProperties,
} from "./governance-view-parts.js";

export function GovernanceAccountsView({
  m,
  state,
  controller,
}: GovernanceViewProperties): ReactElement {
  const selected = state.accounts.find((row) => row.userId === state.accountId);
  return (
    <section className="governance-accounts" aria-label={m.accounts}>
      <h3>{m.accounts}</h3>
      <ul className="governance-list">
        {state.accounts.map((row) => (
          <li key={row.userId}>
            <span>
              {row.displayName} · {m.roles[row.role]} · {m.states[row.state]}
            </span>
            <button
              aria-current={row.userId === state.accountId ? "true" : undefined}
              onClick={() => {
                controller.selectAccount(row.userId);
              }}
            >
              {m.select}
            </button>
          </li>
        ))}
      </ul>
      {state.pendingAccountId !== null && (
        <PendingSwitch
          m={m}
          confirm={(discard) => {
            controller.confirmAccountSwitch(discard);
          }}
        />
      )}
      <form
        className="governance-create"
        onSubmit={(event) => {
          const classId = formText(event, "classId");
          void controller.createAccount({
            userId: formText(event, "userId"),
            displayName: formText(event, "displayName"),
            login: formText(event, "login"),
            role: formText(event, "role") === "teacher" ? "teacher" : "student",
            classId: classId === "" ? null : classId,
          });
        }}
      >
        <label>
          {m.userId}
          <input name="userId" maxLength={128} />
        </label>
        <label>
          {m.displayName}
          <input name="displayName" maxLength={120} />
        </label>
        <label>
          {m.login}
          <input name="login" maxLength={64} autoComplete="off" />
        </label>
        <label>
          {m.role}
          <select name="role" defaultValue="student">
            <option value="student">{m.roles.student}</option>
            <option value="teacher">{m.roles.teacher}</option>
          </select>
        </label>
        <label>
          {m.initialClass}
          <select name="classId" defaultValue="">
            <option value="">{m.noClass}</option>
            {state.classes.map((row) => (
              <option key={row.classId} value={row.classId}>
                {row.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={state.busy}>
          {m.create}
        </button>
      </form>
      {state.pendingAccountCreates.length > 0 && (
        <div className="governance-pending-creates">
          <h4>{m.pendingCreates}</h4>
          <ul>
            {state.pendingAccountCreates.map((draft) => (
              <li key={draft.userId}>
                <span>
                  {draft.userId} · {draft.displayName}
                </span>
                <button
                  onClick={() => {
                    controller.resumeAccountCreateDraft(draft.centerId, draft.userId);
                  }}
                >
                  {m.resume}
                </button>
                <button
                  disabled={state.busy}
                  onClick={() => {
                    void controller.createAccount({
                      userId: draft.userId,
                      displayName: draft.displayName,
                      login: draft.login,
                      role: draft.role,
                      classId: draft.classId,
                    });
                  }}
                >
                  {m.retry}
                </button>
                <button
                  onClick={() => {
                    controller.dismissAccountCreateDraft(draft.centerId, draft.userId);
                  }}
                >
                  {m.dismiss}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.accountCreateRecovery !== null && (
        <ReadbackNotice
          m={m}
          name={state.accountCreateRecovery.displayName}
          accept={() => {
            controller.acceptReadback();
          }}
        />
      )}
      {selected !== undefined && (
        <div className="governance-selected">
          <SelectedNameEditor
            m={m}
            value={state.accountDraft?.displayName ?? selected.displayName}
            busy={state.busy}
            recoveryName={state.accountRecovery?.displayName ?? null}
            edit={(displayName) => {
              controller.editAccount(displayName);
            }}
            rename={() => {
              void controller.renameAccount();
            }}
            accept={() => {
              controller.acceptReadback();
            }}
          />
          <p>
            {m.state}: {m.states[selected.state]}
          </p>
          <button
            disabled={state.busy || !selected.canManageAccount}
            onClick={() => {
              void controller.changeAccountState(
                selected.state === "active" ? "disabled" : "active",
              );
            }}
          >
            {selected.state === "active" ? m.disable : m.enable}
          </button>
          <button
            disabled={state.busy || !selected.canManageAccount}
            onClick={() => {
              void controller.revokeSessions();
            }}
          >
            {m.revokeSessions}
          </button>
          {state.lastRevocation !== null && (
            <p>
              <time dateTime={state.lastRevocation.revokedAt}>
                {m.revokedAt(state.lastRevocation.revokedAt)}
              </time>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
