import type { GovernanceAccessResponse, GovernanceCentersResponse } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { GovernanceState } from "./governance-controller-contracts.js";
import { GovernanceController } from "./governance-controller.js";
import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  CLASS_B,
  USER_A,
  USER_B,
  centersResponse,
  controllerClient,
  deferred,
  exchange,
  failure,
  membershipsResponse,
  openCenter,
  openClass,
  openTwoClassCenter,
} from "./governance-controller-test-support.fixture.js";

type Client = ReturnType<typeof controllerClient>;

function resetCalls(client: Client): void {
  for (const operation of Object.values(client)) operation.mockClear();
}

function calls(client: Client): number {
  return Object.values(client).reduce((total, operation) => total + operation.mock.calls.length, 0);
}

function accessResponse(administrator: boolean): GovernanceAccessResponse {
  return {
    protocolVersion: "0.1",
    requestId: "request:controller",
    kind: "governance-access-response",
    access: { administrator },
  } as GovernanceAccessResponse;
}

describe("governance controller lifecycle", () => {
  it("makes every action inert after disposal and stops notifying", async () => {
    const { changed, client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.selectAccount(USER_A);
    controller.editAccount("Account draft");
    controller.editClass("Class draft");
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    await controller.createClass("bad id", "Name");
    expect(controller.state.problem).toBe("invalid");

    const classes = deferred<Awaited<ReturnType<Client["classes"]>>>();
    client.classes.mockImplementationOnce(() => classes.promise);
    const loading = controller.loadClasses();
    const signal = client.classes.mock.lastCall?.[1] as AbortSignal | undefined;
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    expect(controller.state.problem).toBeNull();
    const disposedState = controller.state;
    resetCalls(client);
    changed.mockClear();
    classes.resolve(await controllerClient().classes({ centerId: CENTER_A, afterId: null }));
    await loading;

    await controller.load();
    await controller.loadAccess();
    await controller.loadCenters();
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    await controller.loadClasses();
    await controller.loadAccounts();
    await controller.loadMemberships();
    await controller.loadClassRevision();
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    controller.selectAccount(USER_B);
    controller.confirmAccountSwitch(true);
    controller.resumeClassCreateDraft(CENTER_A, CLASS_B);
    controller.dismissClassCreateDraft(CENTER_A, CLASS_B);
    await controller.createClass("class:new", "New class");
    await controller.renameClass();
    await controller.createAccount({
      userId: "user:new",
      displayName: "New",
      login: "new-user",
      role: "teacher",
      classId: null,
    });
    await controller.renameAccount();
    await controller.changeAccountState("disabled");
    await controller.changeMembership(USER_A, "active");
    await controller.revokeSessions();
    await controller.exportClass();
    controller.setImportPackage(null);
    await controller.previewClassImport();
    await controller.confirmClassImport();
    await controller.cancelClassImport();
    await controller.reload();
    controller.acceptReadback();

    expect(calls(client)).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(controller.state).toBe(disposedState);
  });

  it("stops paginating and ignores late pages after disposal", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.loadAccess();
    const firstPage = deferred<GovernanceCentersResponse>();
    client.centers.mockImplementationOnce(() => firstPage.promise);
    const loading = controller.loadCenters();
    controller.dispose();
    firstPage.resolve(centersResponse([CENTER_A], CENTER_A));
    await loading;
    expect(client.centers).toHaveBeenCalledTimes(1);
  });

  it("does not load centers without administrator access", async () => {
    const client = controllerClient();
    client.access.mockResolvedValueOnce(accessResponse(false));
    const controller = new GovernanceController(client, vi.fn());
    await controller.load();
    expect(controller.state.access).toEqual({ administrator: false });
    expect(client.centers).not.toHaveBeenCalled();
    expect(controller.state.availability.canSelectCenter).toBe(false);
  });

  it("adopts only the latest access refresh", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    const older = deferred<GovernanceAccessResponse>();
    client.access.mockImplementationOnce(() => older.promise);
    const first = controller.loadAccess();
    client.access.mockResolvedValueOnce(accessResponse(false));
    await controller.loadAccess();
    older.resolve(accessResponse(true));
    await first;
    expect(controller.state.access).toEqual({ administrator: false });
  });

  it("follows center pages and discards superseded or unauthorized center reads", async () => {
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    await controller.loadAccess();
    client.centers
      .mockResolvedValueOnce(centersResponse([CENTER_A], CENTER_A))
      .mockResolvedValueOnce(centersResponse([CENTER_B]));
    await controller.loadCenters();
    expect(controller.state.centers.map((center) => center.centerId)).toEqual([CENTER_A, CENTER_B]);
    expect(client.centers).toHaveBeenNthCalledWith(1, { afterId: null }, expect.any(AbortSignal));
    expect(client.centers).toHaveBeenNthCalledWith(
      2,
      { afterId: CENTER_A },
      expect.any(AbortSignal),
    );

    const superseded = deferred<GovernanceCentersResponse>();
    client.centers.mockImplementationOnce(() => superseded.promise);
    const older = controller.loadCenters();
    client.centers.mockResolvedValueOnce(centersResponse([CENTER_A]));
    await controller.loadCenters();
    superseded.resolve(centersResponse([CENTER_B]));
    await older;
    expect(controller.state.centers.map((center) => center.centerId)).toEqual([CENTER_A]);

    const unauthorized = deferred<GovernanceCentersResponse>();
    client.centers.mockImplementationOnce(() => unauthorized.promise);
    const stale = controller.loadCenters();
    client.access.mockResolvedValueOnce(accessResponse(true));
    await controller.loadAccess();
    unauthorized.resolve(centersResponse([CENTER_B]));
    await stale;
    expect(controller.state.centersLoaded).toBe(false);
    expect(controller.state.centers).toEqual([]);
  });

  it("clears only a selected center that disappears from refreshed centers", async () => {
    const { client, controller } = await openClass();
    const kept = deferred<Awaited<ReturnType<Client["memberships"]>>>();
    client.memberships.mockImplementationOnce(() => kept.promise);
    const keptLoad = controller.loadMemberships();
    await controller.loadCenters();
    kept.resolve(membershipsResponse([]));
    await keptLoad;
    expect(controller.state.centerId).toBe(CENTER_A);
    expect(controller.state.memberships).toEqual([]);
    expect(controller.state.membershipsLoaded).toBe(true);

    const dropped = deferred<Awaited<ReturnType<Client["memberships"]>>>();
    client.memberships.mockImplementationOnce(() => dropped.promise);
    const droppedLoad = controller.loadMemberships();
    client.centers.mockResolvedValueOnce(centersResponse([CENTER_B]));
    await controller.loadCenters();
    expect(controller.state.centerId).toBeNull();
    expect(controller.state.classes).toEqual([]);
    dropped.resolve(membershipsResponse([]));
    await droppedLoad;
    expect(controller.state.membershipsLoaded).toBe(false);
  });

  it("reports busy until every overlapping request settles", async () => {
    const { client, controller } = await openCenter();
    const classes = deferred<Awaited<ReturnType<Client["classes"]>>>();
    const accounts = deferred<Awaited<ReturnType<Client["accounts"]>>>();
    client.classes.mockImplementationOnce(() => classes.promise);
    client.accounts.mockImplementationOnce(() => accounts.promise);
    expect(controller.state.busy).toBe(false);
    const loadingClasses = controller.loadClasses();
    const loadingAccounts = controller.loadAccounts();
    expect(controller.state.busy).toBe(true);
    classes.resolve(await controllerClient().classes({ centerId: CENTER_A, afterId: null }));
    await loadingClasses;
    expect(controller.state.busy).toBe(true);
    accounts.resolve(await controllerClient().accounts({ centerId: CENTER_A, afterId: null }));
    await loadingAccounts;
    expect(controller.state.busy).toBe(false);
  });

  it("maps client failures to problems and treats forbidden as global evidence", async () => {
    const { client, controller } = await openCenter();
    for (const code of ["invalid", "conflict", "uncertain", "unconfigured", "skill-unavailable"]) {
      client.classes.mockRejectedValueOnce(failure(code));
      await controller.loadClasses();
      expect(controller.state.problem).toBe(code);
    }
    client.classes.mockRejectedValueOnce(failure("unexpected"));
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");
    client.classes.mockRejectedValueOnce(undefined);
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");

    const stale = deferred<Awaited<ReturnType<Client["classes"]>>>();
    client.classes.mockImplementationOnce(() => stale.promise);
    const staleLoad = controller.loadClasses();
    await controller.loadClasses();
    expect(controller.state.problem).toBeNull();
    stale.reject(failure("conflict"));
    await staleLoad;
    expect(controller.state.problem).toBeNull();

    const forbidden = deferred<Awaited<ReturnType<Client["classes"]>>>();
    client.classes.mockImplementationOnce(() => forbidden.promise);
    const forbiddenLoad = controller.loadClasses();
    await controller.loadClasses();
    forbidden.reject(failure("forbidden"));
    await forbiddenLoad;
    expect(controller.state.problem).toBe("forbidden");
    expect(controller.state.access).toBeNull();
    expect(controller.state.centerId).toBeNull();
  });

  it("derives availability hints from loaded scopes", async () => {
    const hints = ({ availability: hint }: GovernanceState) => [
      hint.canSelectCenter,
      hint.canManageClasses,
      hint.canManageAccounts,
      hint.canManageMemberships,
      hint.canExchangeClass,
    ];
    const client = controllerClient();
    const controller = new GovernanceController(client, vi.fn());
    expect(hints(controller.state)).toEqual([false, false, false, false, false]);
    await controller.load();
    expect(hints(controller.state)).toEqual([true, false, false, false, false]);
    const accounts = deferred<Awaited<ReturnType<Client["accounts"]>>>();
    client.accounts.mockImplementationOnce(() => accounts.promise);
    const switching = controller.selectCenter(CENTER_A);
    await vi.waitFor(() => {
      expect(controller.state.classesLoaded).toBe(true);
    });
    expect(hints(controller.state)).toEqual([true, true, false, false, false]);
    accounts.resolve(await controllerClient().accounts({ centerId: CENTER_A, afterId: null }));
    await switching;
    expect(hints(controller.state)).toEqual([true, true, true, false, false]);
    const revision = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_A);
    revision.reject(failure("load"));
    await opening;
    expect(hints(controller.state)).toEqual([true, true, true, false, false]);
    await controller.loadClassRevision();
    expect(hints(controller.state)).toEqual([true, true, true, false, false]);
    await controller.loadMemberships();
    expect(hints(controller.state)).toEqual([true, true, true, true, true]);
  });

  it("switches centers only to listed centers and confirms unsaved-work switches explicitly", async () => {
    const { changed, client, controller } = await openClass();
    resetCalls(client);
    await controller.selectCenter(CENTER_A);
    await controller.selectCenter("center:unknown");
    expect(calls(client)).toBe(0);
    changed.mockClear();
    await controller.confirmCenterSwitch(true);
    await controller.confirmClassSwitch(false);
    controller.confirmAccountSwitch(false);
    expect(changed).not.toHaveBeenCalled();

    controller.editClass("Unsaved");
    await controller.selectCenter(CENTER_B);
    expect(controller.state.pendingCenterId).toBe(CENTER_B);
    await controller.confirmCenterSwitch(false);
    expect(controller.state.pendingCenterId).toBeNull();
    expect(controller.state.centerId).toBe(CENTER_A);

    await controller.selectCenter(CENTER_B);
    client.centers.mockResolvedValueOnce(centersResponse([CENTER_A]));
    await controller.loadCenters();
    await controller.confirmCenterSwitch(true);
    expect(controller.state.pendingCenterId).toBeNull();
    expect(controller.state.centerId).toBe(CENTER_A);

    await controller.loadCenters();
    await controller.selectCenter(CENTER_B);
    await controller.confirmCenterSwitch(true);
    expect(controller.state.centerId).toBe(CENTER_B);
    expect(controller.state.classes.map((row) => row.centerId)).toEqual([CENTER_B]);
  });
});
