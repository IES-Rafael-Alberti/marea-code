import { ProviderHelp, GuideSteps } from "../forms/provider-help.js";
import { SecretInput, SecretTextarea } from "../forms/secret-input.js";
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
  secrets = {},
}: {
  secrets?: Readonly<Record<string, readonly string[]>>;
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
        const fields = (selectedFields: readonly Field[], current: Values) =>
          selectedFields.map((field) => (
            <IdentityField
              key={field.key}
              field={field}
              saved={secrets[id]?.includes(field.key) === true}
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
          <section key={id} className="identity-connection">
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
                <ProviderHelp
                  guides={descriptor.guides?.filter((guide) => guide.fields === undefined)}
                  locale={locale}
                />
                {fields(
                  descriptor.fields.filter((field) => field.required),
                  selected,
                )}
                <IdentityOptions
                  descriptor={descriptor}
                  locale={locale}
                  label={m.advanced}
                  clearLabel={m.clearOptional}
                  clear={(keys) => {
                    edit({ ...selected, ...Object.fromEntries(keys.map((key) => [key, ""])) });
                  }}
                  render={(entries) => fields(entries, selected)}
                />
              </div>
            )}
          </section>
        );
      })}
    </fieldset>
  );
}

function IdentityField({
  saved,
  field,
  value,
  change,
  locale,
}: {
  saved: boolean;
  field: Field;
  value: string;
  change: (value: string) => void;
  locale: DashboardLocale;
}) {
  const common = {
    required: field.required && !saved,
    autoComplete: "off",
    maxLength: 16_384,
    value,
  };
  return (
    <label>
      {field.label[locale]}
      {field.kind === "secret" && field.multiline ? (
        <SecretTextarea
          {...common}
          label={field.label[locale]}
          locale={locale}
          saved={saved}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        />
      ) : field.kind === "secret" ? (
        <SecretInput
          {...common}
          label={field.label[locale]}
          locale={locale}
          saved={saved}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        />
      ) : field.multiline ? (
        <textarea
          {...common}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        />
      ) : (
        <input
          {...common}
          type={field.kind === "url" ? "url" : "text"}
          onChange={(event) => {
            change(event.currentTarget.value);
          }}
        />
      )}
    </label>
  );
}

/** Optional field groups and their prerequisites are declared by the plugin. */
function IdentityOptions({
  descriptor,
  locale,
  label,
  clearLabel,
  clear,
  render,
}: {
  descriptor: ProviderSettingsDescriptor;
  locale: DashboardLocale;
  label: string;
  clearLabel: string;
  clear: (fields: readonly string[]) => void;
  render: (fields: readonly Field[]) => import("react").ReactNode;
}) {
  const groups = descriptor.guides?.flatMap(({ fields, ...guide }) =>
    fields === undefined ? [] : [{ ...guide, fields }],
  );
  const extra = descriptor.fields.filter(
    (field) => !field.required && !groups?.some((group) => group.fields.includes(field.key)),
  );
  return (
    <>
      {groups?.map((group) => (
        <details key={group.id} className="identity-options">
          <summary>{group.title[locale]}</summary>
          <GuideSteps steps={group.steps} locale={locale} />
          {render(descriptor.fields.filter((field) => group.fields.includes(field.key)))}
          <button
            type="button"
            onClick={() => {
              clear(group.fields);
            }}
          >
            {clearLabel}
          </button>
        </details>
      ))}
      {extra.length > 0 && (
        <details>
          <summary>{label}</summary>
          {render(extra)}
        </details>
      )}
    </>
  );
}
