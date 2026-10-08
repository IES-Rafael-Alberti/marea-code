import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { tree, text } from "../modules/server-settings/forms.fixture.js";
import { SecretInput, SecretTextarea } from "./secret-input.js";
import { ProviderHelp } from "./provider-help.js";
import { showFieldValidity, validateForm } from "./validation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
it("keeps secret values local, preserves multiline keys and toggles visibility without submitting", () => {
  class Input {
    type = "password";
  }
  vi.stubGlobal("HTMLInputElement", Input);
  const input = new Input();
  const setProperty = vi.fn();
  const textarea = { style: { setProperty } };
  for (const component of [
    <SecretInput locale="en" label="Token" value="new-value" />,
    <SecretTextarea locale="en" label="Key" value={"line1\nline2"} saved />,
  ]) {
    expect(renderToStaticMarkup(component)).toMatchSnapshot();
    const nodes = tree(component);
    expect(nodes.find((n) => n.type === "button")?.props.type).toBe("button");
    expect(nodes.find((n) => n.type === "input" || n.type === "textarea")?.props.value).toBe(
      nodes.some((node) => node.type === "textarea") ? "line1\nline2" : "new-value",
    );
    const click = nodes.find((n) => n.type === "button")?.props.onClick as (event: object) => void;
    let pressed = "false";
    const setAttribute = vi.fn((_name: string, value: string) => {
      pressed = value;
    });
    for (const control of [input, textarea]) {
      const button = {
        parentElement: { querySelector: vi.fn(() => control) },
        getAttribute: vi.fn(() => pressed),
        setAttribute,
      };
      click({ currentTarget: button });
      expect(button.parentElement.querySelector).toHaveBeenCalledWith("input, textarea");
      expect(button.getAttribute).toHaveBeenCalledWith("aria-pressed");
      expect(setAttribute).toHaveBeenLastCalledWith("aria-pressed", "true");
      expect(pressed).toBe("true");
      if (control === input) expect(input.type).toBe("text");
      else expect(setProperty).toHaveBeenLastCalledWith("-webkit-text-security", "none");
      click({ currentTarget: button });
      expect(pressed).toBe("false");
      if (control === input) expect(input.type).toBe("password");
      else expect(setProperty).toHaveBeenLastCalledWith("-webkit-text-security", "disc");
    }
    click({ currentTarget: { parentElement: null } });
    click({ currentTarget: { parentElement: { querySelector: () => null } } });
  }
});
it("renders localized visibility and saved-key controls without stored values", () => {
  for (const locale of ["es", "en", "eu"] as const) {
    const node = <SecretInput label="API" locale={locale} value="" saved required={false} />;
    const html = renderToStaticMarkup(node);
    expect(html).toMatchSnapshot(locale);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).not.toContain("required");
    expect(tree(node).some((n) => n.type === "summary" && text(n).length > 0)).toBe(true);
  }
});
it("places localized browser constraint feedback beside its field and clears corrected errors", () => {
  const message = { textContent: "" };
  const setAttribute = vi.fn();
  const querySelector = vi.fn(() => message);
  const input = {
    dataset: {},
    validity: { valid: false },
    validationMessage: "Too short",
    setAttribute,
    closest: vi.fn(() => ({ querySelector })),
  };
  showFieldValidity(input as never);
  expect(input.closest).toHaveBeenCalledWith("label");
  expect(querySelector).toHaveBeenCalledWith(".field-error");
  expect(input.dataset).toEqual({ touched: "true" });
  expect(setAttribute).toHaveBeenLastCalledWith("aria-invalid", "true");
  expect(message.textContent).toBe("⚠ Too short");
  input.validity.valid = true;
  showFieldValidity(input as never);
  expect(setAttribute).toHaveBeenLastCalledWith("aria-invalid", "false");
  expect(message.textContent).toBe("");
  for (const closest of [() => null, () => ({ querySelector: () => null })])
    showFieldValidity({ ...input, closest } as never);
});
it("reveals all form errors and focuses an input rather than its invalid fieldset", () => {
  const focus = vi.fn();
  const querySelector = vi.fn(() => ({ focus }));
  const checkValidity = vi.fn(() => false);
  const form = { checkValidity, querySelector };
  expect(validateForm(form as never)).toBe(false);
  expect(querySelector).toHaveBeenCalledWith("input:invalid, select:invalid, textarea:invalid");
  expect(focus).toHaveBeenCalledOnce();
  checkValidity.mockReturnValue(true);
  expect(validateForm(form as never)).toBe(true);
  expect(focus).toHaveBeenCalledOnce();
  expect(
    validateForm({
      checkValidity: () => false,
      querySelector: () => null,
    } as never),
  ).toBe(false);
});
it("renders plugin help only when present and keeps links separate from ordinary steps", () => {
  expect(renderToStaticMarkup(<ProviderHelp guides={undefined} locale="en" />)).toBe("");
  const label = { es: "Ayuda", en: "Help", eu: "Laguntza" };
  const guides = [
    {
      id: "test",
      title: label,
      steps: [{ text: label }, { text: label, href: "https://example.test/help" }],
    },
  ];
  for (const locale of ["es", "en", "eu"] as const) {
    expect(renderToStaticMarkup(<ProviderHelp guides={guides} locale={locale} />)).toMatchSnapshot(
      `help ${locale}`,
    );
    const nodes = tree(<ProviderHelp guides={guides} locale={locale} />);
    expect(nodes.find((n) => n.type === "summary")?.props.children).toBe(label[locale]);
    expect(nodes.filter((n) => n.type === "li")).toHaveLength(2);
    expect(nodes.find((n) => n.type === "a")?.props).toMatchObject({
      href: "https://example.test/help",
      target: "_blank",
      rel: "noreferrer",
    });
  }
});
