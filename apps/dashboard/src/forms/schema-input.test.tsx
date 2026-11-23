import { expect, it, vi } from "vitest";
import { tree } from "../modules/server-settings/forms.fixture.js";
import { SchemaInput } from "./schema-input.js";

it.each([
  ["name", " Ana María ", "Bad_name"],
  ["login", "ana.student-1", "Ana Student"],
  ["id", "class:one", "class/one"],
] as const)("validates %s on mount, input and blur", (kind, valid, invalid) => {
  const node = tree(<SchemaInput kind={kind} message="Fix this field" />).find(
    (n) => n.type === "input",
  );
  if (!node) throw new Error("Missing schema input");
  const input = {
    value: "",
    dataset: {} as Record<string, string>,
    setCustomValidity: vi.fn(),
    setAttribute: vi.fn(),
    validity: { valid: false },
    validationMessage: "Fix this field",
    closest: () => null,
  };
  input.value = invalid;
  const ref = node.props.ref as (element: typeof input | null) => void;
  const onInput = node.props.onInput as (event: object) => void;
  const onBlur = node.props.onBlur as (event: object) => void;
  ref(null);
  ref(input);
  expect(input.setCustomValidity).toHaveBeenLastCalledWith("Fix this field");
  expect(input.setAttribute).not.toHaveBeenCalled();
  onBlur({ currentTarget: input });
  expect(input.dataset.touched).toBe("true");
  input.setAttribute.mockClear();
  ref(input);
  expect(input.setAttribute).toHaveBeenLastCalledWith("aria-invalid", "true");
  input.value = valid;
  input.validity.valid = true;
  input.setAttribute.mockClear();
  onInput({ currentTarget: input });
  expect(input.setCustomValidity).toHaveBeenLastCalledWith("");
  expect(input.setAttribute).toHaveBeenLastCalledWith("aria-invalid", "false");
  input.value = invalid;
  onInput({ currentTarget: input });
  expect(input.setCustomValidity).toHaveBeenLastCalledWith("Fix this field");
});
