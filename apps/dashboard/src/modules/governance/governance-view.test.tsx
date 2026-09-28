import type { ReactElement, SubmitEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";
import type {
  GovernanceControllerActions,
  GovernanceState,
} from "./governance-controller-contracts.js";
import { GovernanceModule } from "./governance-module.js";
import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  CLASS_B,
  USER_A,
  USER_B,
  exchange,
  failure,
  openTwoClassCenter,
} from "./governance-controller-test-support.fixture.js";

function actionSpy() {
  return {
    load: vi.fn(),
    loadAccess: vi.fn(),
    loadCenters: vi.fn(),
    selectCenter: vi.fn(),
    confirmCenterSwitch: vi.fn(),
    loadClasses: vi.fn(),
    loadAccounts: vi.fn(),
    selectClass: vi.fn(),
    confirmClassSwitch: vi.fn(),
    loadMemberships: vi.fn(),
    loadClassRevision: vi.fn(),
    selectAccount: vi.fn(),
    confirmAccountSwitch: vi.fn(),
    editClass: vi.fn(),
    createClass: vi.fn(),
    renameClass: vi.fn(),
    editAccount: vi.fn(),
    createAccount: vi.fn(),
    renameAccount: vi.fn(),
    changeAccountState: vi.fn(),
    changeMembership: vi.fn(),
    revokeSessions: vi.fn(),
    exportClass: vi.fn(),
    setImportPackage: vi.fn(),
    stageImportText: vi.fn(),
    previewClassImport: vi.fn(),
    confirmClassImport: vi.fn(),
    cancelClassImport: vi.fn(),
    reload: vi.fn(),
    acceptReadback: vi.fn(),
    resumeClassCreateDraft: vi.fn(),
    dismissClassCreateDraft: vi.fn(),
    resumeAccountCreateDraft: vi.fn(),
    dismissAccountCreateDraft: vi.fn(),
    dispose: vi.fn(),
  } satisfies GovernanceControllerActions;
}

type Element = ReactElement<{
  readonly children?: string | ReactElement;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void;
  readonly "aria-current"?: string;
}>;

function view(state: GovernanceState, actions = actionSpy()) {
  const tree = <GovernanceModule locale="en" state={state} controller={actions} />;
  return { actions, elements: reviewElements(tree) as readonly Element[] };
}

function buttons(elements: readonly Element[], label: string): readonly Element[] {
  return elements.filter(
    (element) => element.type === "button" && element.props.children === label,
  );
}

function submit(form: Element, fields: Record<string, string>): void {
  const preventDefault = vi.fn();
  vi.stubGlobal(
    "FormData",
    class {
      get(name: string) {
        return fields[name] ?? null;
      }
    },
  );
  form.props.onSubmit?.({ currentTarget: {}, preventDefault } as never);
  expect(preventDefault).toHaveBeenCalled();
}

function forms(elements: readonly Element[]): readonly Element[] {
  return elements.filter((element) => element.type === "form");
}

