import { afterEach, expect, it, vi } from "vitest";
import { validateSettingsForm } from "./form-validation.js";
afterEach(() => {
  vi.useRealTimers();
});
it("accepts a valid form and reveals the first invalid field before focusing it", () => {
  vi.useFakeTimers();
  const reveal = vi.fn();
  const getAttribute = vi.fn(() => "limits");
  const outer = { open: false, parentElement: null };
  const inner = { open: false, parentElement: { closest: vi.fn(() => outer) } };
  const field = {
    dataset: {},
    validity: { valid: false },
    validationMessage: "Required",
    closest: vi.fn((selector: string) => {
      if (selector === "[data-settings-section]") return { getAttribute };
      return selector === "details" ? inner : null;
    }),
    setAttribute: vi.fn(),
    focus: vi.fn(),
  };
  const querySelector = vi.fn(() => field);
  const form = { checkValidity: vi.fn(() => true), querySelector };
  expect(validateSettingsForm(form as never, reveal)).toBe(true);
  expect(querySelector).not.toHaveBeenCalled();
  form.checkValidity.mockReturnValue(false);
  expect(validateSettingsForm(form as never, reveal)).toBe(false);
  expect(querySelector).toHaveBeenCalledWith("input:invalid, select:invalid, textarea:invalid");
  expect(getAttribute).toHaveBeenCalledWith("data-settings-section");
  expect(reveal).toHaveBeenCalledExactlyOnceWith("limits");
  expect(inner.open).toBe(true);
  expect(outer.open).toBe(true);
  expect(inner.parentElement.closest).toHaveBeenCalledWith("details");
  expect(field.setAttribute).toHaveBeenCalledWith("aria-invalid", "true");
  expect(field.focus).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(field.focus).toHaveBeenCalledOnce();
});
it("keeps the current section when an invalid field has no section or is no longer mounted", () => {
  vi.useFakeTimers();
  const reveal = vi.fn();
  for (const closest of [
    () => null,
    (selector: string) =>
      selector === "[data-settings-section]" ? { getAttribute: () => "unknown" } : null,
  ]) {
    const field = {
      closest,
      dataset: {},
      validity: { valid: false },
      validationMessage: "Invalid",
      setAttribute: vi.fn(),
      focus: vi.fn(),
    };
    expect(
      validateSettingsForm(
        { checkValidity: () => false, querySelector: () => field } as never,
        reveal,
      ),
    ).toBe(false);
  }
  expect(
    validateSettingsForm(
      { checkValidity: () => false, querySelector: () => null } as never,
      reveal,
    ),
  ).toBe(false);
  expect(reveal).not.toHaveBeenCalled();
  vi.runAllTimers();
});
