import { beforeEach, expect, it, vi } from "vitest";
import { SkillLibraryEntrySchema } from "@marea/protocol";
import { SkillSelection } from "./selection.js";
import { skillWorkspaceMessages } from "./messages.js";
import { tree, text, control, change } from "../server-settings/forms.fixture.js";
const { hooks, mockReact } = await vi.hoisted(async () =>
  (await import("../server-settings/state-hooks.fixture.js")).stateHarness(),
);
vi.mock("react", async (original) => mockReact(original));
const m = skillWorkspaceMessages("en");
const entry = (name: string, kind = "didactic") =>
  SkillLibraryEntrySchema.parse({
    id: `marea/${name}`,
    name,
    title: name,
    description: `Practice ${name}`,
    kind,
    source: "marea",
    digest: `sha256:${"a".repeat(64)}`,
    compatibility: null,
  });
const catalog = [
  entry("alpha"),
  entry("beta"),
  entry("judge", "evaluation"),
  entry("other-judge", "evaluation"),
] as const;
function fixture(
  kind: "didactic" | "evaluation" = "didactic",
  initial = [{ id: catalog[0].id, digest: catalog[0].digest }],
) {
  const save = vi.fn(() => Promise.resolve());
  const close = vi.fn();
  const render = (busy = false, help: string | undefined = "Only new sessions") => {
    hooks.index = 0;
    return tree(
      <SkillSelection
        catalog={catalog}
        initial={initial}
        kind={kind}
        busy={busy}
        title="Choose skills"
        help={help}
        save={save}
        close={close}
        messages={m}
      />,
    );
  };
  const click = (label: string) => {
    const button = render().find((node) => node.type === "button" && text(node) === label);
    if (!button) throw new Error(label);
    (button.props.onClick as () => void)();
  };
  return { render, click, save, close };
}
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});
it("keeps the catalog order stable while selecting, searching and saving", () => {
  const f = fixture();
  const order = () =>
    f
      .render()
      .filter((node) => node.type === "strong")
      .map(text);
  expect(order()).toEqual(["alpha", "beta"]);
  change(control(f.render(), "beta"), { checked: true });
  expect(order()).toEqual(["alpha", "beta"]);
  change(control(f.render(), "alpha"), { checked: false });
  change(control(f.render(), m.search), { value: "BETA" });
  expect(order()).toEqual(["beta"]);
  f.click(m.select);
  expect(f.save).toHaveBeenCalledWith([{ id: catalog[1].id, digest: catalog[1].digest }]);
  f.click(m.cancel);
  expect(f.close).toHaveBeenCalledOnce();
  change(control(f.render(), m.search), { value: "missing" });
  expect(f.render().some((node) => text(node) === m.noResults)).toBe(true);
});
it("allows one evaluation method and distinguishes an empty selection", () => {
  const f = fixture("evaluation", []);
  expect(f.render().filter((node) => node.props.className === "skills-curriculum")).toHaveLength(0);
  expect(f.render().some((node) => text(node) === m.noEvaluation)).toBe(true);
  change(control(f.render(), "judge"), { checked: true });
  change(control(f.render(), "other-judge"), { checked: true });
  expect(control(f.render(), "judge").checked).toBe(false);
  expect(control(f.render(), "other-judge").checked).toBe(true);
  f.click(m.select);
  expect(f.save).toHaveBeenCalledWith([{ id: catalog[3].id, digest: catalog[3].digest }]);
});
it("lets a teacher remove an unavailable selected skill and prevents submissions while busy or over limit", () => {
  const missing = entry("missing");
  const f = fixture("didactic", [{ id: missing.id, digest: missing.digest }]);
  change(control(f.render(), missing.id), { checked: false });
  f.click(m.select);
  expect(f.save).toHaveBeenCalledWith([]);
  expect(f.render().some((node) => text(node) === m.emptyChoice)).toBe(true);
  expect(
    f
      .render(true)
      .filter((node) => node.type === "button")
      .every((node) => node.props.disabled),
  ).toBe(true);
  expect(f.render(true).some((node) => text(node) === m.working)).toBe(true);
  hooks.values = [];
  const large = fixture(
    "didactic",
    Array.from({ length: 65 }, (_, i) => ({
      id: entry(`item-${String(i)}`).id,
      digest: missing.digest,
    })),
  );
  expect(
    large.render(false, undefined).find((node) => node.type === "button" && text(node) === m.select)
      ?.props.disabled,
  ).toBe(true);
});
it("supplies clear usage summaries in all dashboard locales", () => {
  expect(skillWorkspaceMessages("es").impact(2, 3)).toBe(
    "Se actualizará en 2 clases y 3 selecciones individuales.",
  );
  expect(skillWorkspaceMessages("en").impact(1, 0)).toBe(
    "Will update 1 classes and 0 individual selections.",
  );
  expect(skillWorkspaceMessages("eu").impact(0, 2)).toBe(
    "0 ikasgelatan eta 2 banakako hautaketatan eguneratuko da.",
  );
});

it("preserves unrelated selections while toggling, including missing entries and the exact limit", () => {
  const alpha = catalog[0],
    beta = catalog[1],
    missing = entry("missing");
  const f = fixture(
    "didactic",
    [alpha, missing].map(({ id, digest }) => ({ id, digest })),
  );
  expect(f.render().filter((node) => node.props.type === "checkbox")).toHaveLength(3);
  change(control(f.render(), missing.id), { checked: false });
  f.click(m.select);
  expect(f.save).toHaveBeenLastCalledWith([{ id: alpha.id, digest: alpha.digest }]);
  change(control(f.render(), "beta"), { checked: true });
  f.click(m.select);
  expect(f.save).toHaveBeenLastCalledWith([alpha, beta].map(({ id, digest }) => ({ id, digest })));
  change(control(f.render(), "alpha"), { checked: false });
  f.click(m.select);
  expect(f.save).toHaveBeenLastCalledWith([{ id: beta.id, digest: beta.digest }]);
  change(control(f.render(), "beta"), { checked: true });
  f.click(m.select);
  expect(f.save).toHaveBeenLastCalledWith([{ id: beta.id, digest: beta.digest }]);
  hooks.values = [];
  const full = fixture(
    "didactic",
    Array.from({ length: 64 }, (_, i) => ({
      id: entry(`item-${String(i)}`).id,
      digest: alpha.digest,
    })),
  );
  expect(
    full.render().find((node) => node.type === "button" && text(node) === m.select)?.props.disabled,
  ).toBe(false);
});
