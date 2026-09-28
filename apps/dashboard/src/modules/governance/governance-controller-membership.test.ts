import { describe, expect, it } from "vitest";

import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  CLASS_B,
  USER_A,
  USER_B,
  VERSION_A,
  VERSION_B,
  controllerClient,
  deferred,
  exchange,
  failure,
  membership,
  membershipsResponse,
  openTwoClassCenter,
  revisionResponse,
} from "./governance-controller-test-support.fixture.js";

type Client = ReturnType<typeof controllerClient>;
const envelope = { protocolVersion: "0.1", requestId: "request:controller" } as const;

function membershipChanged(userId: string, classId: string = CLASS_A, centerId: string = CENTER_A) {
  return {
    ...envelope,
    kind: "governance-membership-changed" as const,
    membership: { ...membership(userId, "revoked", classId, centerId), version: VERSION_B },
  };
}

describe("governance controller membership and export writes", () => {
  it("changes memberships only for known accounts in a loaded class", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.changeMembership(USER_A, "active");
    expect(controller.state.problem).toBe("invalid");

    const memberships = deferred<Awaited<ReturnType<Client["memberships"]>>>();
    client.memberships.mockImplementationOnce(() => memberships.promise);
    const opening = controller.selectClass(CLASS_A);
    await controller.changeMembership(USER_A, "active");
    expect(controller.state.problem).toBe("invalid");
    memberships.resolve(membershipsResponse([membership(USER_A)]));
    await opening;

    await controller.changeMembership("user:unknown", "active");
    expect(controller.state.problem).toBe("invalid");
    await controller.changeMembership(USER_B, "revoked");
    expect(controller.state.problem).toBe("invalid");
    expect(client.changeMembership).not.toHaveBeenCalled();

    client.changeMembership.mockResolvedValueOnce(membershipChanged(USER_B));
    await controller.changeMembership(USER_B, "active");
    expect(client.changeMembership).toHaveBeenLastCalledWith(
      {
        centerId: CENTER_A,
        classId: CLASS_A,
        userId: USER_B,
        state: "active",
        expectedVersion: null,
      },
      expect.any(AbortSignal),
    );
    expect(controller.state.memberships.map((row) => row.userId)).toEqual([USER_A, USER_B]);

    client.changeMembership.mockResolvedValueOnce(membershipChanged(USER_A));
    await controller.changeMembership(USER_A, "revoked");
    expect(client.changeMembership).toHaveBeenLastCalledWith(
      {
        centerId: CENTER_A,
        classId: CLASS_A,
        userId: USER_A,
        state: "revoked",
        expectedVersion: VERSION_A,
      },
      expect.any(AbortSignal),
    );
    expect(controller.state.memberships.map((row) => [row.userId, row.state])).toEqual([
      [USER_A, "revoked"],
      [USER_B, "revoked"],
    ]);
    expect(controller.state.membershipsLoaded).toBe(true);

    for (const response of [
      membershipChanged(USER_A, CLASS_A, CENTER_B),
      membershipChanged(USER_A, CLASS_B),
      membershipChanged(USER_B),
    ]) {
      client.changeMembership.mockResolvedValueOnce(response);
      await controller.changeMembership(USER_A, "active");
      expect(controller.state.problem).toBe("invalid");
    }

    const changing = deferred<Awaited<ReturnType<Client["changeMembership"]>>>();
    client.changeMembership.mockImplementationOnce(() => changing.promise);
    const pending = controller.changeMembership(USER_A, "active");
    await controller.changeMembership(USER_B, "active");
    expect(client.changeMembership).toHaveBeenCalledTimes(6);
    await controller.selectClass(CLASS_B);
    changing.resolve({
      ...membershipChanged(USER_A),
      membership: membership(USER_A, "active", CLASS_A),
    });
    await pending;
    expect(controller.state.memberships.map((row) => row.classId)).toEqual([CLASS_B]);
  });

  it("exports the loaded class revision and discards exports for a replaced class", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.exportClass();
    const revision = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_A);
    await controller.exportClass();
    expect(client.exportClass).not.toHaveBeenCalled();
    revision.resolve(revisionResponse(null));
    await opening;
    await controller.exportClass();
    expect(controller.state.problem).toBe("invalid");
    expect(client.exportClass).not.toHaveBeenCalled();

    await controller.loadClassRevision();
    await controller.exportClass();
    expect(client.exportClass).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, expectedTeachingVersion: VERSION_A },
      expect.any(AbortSignal),
    );
    expect(controller.state.exportedPackage).not.toBeNull();

    const exported = deferred<Awaited<ReturnType<Client["exportClass"]>>>();
    client.exportClass.mockImplementationOnce(() => exported.promise);
    const exporting = controller.exportClass();
    await controller.exportClass();
    expect(client.exportClass).toHaveBeenCalledTimes(2);
    await controller.selectClass(CLASS_B);
    exported.resolve({ ...envelope, kind: "governance-class-exported", package: exchange });
    await exporting;
    expect(controller.state.exportedPackage).toBeNull();

    client.exportClass.mockRejectedValueOnce(failure("conflict"));
    await controller.exportClass();
    expect(controller.state.problem).toBe("conflict");
  });
});
