import type { ComponentPropsWithRef } from "react";
import { CredentialLoginSchema, RevisionIdSchema, SafeDisplayNameSchema } from "@marea/protocol";
import { showFieldValidity } from "./validation.js";

const schemas = { name: SafeDisplayNameSchema, login: CredentialLoginSchema, id: RevisionIdSchema };

/** Native form validation uses the same parser as the request boundary. */
export function SchemaInput({
  kind,
  message,
  ...props
}: ComponentPropsWithRef<"input"> & {
  kind: keyof typeof schemas;
  message: string;
}) {
  const validate = (input: HTMLInputElement) => {
    input.setCustomValidity(schemas[kind].safeParse(input.value).success ? "" : message);
  };
  return (
    <>
      <input
        {...props}
        required
        ref={(input) => {
          if (!input) return;
          validate(input);
          if (input.dataset.touched) showFieldValidity(input);
        }}
        onInput={(event) => {
          validate(event.currentTarget);
          showFieldValidity(event.currentTarget);
        }}
        onBlur={(event) => {
          showFieldValidity(event.currentTarget);
        }}
      />
      <span className="field-error" aria-live="polite" />
    </>
  );
}
