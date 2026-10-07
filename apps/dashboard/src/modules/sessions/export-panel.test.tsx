import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { tree, text, control, change } from "../server-settings/forms.fixture.js";
import { SessionExportPanel } from "./export-panel.js";
import { saveSessionDownload } from "./export-client.boundary.js";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
vi.mock("./export-client.boundary.js", () => ({ saveSessionDownload: vi.fn() }));
const client = { students: vi.fn(), download: vi.fn() };
const render = (runId?: string, classId: string | null = null) => {
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return tree(
    <SessionExportPanel
      client={client}
      locale="en"
      classId={classId}
      {...(runId === undefined ? {} : { runId })}
    />,
  );
};
const submit = (nodes: ReturnType<typeof tree>) => {
  const handler = nodes.find((n) => n.type === "form")?.props.onSubmit as (e: object) => void;
  const preventDefault = vi.fn();
  handler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
};
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  vi.clearAllMocks();
  client.students.mockResolvedValue([
    { id: "s1", name: "One", classId: "c1" },
    { id: "s2", name: "Two", classId: "c2" },
  ]);
  client.download.mockResolvedValue(new Blob(["zip"]));
});
it("loads scoped students and exports the complete selection including dates and pseudonyms", async () => {
  render();
  hooks.effects[0]?.();
  await vi.waitFor(() => {
    expect(hooks.values[0]).toHaveLength(2);
  });
  hooks.index = 0;
  expect(
    renderToStaticMarkup(<SessionExportPanel client={client} locale="en" classId="c1" />),
  ).toMatchSnapshot("class export form and safety notes");
  change(control(render(undefined, "c1"), "Student"), { value: "s1" });
  change(control(render(undefined, "c1"), "From"), { value: "2026-10-01" });
  change(control(render(undefined, "c1"), "Until"), { value: "2026-10-08" });
  change(control(render(undefined, "c1"), "Identities"), { value: "pseudonyms" });
  submit(render(undefined, "c1"));
  await vi.waitFor(() => {
    expect(saveSessionDownload).toHaveBeenCalledOnce();
  });
  expect(client.download).toHaveBeenCalledWith(
    {
      identities: "pseudonyms",
      classId: "c1",
      studentId: "s1",
      from: "2026-10-01T00:00:00.000Z",
      until: "2026-10-08T00:00:00.000Z",
    },
    expect.any(AbortSignal),
  );
  expect(render().some((n) => text(n) === "Download ready.")).toBe(true);
  change(control(render(), "Identities"), { value: "names" });
  render();
  hooks.effects[1]?.();
  expect(hooks.values[1]).toBe("");
});
it("supports a single session and all sessions, and reports oversized or invalid exports", async () => {
  render("run:one");
  hooks.effects[0]?.();
  expect(client.students).not.toHaveBeenCalled();
  submit(render("run:one"));
  await vi.waitFor(() => {
    expect(client.download).toHaveBeenCalledWith(
      { identities: "names", runId: "run:one" },
      expect.any(AbortSignal),
    );
  });
  client.download.mockRejectedValue(new EvaluationRequestError(413));
  submit(render());
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("large");
  });
  expect(client.download).toHaveBeenLastCalledWith(
    { identities: "names" },
    expect.any(AbortSignal),
  );
  client.download.mockRejectedValue(new Error("offline"));
  submit(render());
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("error");
  });
  change(control(render(), "From"), { value: "2026-10-08" });
  change(control(render(), "Until"), { value: "2026-10-01" });
  submit(render());
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("error");
  });
});
it("discards late list replies and errors after disposal", async () => {
  const pending = Promise.withResolvers<{ id: string; name: string; classId: string }[]>();
  client.students.mockReturnValue(pending.promise);
  render();
  const cleanup = hooks.effects[0]?.();
  cleanup?.();
  pending.resolve([{ id: "late", name: "Late reply", classId: "class:late" }]);
  await pending.promise;
  await Promise.resolve();
  expect(hooks.values[0]).toEqual([]);
  const fail = Promise.withResolvers<[]>();
  client.students.mockReturnValue(fail.promise);
  render();
  hooks.effects[0]?.()?.();
  fail.reject(new Error("late"));
  await Promise.resolve();
  expect(hooks.values[5]).toBe("idle");
  client.students.mockRejectedValue(new Error("offline"));
  render();
  hooks.effects[0]?.();
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("error");
  });
});

it("tracks filter dependencies, locks pending downloads and renders the correct single-session controls", async () => {
  render();
  expect(hooks.dependencies).toEqual([[client, undefined], [null]]);
  hooks.effects[0]?.();
  await vi.waitFor(() => {
    expect(hooks.values[0]).toHaveLength(2);
  });
  expect(
    render()
      .filter((n) => n.type === "option")
      .map((n) => n.props.value),
  ).toContain("s2");
  const single = render("run:one");
  expect(single.some((n) => n.type === "label" && text(n).startsWith("Student"))).toBe(false);
  expect(single.find((n) => n.type === "button")?.props.children).toBe("Download this session");
  change(control(render(), "Identities"), { value: "names" });
  expect(hooks.values[4]).toBe("names");
  const deferred = Promise.withResolvers<Blob>();
  client.download.mockReturnValue(deferred.promise);
  submit(render());
  expect(hooks.values[5]).toBe("busy");
  expect(render().find((n) => n.type === "fieldset")?.props.disabled).toBe(true);
  deferred.resolve(new Blob());
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("done");
  });
  client.download.mockRejectedValue(new EvaluationRequestError(403));
  submit(render());
  await vi.waitFor(() => {
    expect(hooks.values[5]).toBe("error");
  });
  for (const status of ["busy", "done", "error", "large"]) {
    hooks.values[5] = status;
    expect(
      render()
        .filter((n) => n.type === "p" && n.props.role)
        .map((n) => n.props.role),
    ).toEqual([status === "error" || status === "large" ? "alert" : "status"]);
  }
});
