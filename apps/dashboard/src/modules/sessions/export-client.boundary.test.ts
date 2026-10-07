import { afterEach, expect, it, vi } from "vitest";
import { SessionExportQuerySchema } from "@marea/protocol";
import { sessionExportClient, saveSessionDownload } from "./export-client.boundary.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("validates export options and reads only typed ZIP responses through authenticated POST", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ students: [{ id: "s", name: "Student", classId: "c" }] })),
    );
  const client = sessionExportClient(fetch),
    signal = new AbortController().signal;
  expect(await client.students(signal)).toEqual([{ id: "s", name: "Student", classId: "c" }]);
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/v1/dashboard/session-export/students",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: "{}",
      signal,
    }),
  );
  fetch.mockResolvedValue(new Response("zip", { headers: { "content-type": "application/zip" } }));
  const q = SessionExportQuerySchema.parse({ identities: "pseudonyms", runId: "run:one" });
  expect(await (await client.download(q, signal)).text()).toBe("zip");
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/v1/dashboard/session-export/download",
    expect.objectContaining({
      body: JSON.stringify(q),
      headers: { "Content-Type": "application/json" },
    }),
  );
  fetch.mockResolvedValue(new Response("html"));
  await expect(client.download(q, signal)).rejects.toThrow("Invalid export response");
  fetch.mockResolvedValue(new Response("private", { status: 413 }));
  await expect(client.download(q, signal)).rejects.toMatchObject({ status: 413 });
});
it("revokes the browser download URL after activation", async () => {
  vi.useFakeTimers();
  const click = vi.fn(),
    link = { href: "", download: "", click };
  const createElement = vi.fn(() => link);
  vi.stubGlobal("document", { createElement });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic"),
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const blob = new Blob(["zip"]);
  saveSessionDownload(blob);
  expect(createElement).toHaveBeenCalledWith("a");
  expect(create).toHaveBeenCalledWith(blob);
  expect(link).toMatchObject({ href: "blob:synthetic", download: "marea-sessions.zip" });
  expect(click).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic");
});
