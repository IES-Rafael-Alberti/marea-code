import type { ProviderSettingsDescriptor } from "@marea/plugin-api";
import type { DashboardLocale } from "../messages.js";
import type { setupMessages } from "./messages.js";

type Values = Record<string, string>;
type Field = ProviderSettingsDescriptor["fields"][number];

/** Identity-specific names, fields and defaults belong to the installed plugin. */
export function IdentityFields({
  providers,
  values,
  change,
  locale,
  m,
}: {
  providers: readonly { id: string; descriptor: ProviderSettingsDescriptor }[];
  values: Record<string, Values>;
  change: (next: Record<string, Values>) => void;
  locale: DashboardLocale;
  m: ReturnType<typeof setupMessages>;
}) {
  if (providers.length === 0) return null;
  return (
    <fieldset>
      <legend>{m.identities}</legend>
      <p>{m.identityHelp}</p>
      {providers.map(({ id, descriptor }) => {
        const selected = values[id];
        const edit = (fields: Values | undefined) => {
          const next = { ...values };
          if (fields === undefined) Reflect.deleteProperty(next, id);
          else next[id] = fields;
          change(next);
        };
        const fields = (required: boolean, current: Values) =>
          descriptor.fields
            .filter((field) => field.required === required)
            .map((field) => (
              <IdentityField
                key={field.key}
                field={field}
                locale={locale}
                value={current[field.key] ?? field.defaultValue ?? ""}
                change={(value) => {
                  const next = { ...current };
                  if (value === "") Reflect.deleteProperty(next, field.key);
                  else next[field.key] = value;
                  edit(next);
                }}
              />
            ));
        return (
          <div key={id}>
            <label className="setup-choice">
              <input
                type="checkbox"
                checked={selected !== undefined}
                onChange={(event) => {
                  edit(event.currentTarget.checked ? {} : undefined);
                }}
              />
              {descriptor.name[locale]}
            </label>
            {selected !== undefined && (
              <div className="setup-grid">
                {fields(true, selected)}
                {descriptor.fields.some((field) => !field.required) && (
                  <details>
                    <summary>{m.advanced}</summary>
                    {fields(false, selected)}
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

function IdentityField({
  field,
  value,
  change,
  locale,
}: {
  field: Field;
  value: string;
  change: (value: string) => void;
  locale: DashboardLocale;
}) {
  const common = { required: field.required, autoComplete: "off", maxLength: 16_384, value };
  return (
    <label>
      {field.label[locale]}
      {field.multiline ? (
        <textarea
          {...common}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        />
      ) : (
        <input
          {...common}
          type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        />
      )}
    </label>
  );
}
