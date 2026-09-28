import type { ClassExchange } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import {
  CENTER_A,
  CENTER_B,
  CLASS_A,
  CLASS_B,
  VERSION_A,
  VERSION_B,
  controllerClient,
  deferred,
  exchange,
  openTwoClassCenter,
  preview,
  revisionResponse,
} from "./governance-controller-test-support.fixture.js";

type Client = ReturnType<typeof controllerClient>;
const envelope = { protocolVersion: "0.1", requestId: "request:controller" } as const;
const EXPIRY = Date.parse("2099-01-01T00:00:00.000Z");
const packageB: ClassExchange = { ...exchange, source: { displayName: "Package B" } };

function previewed(overrides: Partial<ReturnType<typeof preview>> = {}) {
  return {
    ...envelope,
    kind: "governance-class-import-previewed" as const,
    preview: { ...preview(), ...overrides },
  };
}

function confirmed(classId: string = CLASS_A, teachingVersion: string = VERSION_B) {
  return {
    ...envelope,
    kind: "governance-class-import-confirmed" as const,
    classId,
    teachingVersion,
  };
}

function cancelled(previewId: string) {
  return { ...envelope, kind: "governance-class-import-cancelled" as const, previewId };
}

async function reviewedClass(now: () => number = () => 0) {
  const opened = await openTwoClassCenter(now);
  await opened.controller.selectClass(CLASS_A);
  opened.controller.setImportPackage(exchange);
  await opened.controller.previewClassImport();
  return opened;
}

