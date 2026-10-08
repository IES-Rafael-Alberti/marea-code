import { Fragment } from "react";
import type { ServerSetupRequest } from "@marea/protocol";
import { SecretInput } from "../forms/secret-input.js";
import { showFieldValidity } from "../forms/validation.js";
import type { DashboardLocale } from "../messages.js";
import type { setupMessages } from "./messages.js";

export type SetupDetails = Omit<ServerSetupRequest, "route" | "connections" | "identityProviders">;
type Copy = ReturnType<typeof setupMessages>;

export function SchoolFields({
  value,
  change,
  confirmation,
  confirm,
  m,
  locale,
}: {
  locale: DashboardLocale;
  value: SetupDetails;
  change: (next: SetupDetails) => void;
  confirmation: string;
  confirm: (text: string) => void;
  m: Copy;
}) {
  return (
    <div
      className="setup-grid"
      onBlur={(event) => {
        if (event.target instanceof HTMLInputElement) showFieldValidity(event.target);
      }}
    >
      <h2 className="form-group-title">{m.school}</h2>
      {(["center", "classroom", "teacher", "login"] as const).map((key) => (
        <Fragment key={key}>
          {key === "teacher" && <h2 className="form-group-title">{m.account}</h2>}
          <label>
            {m[key]}
            <input
              required
              aria-describedby={`setup-${key}-error`}
              ref={(input) => {
                if (input?.dataset.touched) showFieldValidity(input);
              }}
              value={value[key]}
              maxLength={key === "login" ? 64 : 120}
              minLength={key === "login" ? 3 : 1}
              pattern={key === "login" ? "[a-z0-9][a-z0-9._-]*" : undefined}
              autoComplete={key === "login" ? "username" : "off"}
              onChange={(event) => {
                change({ ...value, [key]: event.currentTarget.value });
              }}
            />
            <span id={`setup-${key}-error`} className="field-error" aria-live="polite" />
          </label>
        </Fragment>
      ))}
      {(["password", "confirmation"] as const).map((key) => {
        const text = key === "password" ? value.password : confirmation;
        const error =
          key === "password"
            ? text.length < 12 || text.length > 256
              ? m.passwordHelp
              : ""
            : text !== value.password
              ? m.mismatch
              : "";
        return (
          <label key={key}>
            {m[key]}
            <SecretInput
              label={m[key]}
              locale={locale}
              required
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              value={text}
              aria-describedby={`setup-${key}-error`}
              ref={(input) => {
                if (!input) return;
                input.setCustomValidity(error);
                if (input.dataset.touched) showFieldValidity(input);
              }}
              onChange={(event) => {
                if (key === "password") change({ ...value, password: event.currentTarget.value });
                else confirm(event.currentTarget.value);
              }}
            />
            <span id={`setup-${key}-error`} className="field-error" aria-live="polite" />
          </label>
        );
      })}
    </div>
  );
}

export function AccessFields({
  addresses = [],
  value,
  change,
  m,
}: {
  value: SetupDetails;
  change: (next: SetupDetails) => void;
  m: Copy;
  addresses?: readonly string[] | undefined;
}) {
  return (
    <>
      <fieldset>
        <legend>{m.network}</legend>
        {(["lan", "local", "https"] as const).map((access) => (
          <label className="setup-choice" key={access}>
            <input
              type="radio"
              name="access"
              value={access}
              checked={value.access === access}
              onChange={() => {
                change({ ...value, access });
              }}
            />
            {m[access]}
          </label>
        ))}
        {value.access === "lan" && (
          <div className="setup-address">
            {addresses.length === 0 ? (
              <p role="status">{m.noAddress}</p>
            ) : (
              <div>
                <p>{m.address}</p>
                {addresses.map((address) => (
                  <p key={address}>
                    <code>
                      http://{address}:{value.port}
                    </code>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        <p className="server-help">{m.networkHelp}</p>
      </fieldset>
      <details className="connection-options">
        <summary>{m.connectionOptions}</summary>
        <label>
          {m.port}
          <input
            required
            type="number"
            min={1024}
            max={65535}
            value={value.port}
            onChange={(event) => {
              change({ ...value, port: Number(event.currentTarget.value) });
            }}
          />
        </label>
      </details>
      {value.access === "https" && (
        <label>
          {m.origin}
          <input
            required
            type="url"
            pattern="https://.*"
            value={value.publicOrigin}
            placeholder="https://marea.example.edu"
            onChange={(event) => {
              change({ ...value, publicOrigin: event.currentTarget.value });
            }}
          />
        </label>
      )}
    </>
  );
}