async function richState() {
  let now = 0;
  const opened = await openTwoClassCenter(() => now);
  const { client, controller } = opened;
  await controller.selectClass(CLASS_A);
  controller.selectAccount(USER_A);
  await controller.revokeSessions();
  await controller.exportClass();
  controller.setImportPackage(exchange);
  await controller.previewClassImport();
  client.createClass.mockRejectedValueOnce(failure("uncertain"));
  await controller.createClass("class:c", "Pending class");
  client.createAccount.mockRejectedValueOnce(failure("uncertain"));
  await controller.createAccount({
    userId: "user:c",
    displayName: "Pending account",
    login: "pending-user",
    role: "teacher",
    classId: CLASS_A,
  });
  return {
    ...opened,
    expire: () => {
      now = Date.parse("2099-01-01T00:00:00.000Z");
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("governance administration view", () => {
  it("renders nothing until administrator access is confirmed", async () => {
    const { controller } = await openTwoClassCenter();
    const hidden = { ...controller.state, access: null };
    expect(
      renderToStaticMarkup(
        <GovernanceModule locale="en" state={hidden} controller={actionSpy()} />,
      ),
    ).toBe("");
  });

  it.each(["en", "es"] as const)("renders a complete %s administration surface", async (locale) => {
    const { controller } = await richState();
    expect(
      renderToStaticMarkup(
        <GovernanceModule locale={locale} state={controller.state} controller={controller} />,
      ),
    ).toMatchSnapshot();
  });

  it.each(["en", "es"] as const)(
    "renders %s problems, pending switches, readbacks and unreviewed previews",
    async (locale) => {
      const { client, controller, expire } = await richState();
      controller.editClass("Draft class");
      controller.editAccount("Draft account");
      await controller.reload();
      expire();
      await controller.confirmClassImport();
      await controller.selectClass(CLASS_B);
      controller.selectAccount(USER_B);
      await controller.selectCenter(CENTER_B);
      client.classRevision.mockResolvedValueOnce({
        protocolVersion: "0.1",
        requestId: "request:controller",
        kind: "governance-class-revision-response",
        centerId: CENTER_A,
        classId: CLASS_A,
        teachingVersion: null,
      });
      const state = {
        ...controller.state,
        busy: true,
        importPreviewReviewedId: null,
        accounts: controller.state.accounts.map((row) => ({
          ...row,
          state: "disabled" as const,
          canManageAccount: false,
        })),
        classes: controller.state.classes.map((row) => ({ ...row, operatorReady: false })),
        memberships: [
          ...controller.state.memberships.map((row) => ({ ...row, state: "revoked" as const })),
          {
            ...(controller.state.memberships[0] ?? {
              classId: CLASS_A,
              centerId: CENTER_A,
              role: "student" as const,
              version: "version:a",
            }),
            userId: "user:ghost",
            state: "active" as const,
          },
        ],
      };
      expect(
        renderToStaticMarkup(
          <GovernanceModule locale={locale} state={state} controller={controller} />,
        ),
      ).toMatchSnapshot();
      expect(
        renderToStaticMarkup(
          <GovernanceModule
            locale={locale}
            state={{ ...state, classRevisionLoaded: false }}
            controller={controller}
          />,
        ),
      ).not.toContain("governance-exchange");
      expect(
        renderToStaticMarkup(
          <GovernanceModule
            locale={locale}
            state={{
              ...state,
              currentTeachingVersion: null,
              classRevisionLoaded: true,
              membershipsLoaded: false,
            }}
            controller={controller}
          />,
        ),
      ).toMatchSnapshot();
    },
  );

  it("renders only the center list before a center is selected", async () => {
    const { controller } = await openTwoClassCenter();
    const state = { ...controller.state, centerId: null, classRevisionLoaded: false };
    const markup = renderToStaticMarkup(
      <GovernanceModule locale="en" state={state} controller={actionSpy()} />,
    );
    expect(markup).toContain("Centers");
    expect(markup).not.toContain("governance-classes");
  });

  it("wires navigation, create and readback controls to controller actions", async () => {
    const { controller } = await richState();
    const state = {
      ...controller.state,
      pendingCenterId: CENTER_B,
      pendingClassId: CLASS_B,
      pendingAccountId: USER_B,
      classRecovery: controller.state.classes[0] ?? null,
      accountRecovery: controller.state.accounts[0] ?? null,
      classCreateRecovery: controller.state.classes[1] ?? null,
      accountCreateRecovery: controller.state.accounts[1] ?? null,
    };
    const { actions, elements } = view(state);
    reviewButton(elements, "Reload").props.onClick?.();
    expect(actions.reload).toHaveBeenCalledOnce();

    const opens = buttons(elements, "Open");
    expect(opens.map((button) => button.props["aria-current"])).toEqual([
      "true",
      undefined,
      "true",
      undefined,
      "true",
      undefined,
    ]);
    for (const button of opens) button.props.onClick?.();
    expect(actions.selectCenter.mock.calls).toEqual([[CENTER_A], [CENTER_B]]);
    expect(actions.selectClass.mock.calls).toEqual([[CLASS_A], [CLASS_B]]);
    expect(actions.selectAccount.mock.calls).toEqual([[USER_A], [USER_B]]);

    for (const button of buttons(elements, "Switch")) button.props.onClick?.();
    for (const button of buttons(elements, "Stay")) button.props.onClick?.();
    expect(actions.confirmCenterSwitch.mock.calls).toEqual([[true], [false]]);
    expect(actions.confirmClassSwitch.mock.calls).toEqual([[true], [false]]);
    expect(actions.confirmAccountSwitch.mock.calls).toEqual([[true], [false]]);

    for (const button of buttons(elements, "Use server version")) button.props.onClick?.();
    expect(actions.acceptReadback).toHaveBeenCalledTimes(4);

    for (const button of buttons(elements, "Show")) button.props.onClick?.();
    for (const button of buttons(elements, "Retry")) button.props.onClick?.();
    for (const button of buttons(elements, "Discard")) button.props.onClick?.();
    expect(actions.resumeClassCreateDraft).toHaveBeenCalledWith(CENTER_A, "class:c");
    expect(actions.resumeAccountCreateDraft).toHaveBeenCalledWith(CENTER_A, "user:c");
    expect(actions.createClass).toHaveBeenCalledWith("class:c", "Pending class");
    expect(actions.createAccount).toHaveBeenCalledWith({
      userId: "user:c",
      displayName: "Pending account",
      login: "pending-user",
      role: "teacher",
      classId: CLASS_A,
    });
    expect(actions.dismissClassCreateDraft).toHaveBeenCalledWith(CENTER_A, "class:c");
    expect(actions.dismissAccountCreateDraft).toHaveBeenCalledWith(CENTER_A, "user:c");
  });

  it("submits forms with trimmed field values and validates names before renaming", async () => {
    const { controller } = await richState();
    const { actions, elements } = view(controller.state);
    const [createClass, renameClass, addMember, stage, createAccount, renameAccount] =
      forms(elements);
    if (
      createClass === undefined ||
      renameClass === undefined ||
      addMember === undefined ||
      stage === undefined ||
      createAccount === undefined ||
      renameAccount === undefined
    )
      throw new Error("Expected six forms.");
    submit(createClass, { classId: "class:new", displayName: "New class" });
    expect(actions.createClass).toHaveBeenLastCalledWith("class:new", "New class");
    submit(createClass, {});
    expect(actions.createClass).toHaveBeenLastCalledWith("", "");

    submit(renameClass, { displayName: "Renamed class" });
    expect(actions.editClass).toHaveBeenLastCalledWith("Renamed class");
    expect(actions.renameClass).toHaveBeenCalledTimes(1);
    submit(renameClass, { displayName: "" });
    expect(actions.editClass).toHaveBeenLastCalledWith("");
    expect(actions.renameClass).toHaveBeenCalledTimes(1);

    submit(addMember, { userId: USER_B });
    expect(actions.changeMembership).toHaveBeenLastCalledWith(USER_B, "active");
    submit(stage, { importText: "{}" });
    expect(actions.stageImportText).toHaveBeenLastCalledWith("{}");

    submit(createAccount, {
      userId: "user:new",
      displayName: "New",
      login: "new-login",
      role: "teacher",
      classId: CLASS_A,
    });
    expect(actions.createAccount).toHaveBeenLastCalledWith({
      userId: "user:new",
      displayName: "New",
      login: "new-login",
      role: "teacher",
      classId: CLASS_A,
    });
    submit(createAccount, {
      userId: "user:x",
      displayName: "X",
      login: "x-login",
      role: "other",
      classId: "",
    });
    expect(actions.createAccount).toHaveBeenLastCalledWith({
      userId: "user:x",
      displayName: "X",
      login: "x-login",
      role: "student",
      classId: null,
    });

    submit(renameAccount, { displayName: "Renamed account" });
    expect(actions.editAccount).toHaveBeenLastCalledWith("Renamed account");
    expect(actions.renameAccount).toHaveBeenCalledTimes(1);
    submit(renameAccount, { displayName: "" });
    expect(actions.renameAccount).toHaveBeenCalledTimes(1);
  });

  it("wires membership, account, export and import controls with their availability", async () => {
    const { controller, expire } = await richState();
    const ready = view(controller.state);
    for (const label of [
      "Revoke",
      "Disable",
      "End sessions",
      "Export",
      "Preview import",
      "Clear package",
      "Confirm import",
      "Cancel preview",
    ])
      reviewButton(ready.elements, label).props.onClick?.();
    expect(ready.actions.changeMembership).toHaveBeenCalledWith(USER_A, "revoked");
    expect(ready.actions.changeAccountState).toHaveBeenCalledWith("disabled");
    expect(ready.actions.revokeSessions).toHaveBeenCalledOnce();
    expect(ready.actions.exportClass).toHaveBeenCalledOnce();
    expect(ready.actions.previewClassImport).toHaveBeenCalledOnce();
    expect(ready.actions.setImportPackage).toHaveBeenCalledWith(null);
    expect(ready.actions.confirmClassImport).toHaveBeenCalledOnce();
    expect(ready.actions.cancelClassImport).toHaveBeenCalledOnce();
    expect(reviewButton(ready.elements, "Confirm import").props.disabled).toBe(false);
    expect(reviewButton(ready.elements, "Disable").props.disabled).toBe(false);

    const inactive = view({
      ...controller.state,
      memberships: controller.state.memberships.map((row) => ({
        ...row,
        state: "revoked" as const,
      })),
      accounts: controller.state.accounts.map((row) => ({ ...row, state: "disabled" as const })),
    });
    reviewButton(inactive.elements, "Add or reactivate").props.onClick?.();
    reviewButton(inactive.elements, "Enable").props.onClick?.();
    expect(inactive.actions.changeMembership).toHaveBeenCalledWith(USER_A, "active");
    expect(inactive.actions.changeAccountState).toHaveBeenCalledWith("active");

    const unreviewed = view({ ...controller.state, importPreviewReviewedId: null });
    expect(reviewButton(unreviewed.elements, "Confirm import").props.disabled).toBe(true);
    expire();
    await controller.confirmClassImport();
    const expired = view(controller.state);
    expect(reviewButton(expired.elements, "Confirm import").props.disabled).toBe(true);
    const busy = view({
      ...controller.state,
      busy: true,
      importPreviewExpired: false,
      accounts: controller.state.accounts.map((row) => ({ ...row, canManageAccount: false })),
    });
    for (const label of [
      "Reload",
      "Create",
      "Save name",
      "Export",
      "Preview import",
      "Confirm import",
      "Cancel preview",
      "Revoke",
      "Add or reactivate",
      "Retry",
    ])
      expect(buttons(busy.elements, label).every((button) => button.props.disabled === true)).toBe(
        true,
      );
    const manageable = view({
      ...controller.state,
      accounts: controller.state.accounts.map((row) => ({ ...row, canManageAccount: false })),
    });
    expect(reviewButton(manageable.elements, "Disable").props.disabled).toBe(true);
    expect(reviewButton(manageable.elements, "End sessions").props.disabled).toBe(true);
  });
});