describe("governance controller class import", () => {
  it("stages, replaces and clears packages while hiding previews for explicit cancellation", async () => {
    const { changed, client, controller } = await openTwoClassCenter();
    changed.mockClear();
    controller.setImportPackage(exchange);
    expect(changed).not.toHaveBeenCalled();

    await controller.selectClass(CLASS_A);
    controller.setImportPackage({ ...exchange, source: { displayName: "" } });
    expect(controller.state).toMatchObject({ problem: "invalid", importPackage: null });
    controller.setImportPackage(exchange);
    expect(controller.state).toMatchObject({ problem: null, importPackage: exchange });
    await controller.previewClassImport();
    expect(controller.state.importPreview?.previewId).toBe("preview:a");

    controller.setImportPackage(packageB);
    expect(controller.state).toMatchObject({
      importPackage: packageB,
      importPreview: null,
      importPreviewReviewedId: null,
    });
    await controller.confirmClassImport();
    expect(client.confirmClassImport).not.toHaveBeenCalled();
    client.previewClassImport.mockResolvedValueOnce(previewed({ previewId: "preview:b" }));
    await controller.previewClassImport();

    controller.setImportPackage(null);
    expect(controller.state).toMatchObject({ importPackage: null, importPreview: null });
    await controller.previewClassImport();
    expect(controller.state.problem).toBe("invalid");
    client.cancelClassImport
      .mockResolvedValueOnce(cancelled("preview:a"))
      .mockResolvedValueOnce(cancelled("preview:b"));
    await controller.cancelClassImport();
    await controller.cancelClassImport();
    expect(
      client.cancelClassImport.mock.calls.map(
        (call) => (call[0] as { previewId: string }).previewId,
      ),
    ).toEqual(["preview:a", "preview:b"]);
    expect(controller.state.problem).toBeNull();
    await controller.cancelClassImport();
    expect(client.cancelClassImport).toHaveBeenCalledTimes(2);
    expect(controller.state.problem).toBeNull();
    await controller.selectClass(CLASS_B);
    expect(controller.state.pendingClassId).toBeNull();
    expect(controller.state.classId).toBe(CLASS_B);
  });

  it("previews only a staged package for the loaded class revision", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.previewClassImport();
    const revision = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const opening = controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);
    await controller.previewClassImport();
    expect(client.previewClassImport).not.toHaveBeenCalled();
    revision.resolve(revisionResponse(VERSION_A));
    await opening;

    const previewing = deferred<Awaited<ReturnType<Client["previewClassImport"]>>>();
    client.previewClassImport.mockImplementationOnce(() => previewing.promise);
    const first = controller.previewClassImport();
    await controller.previewClassImport();
    expect(client.previewClassImport).toHaveBeenCalledTimes(1);
    expect(client.previewClassImport).toHaveBeenLastCalledWith(
      {
        centerId: CENTER_A,
        classId: CLASS_A,
        expectedTeachingVersion: VERSION_A,
        package: exchange,
      },
      expect.any(AbortSignal),
    );
    previewing.resolve(previewed());
    await first;
    expect(controller.state).toMatchObject({
      importPreview: preview(),
      importPreviewReviewedId: "preview:a",
      importPreviewExpired: false,
      problem: null,
    });

    for (const overrides of [
      { centerId: CENTER_B },
      { classId: CLASS_B },
      { expectedTeachingVersion: VERSION_B },
    ]) {
      client.previewClassImport.mockResolvedValueOnce(
        previewed({ ...overrides, previewId: "preview:x" }),
      );
      await controller.previewClassImport();
      expect(controller.state.problem).toBe("invalid");
      expect(controller.state.importPreview?.previewId).toBe("preview:a");
    }
  });

  it("discards previews after a class switch, package change or revision reload", async () => {
    const { client, controller } = await openTwoClassCenter();
    await controller.selectClass(CLASS_A);
    controller.setImportPackage(exchange);

    const switched = deferred<Awaited<ReturnType<Client["previewClassImport"]>>>();
    client.previewClassImport.mockImplementationOnce(() => switched.promise);
    const switchedPreview = controller.previewClassImport();
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    switched.resolve(previewed());
    await switchedPreview;
    await controller.selectClass(CLASS_A);
    await controller.confirmClassSwitch(true);
    expect(controller.state.importPreview).toBeNull();

    const repackaged = deferred<Awaited<ReturnType<Client["previewClassImport"]>>>();
    client.previewClassImport.mockImplementationOnce(() => repackaged.promise);
    const repackagedPreview = controller.previewClassImport();
    controller.setImportPackage(packageB);
    repackaged.resolve(previewed());
    await repackagedPreview;
    expect(controller.state.importPreview).toBeNull();

    const reloaded = deferred<Awaited<ReturnType<Client["previewClassImport"]>>>();
    client.previewClassImport.mockImplementationOnce(() => reloaded.promise);
    const reloadedPreview = controller.previewClassImport();
    await controller.loadClassRevision();
    reloaded.resolve(previewed());
    await reloadedPreview;
    expect(controller.state.importPreview).toBeNull();
  });

  it("confirms only a reviewed, unexpired preview and advances the revision", async () => {
    let now = 0;
    const { client, controller } = await reviewedClass(() => now);
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    await controller.confirmClassImport();
    expect(controller.state.problem).toBe("conflict");
    await controller.selectClass(CLASS_A);
    expect(controller.state.importPreview).not.toBeNull();
    await controller.confirmClassImport();
    expect(controller.state.problem).toBe("conflict");
    expect(client.confirmClassImport).not.toHaveBeenCalled();

    await controller.previewClassImport();
    now = EXPIRY;
    await controller.confirmClassImport();
    expect(controller.state).toMatchObject({ importPreviewExpired: true, problem: "conflict" });
    now = EXPIRY - 1;
    await controller.previewClassImport();
    expect(controller.state.importPreviewExpired).toBe(false);

    const confirming = deferred<Awaited<ReturnType<Client["confirmClassImport"]>>>();
    client.confirmClassImport.mockImplementationOnce(() => confirming.promise);
    const pending = controller.confirmClassImport();
    await controller.confirmClassImport();
    await controller.cancelClassImport();
    expect(client.confirmClassImport).toHaveBeenCalledTimes(1);
    expect(client.cancelClassImport).not.toHaveBeenCalled();
    expect(client.confirmClassImport).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, previewId: "preview:a" },
      expect.any(AbortSignal),
    );
    confirming.resolve(confirmed());
    await pending;
    expect(controller.state).toMatchObject({
      classRevisionLoaded: true,
      currentTeachingVersion: VERSION_B,
      importPackage: null,
      importPreview: null,
      importPreviewReviewedId: null,
      importPreviewExpired: false,
      problem: null,
    });
    await controller.cancelClassImport();
    expect(client.cancelClassImport).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_B);
    expect(controller.state.classId).toBe(CLASS_B);
  });

  it("keeps a confirmed revision over an earlier revision read and a later package", async () => {
    const { client, controller } = await reviewedClass();
    const confirming = deferred<Awaited<ReturnType<Client["confirmClassImport"]>>>();
    client.confirmClassImport.mockImplementationOnce(() => confirming.promise);
    const pending = controller.confirmClassImport();
    const revision = deferred<Awaited<ReturnType<Client["classRevision"]>>>();
    client.classRevision.mockImplementationOnce(() => revision.promise);
    const reading = controller.loadClassRevision();
    controller.setImportPackage(packageB);
    confirming.resolve(confirmed());
    await pending;
    revision.resolve(revisionResponse(VERSION_A));
    await reading;
    expect(controller.state).toMatchObject({
      classRevisionLoaded: true,
      currentTeachingVersion: VERSION_B,
      importPackage: packageB,
    });
    await controller.cancelClassImport();
    expect(client.cancelClassImport).not.toHaveBeenCalled();
  });

  it("rejects mismatched or stale confirmations", async () => {
    const { client, controller } = await reviewedClass();
    client.confirmClassImport.mockResolvedValueOnce(confirmed(CLASS_B));
    await controller.confirmClassImport();
    expect(controller.state).toMatchObject({
      problem: "invalid",
      importPreviewReviewedId: "preview:a",
    });

    const confirming = deferred<Awaited<ReturnType<Client["confirmClassImport"]>>>();
    client.confirmClassImport.mockImplementationOnce(() => confirming.promise);
    const pending = controller.confirmClassImport();
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    confirming.resolve(confirmed());
    await pending;
    await controller.selectClass(CLASS_A);
    await controller.confirmClassSwitch(true);
    expect(controller.state.currentTeachingVersion).toBe(VERSION_A);
  });

  it("cancels visible and hidden previews by exact identity", async () => {
    let now = 0;
    const { client, controller } = await reviewedClass(() => now);
    now = EXPIRY;
    await controller.confirmClassImport();
    expect(controller.state.importPreviewExpired).toBe(true);
    client.cancelClassImport.mockResolvedValueOnce(cancelled("preview:other"));
    await controller.cancelClassImport();
    expect(controller.state).toMatchObject({ problem: "invalid", importPreviewExpired: true });
    expect(controller.state.importPreview).not.toBeNull();

    const cancelling = deferred<Awaited<ReturnType<Client["cancelClassImport"]>>>();
    client.cancelClassImport.mockImplementationOnce(() => cancelling.promise);
    const pending = controller.cancelClassImport();
    await controller.cancelClassImport();
    expect(client.cancelClassImport).toHaveBeenCalledTimes(2);
    expect(client.cancelClassImport).toHaveBeenLastCalledWith(
      { centerId: CENTER_A, classId: CLASS_A, previewId: "preview:a" },
      expect.any(AbortSignal),
    );
    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    cancelling.resolve(cancelled("preview:a"));
    await pending;
    await controller.selectClass(CLASS_A);
    await controller.confirmClassSwitch(true);
    expect(controller.state.importPreview).not.toBeNull();

    now = 0;
    client.previewClassImport.mockResolvedValueOnce(previewed({ previewId: "preview:b" }));
    controller.setImportPackage(packageB);
    await controller.previewClassImport();
    client.cancelClassImport.mockResolvedValueOnce(cancelled("preview:b"));
    await controller.cancelClassImport();
    expect(controller.state).toMatchObject({
      importPreview: null,
      importPreviewReviewedId: null,
      importPreviewExpired: false,
      problem: null,
    });
    client.previewClassImport.mockResolvedValueOnce(previewed({ previewId: "preview:c" }));
    await controller.previewClassImport();
    await controller.cancelClassImport();
    expect(controller.state.importPreview?.previewId).toBe("preview:c");
    expect(client.cancelClassImport).toHaveBeenLastCalledWith(
      expect.objectContaining({ previewId: "preview:c" }),
      expect.any(AbortSignal),
    );
  });
});
