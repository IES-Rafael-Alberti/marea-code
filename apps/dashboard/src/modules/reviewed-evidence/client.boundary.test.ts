import { expect, it, vi } from "vitest";
import { createReviewedEvidenceClient } from "./client.boundary.js";
import { query, page, criterion } from "./evidence.fixture.js";
import { UsageHealthRequestError } from "../usage-health-client.boundary.js";

it.each([
  query(),
  query({ kind: "criteria", studentId: "s1" }),
  query({ kind: "history", studentId: "s1", criterion }),
])("posts scoped %s with cookies and cancellation", async (input) => {
  const result = page({ kind: input.kind, query: input, entries: [] });
  const fetchRequest = vi.fn().mockResolvedValue(Response.json(result));
  const signal = new AbortController().signal;
  expect(await createReviewedEvidenceClient(fetchRequest).read(input, signal)).toEqual(result);
  expect(fetchRequest).toHaveBeenCalledWith(
    `/api/v1/dashboard/reviewed-evidence/${input.kind}`,
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      signal,
      body: JSON.stringify(input),
    }),
  );
});
it("rejects foreign context even with a matching request and class, and never reads error bodies", async () => {
  for (const extra of [{ classId: "class:two" }, { requestId: "foreign" }, { limit: 24 }]) {
    const fetchRequest = vi.fn().mockResolvedValue(Response.json(page({ query: query(extra) })));
    await expect(
      createReviewedEvidenceClient(fetchRequest).read(query(), new AbortController().signal),
    ).rejects.toThrow();
  }
  const mismatched = vi
    .fn()
    .mockResolvedValue(Response.json(page({ query: query({ limit: 24 }) })));
  await expect(
    createReviewedEvidenceClient(mismatched).read(query(), new AbortController().signal),
  ).rejects.toThrow("Evidence context mismatch.");
  const fetchRequest = vi
    .fn()
    .mockResolvedValue(new Response("private credentials", { status: 503 }));
  await expect(
    createReviewedEvidenceClient(fetchRequest).read(query(), new AbortController().signal),
  ).rejects.toEqual(new UsageHealthRequestError(503));
});
it("enforces byte limits and rejects mismatched operation, untrusted fields and missing bodies", async () => {
  for (const response of [
    new Response(null),
    new Response(" ".repeat(1_048_577)),
    Response.json({ ...page(), teacherNote: "private" }),
    Response.json(
      page({ kind: "criteria", query: query({ kind: "criteria", studentId: "s1" }), entries: [] }),
    ),
  ]) {
    const fetchRequest = vi.fn().mockResolvedValue(response);
    await expect(
      createReviewedEvidenceClient(fetchRequest).read(query(), new AbortController().signal),
    ).rejects.toThrow();
  }
});
