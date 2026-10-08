import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { hooks } from "../../hook-stub.fixture.js";
import { text, tree } from "../server-settings/forms.fixture.js";
import type { ExternalAccessOutcome } from "./client.boundary.js";
import { externalAccessMessages } from "./messages.js";
import { ExternalAccessView, entriesOf } from "./view.js";

const client = vi.hoisted(() => ({ externalAccess: vi.fn() }));
vi.mock("./client.boundary.js", () => client);
vi.mock("react", async (original) =>
  (await import("../../hook-stub.fixture.js")).stubbedReact(await original<object>()),
);

interface Handlers {
  readonly onChange?: (event: { readonly target: { readonly value: string } }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly "aria-busy"?: boolean;
  readonly onClick?: () => void;
  readonly value?: string;
  readonly "aria-label"?: string;
}

const m = externalAccessMessages("en");
const fetchRequest = vi.fn();
const label = { es: "Correo", en: "Email", eu: "Posta" };
const loaded = {
  kind: "external-access",
  protocolVersion: "0.1",
  requestId: "r",
  classId: "class:a",
  providers: [
    {
      providerId: "org.example.idp",
      displayName: { es: "Centro", en: "School", eu: "Ikastetxea" },
      ruleKinds: [
        { kind: "email", label },
        { kind: "group", label: { es: "Grupo", en: "Group", eu: "Taldea" } },
      ],
    },
  ],
  rules: [
    { providerId: "org.example.idp", kind: "email", value: "ana@school.test" },
    { providerId: "org.example.other", kind: "email", value: "other@school.test" },
  ],
  rejected: [],
};
const ok = (value: object = loaded) => Promise.resolve({ ok: true, value });
const failed = (reason: "missing" | "conflict" | "error") =>
  Promise.resolve({ ok: false, reason } satisfies ExternalAccessOutcome);

function render(classId: string | null = "class:a") {
  hooks.index = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return tree(<ExternalAccessView fetchRequest={fetchRequest} locale="en" classId={classId} />);
}
const page = () =>
  render()
    .map((node) => text(node))
    .join("|");
const settle = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};
async function load(result: Promise<object>) {
  client.externalAccess.mockReturnValue(result);
  render();
  const cleanup = hooks.effects[0]?.();
  await settle();
  return cleanup;
}
function handlers(type: string, index = 0): Handlers {
  const found = render().filter((node) => node.type === type)[index] as
    ReactElement<Handlers> | undefined;
  if (found === undefined) throw new Error(`Missing ${type}.`);
  return found.props;
}
function button(caption: string): Handlers {
  const found = render().find((node) => node.type === "button" && text(node) === caption) as
    ReactElement<Handlers> | undefined;
  if (found === undefined) throw new Error(`Missing ${caption}.`);
  return found.props;
}
const submit = (index = 0) => {
  const preventDefault = vi.fn();
  handlers("form", index).onSubmit?.({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
};
const type = (value: string, index = 0) => {
  handlers("textarea", index).onChange?.({ target: { value } });
};
const busy = () => handlers("section")["aria-busy"];

beforeEach(() => {
  hooks.values = [];
  vi.stubGlobal("crypto", { randomUUID: () => "uuid" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  client.externalAccess.mockReset();
  fetchRequest.mockReset();
});

it("splits pasted entries on whitespace, commas and semicolons", () => {
  expect(entriesOf(" a@x.test,b@x.test;\n c@x.test\t\t d ")).toEqual([
    "a@x.test",
    "b@x.test",
    "c@x.test",
    "d",
  ]);
  expect(entriesOf("  ")).toEqual([]);
});

it("renders nothing without a class and loads the selected class otherwise", async () => {
  expect(render(null)).toEqual([]);
  expect(hooks.values[3]).toBe(false);
  expect(hooks.effects[0]?.()).toBeUndefined();
  expect(client.externalAccess).not.toHaveBeenCalled();
  expect(render()).toEqual([]);
  expect(hooks.dependencies[0]).toEqual([fetchRequest, "class:a", 0]);
  await load(ok());
  expect(client.externalAccess).toHaveBeenCalledWith(
    fetchRequest,
    {
      kind: "external-access-query",
      protocolVersion: "0.1",
      requestId: "external-access:uuid",
      classId: "class:a",
    },
    expect.any(AbortSignal),
  );
  const shown = page();
  for (const expected of [m.title, m.intro, "School", "ana@school.test", m.empty])
    expect(shown).toContain(expected);
  expect(shown).not.toContain("other@school.test");
  expect(shown).not.toContain(m.saved);
  expect(render().filter((node) => node.type === "li")).toHaveLength(1);
  expect(shown.indexOf("ana@school.test")).toBeLessThan(shown.indexOf("Group"));
  expect(handlers("textarea").value).toBe("");
  expect(busy()).toBe(false);
  expect(render(null)).toEqual([]);
  expect(shown).toContain(`Email · ${m.values}`);
  expect(button(m.remove)["aria-label"]).toBe(`${m.remove} ana@school.test`);
});

it("shows loading while the first answer is pending", () => {
  client.externalAccess.mockReturnValue(new Promise(() => undefined));
  render();
  hooks.effects[0]?.();
  expect(page()).toContain(m.loading);
});

it("hides itself when the server offers no provider or no such endpoint", async () => {
  await load(ok({ ...loaded, providers: [], rules: [] }));
  expect(render()).toEqual([]);
  hooks.values = [];
  await load(failed("missing"));
  expect(render()).toEqual([]);
});

it("offers a retry after a failed load", async () => {
  await load(failed("error"));
  expect(page()).toContain(`${m.error} ${m.retry}`);
  client.externalAccess.mockReturnValue(new Promise(() => undefined));
  hooks.effects[0]?.();
  expect(page()).toContain(m.loading);
  hooks.values = [];
  await load(failed("error"));
  button(m.retry).onClick?.();
  render();
  expect(hooks.dependencies[0]).toEqual([fetchRequest, "class:a", 1]);
});

it("ignores answers that arrive after the class changed", async () => {
  const pending = Promise.withResolvers<object>();
  client.externalAccess.mockReturnValue(pending.promise);
  render();
  hooks.effects[0]?.()?.();
  pending.resolve({ ok: false, reason: "error" });
  await settle();
  expect(page()).toContain(m.loading);
});

it("reloads from a clean state when the class changes", async () => {
  await load(ok());
  client.externalAccess.mockReturnValue(new Promise(() => undefined));
  hooks.effects[0]?.();
  expect(page()).toContain(m.loading);
  expect(page()).not.toContain("ana@school.test");
});

it("adds pasted entries, reports rejected input and clears the draft", async () => {
  await load(ok());
  type("kept@school.test", 1);
  type("b@school.test\nnope");
  client.externalAccess.mockReturnValue(ok({ ...loaded, rejected: ["nope", "bad"] }));
  submit();
  expect(busy()).toBe(true);
  expect(client.externalAccess).toHaveBeenLastCalledWith(
    fetchRequest,
    {
      kind: "external-access-change",
      protocolVersion: "0.1",
      requestId: "external-access:uuid",
      classId: "class:a",
      operation: "add",
      providerId: "org.example.idp",
      ruleKind: "email",
      values: ["b@school.test", "nope"],
    },
    expect.any(AbortSignal),
  );
  expect(page()).not.toContain(m.saved);
  await settle();
  expect(page()).toContain(`${m.rejected} nope, bad`);
  expect(busy()).toBe(false);
  expect(handlers("textarea").value).toBe("");
  expect(handlers("textarea", 1).value).toBe("kept@school.test");
  type("draft@school.test");
  client.externalAccess.mockReturnValue(ok());
  button(m.remove).onClick?.();
  expect(client.externalAccess).toHaveBeenLastCalledWith(
    fetchRequest,
    expect.objectContaining({ operation: "remove", values: ["ana@school.test"] }),
    expect.any(AbortSignal),
  );
  await settle();
  expect(page()).toContain(m.saved);
  expect(handlers("textarea").value).toBe("draft@school.test");
  type("x");
  expect(page()).not.toContain(m.saved);
  expect(handlers("textarea").value).toBe("x");
});

it("explains refused, failed and oversized changes without sending empty ones", async () => {
  await load(ok());
  const calls = client.externalAccess.mock.calls.length;
  submit();
  expect(client.externalAccess.mock.calls).toHaveLength(calls);
  type(Array.from({ length: 201 }, (_, index) => `p${String(index)}`).join("\n"));
  submit();
  expect(client.externalAccess.mock.calls).toHaveLength(calls);
  expect(page()).toContain(m.tooMany);
  type(Array.from({ length: 200 }, (_, index) => `p${String(index)}`).join("\n"));
  client.externalAccess.mockReturnValue(failed("conflict"));
  submit();
  expect(client.externalAccess.mock.calls).toHaveLength(calls + 1);
  await settle();
  expect(page()).toContain(m.conflict);
  const retried = Promise.withResolvers<object>();
  client.externalAccess.mockReturnValue(retried.promise);
  button(m.remove).onClick?.();
  expect(page()).not.toContain(m.conflict);
  retried.resolve({ ok: false, reason: "error" });
  await settle();
  expect(page()).toContain(m.error);
  expect(handlers("textarea").value).not.toBe("");
});

it("explains unavailable group access using the installed plugin's guide", async () => {
  const metadata = {
    providers: [
      {
        id: "org.example.idp",
        kinds: [
          { kind: "email", ready: true },
          { kind: "group", ready: false },
        ],
        guides: [
          {
            id: "groups",
            title: { es: "Grupos", en: "Groups setup", eu: "Taldeak" },
            steps: [{ text: { es: "Delegar", en: "Enable delegation", eu: "Gaitu" } }],
          },
        ],
      },
    ],
  };
  fetchRequest.mockResolvedValue(Response.json(metadata));
  await load(ok());
  await vi.waitFor(() => {
    expect(hooks.values[6]).toEqual(metadata);
  });
  expect(page()).toContain(m.needsSetup);
  expect(page()).toContain("Enable delegation");
  expect(
    render().some((node) => node.type === "label" && text(node) === `Email · ${m.values}`),
  ).toBe(true);
  expect(
    render().some((node) => node.type === "label" && text(node) === `Group · ${m.values}`),
  ).toBe(false);
  expect(render().filter((node) => node.type === "textarea")).toHaveLength(1);
  expect(render().find((node) => node.type === "a")?.props.href).toBe(
    "?view=settings&settings=server&server=identities",
  );
});
it("ignores identity readiness loaded after leaving the class", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchRequest.mockReturnValue(pending.promise);
  const dispose = await load(ok());
  dispose?.();
  pending.resolve(Response.json({ providers: [] }));
  await pending.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hooks.values[6]).toBeNull();
});

it("marks admission drafts accurately and clears success and drafts when the class changes", async () => {
  await load(ok());
  const dirty = () => render().find((node) => node.type === "section")?.props["data-dirty"];
  expect(dirty()).toBe(false);
  type("  ");
  expect(dirty()).toBe(false);
  type("a@school.test");
  expect(dirty()).toBe(true);
  type("b@school.test", 1);
  expect(dirty()).toBe(true);
  hooks.values[3] = true;
  await load(ok());
  expect(dirty()).toBe(false);
  expect(hooks.values[3]).toBe(false);
});
it("uses exact readiness kinds and provider IDs, with legacy fallback for missing kinds", async () => {
  fetchRequest.mockResolvedValue(
    Response.json({
      providers: [
        { id: "other", guides: [], kinds: [{ kind: "group", ready: true }] },
        { id: "org.example.idp", guides: [], kinds: [{ kind: "group", ready: false }] },
      ],
    }),
  );
  await load(ok());
  await vi.waitFor(() => {
    expect(hooks.values[6]).not.toBeNull();
  });
  expect(
    render().some((node) => node.type === "label" && text(node) === `Email · ${m.values}`),
  ).toBe(true);
  expect(
    render().some((node) => node.type === "label" && text(node) === `Group · ${m.values}`),
  ).toBe(false);
  expect(fetchRequest).toHaveBeenCalledWith(
    "/api/v1/dashboard/server-settings",
    expect.objectContaining({
      body: '{"operation":"identity-status"}',
      signal: expect.any(AbortSignal) as AbortSignal,
    }),
  );
  fetchRequest.mockRejectedValue(new Error("unavailable"));
  await load(ok());
  await vi.waitFor(() => {
    expect(hooks.values[6]).toBeNull();
  });
  expect(
    render().some((node) => node.type === "label" && text(node) === `Group · ${m.values}`),
  ).toBe(true);
});
it("does not erase current readiness with an abandoned failure", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchRequest.mockReturnValue(pending.promise);
  const dispose = await load(ok());
  dispose?.();
  const current = { providers: [] };
  hooks.values[6] = current;
  pending.reject(new Error("late"));
  await pending.promise.catch(() => undefined);
  await settle();
  expect(hooks.values[6]).toBe(current);
});
