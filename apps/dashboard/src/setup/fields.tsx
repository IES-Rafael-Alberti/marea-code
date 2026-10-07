import type { ServerSetupRequest } from "@marea/protocol";
import type { setupMessages } from "./messages.js";

export type SetupDetails = Omit<ServerSetupRequest, "route" | "connections" | "identityProviders">;
type Copy = ReturnType<typeof setupMessages>;

export function SchoolFields({
  value,
  change,
  confirmation,
  confirm,
  m,
}: {
  value: SetupDetails;
  change: (next: SetupDetails) => void;
  confirmation: string;
  confirm: (text: string) => void;
  m: Copy;
}) {
  return (
    <div className="setup-grid">
      {(["center", "classroom", "teacher", "login"] as const).map((key) => (
        <label key={key}>
          {m[key]}
          <input
            required
            value={value[key]}
            maxLength={key === "login" ? 64 : 120}
            minLength={key === "login" ? 3 : 1}
            pattern={key === "login" ? "[a-z0-9][a-z0-9._-]*" : undefined}
            autoComplete={key === "login" ? "username" : "off"}
            onChange={(event) => {
              change({ ...value, [key]: event.currentTarget.value });
            }}
          />
        </label>
      ))}
      <label>
        {m.password}
        <input
          required
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          value={value.password}
          onChange={(event) => {
            change({ ...value, password: event.currentTarget.value });
          }}
        />
      </label>
      <label>
        {m.confirmation}
        <input
          required
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          value={confirmation}
          onChange={(event) => {
            confirm(event.currentTarget.value);
          }}
        />
      </label>
      <p>{m.passwordHelp}</p>
    </div>
  );
}

export function AccessFields({
  value,
  change,
  m,
}: {
  value: SetupDetails;
  change: (next: SetupDetails) => void;
  m: Copy;
}) {
  return (
    <>
      <fieldset>
        <legend>{m.network}</legend>
        {(["local", "lan", "https"] as const).map((access) => (
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
        <p>{m.networkHelp}</p>
      </fieldset>
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
      <label className="setup-choice">
        <input
          type="checkbox"
          checked={value.testingSkill}
          onChange={(event) => {
            change({ ...value, testingSkill: event.currentTarget.checked });
          }}
        />
        {m.testing}
      </label>
    </>
  );
}
