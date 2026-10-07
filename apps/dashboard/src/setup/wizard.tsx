import { useEffect, useState } from "react";
import type { DashboardLocale } from "../messages.js";
import type { EditableSettings } from "../modules/server-settings/client.boundary.js";
import { ProviderConnections } from "../modules/server-settings/provider-connections.js";
import { ModelSettings } from "../modules/server-settings/model-settings.js";
import { useProviderModels } from "../modules/server-settings/provider-models.boundary.js";
import { AccessFields, SchoolFields, type SetupDetails } from "./fields.js";
import { IdentityFields } from "./identity-fields.js";
import type { SetupClient } from "./client.boundary.js";
import { setupMessages } from "./messages.js";

export function SetupWizard({
  client,
  initialLocale,
  openDashboard,
}: {
  client: SetupClient;
  initialLocale: DashboardLocale;
  openDashboard: (url: string) => void;
}) {
  const [locale, setLocale] = useState(initialLocale);
  const m = setupMessages(locale);
  const [step, setStep] = useState(0);
  const [configuration, setConfiguration] = useState<{
    settings: EditableSettings;
    identityProviders: Awaited<ReturnType<SetupClient["read"]>>["identityProviders"];
  } | null>(null);
  const [connections, setConnections] = useState<Record<string, Record<string, string>>>({});
  const [details, setDetails] = useState<SetupDetails>({
    center: "",
    classroom: "",
    teacher: "",
    login: "profe",
    password: "",
    port: 18787,
    access: "lan",
    publicOrigin: "",
    testingSkill: false,
  });
  const [confirmation, setConfirmation] = useState("");
  const [identityProviders, setIdentityProviders] = useState<
    Record<string, Record<string, string>>
  >({});
  const [error, setError] = useState<"error" | "mismatch" | "modelRequired" | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { catalogs, refresh } = useProviderModels(
    client.fetch,
    configuration?.settings ?? null,
    connections,
  );
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void client.read(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        if (value.settings.administrator) {
          setConfiguration({
            settings: value.settings,
            identityProviders: value.identityProviders,
          });
          const [provider, ...others] = value.settings.providers;
          if (provider !== undefined && others.length === 0) setConnections({ [provider.id]: {} });
        } else setError("error");
      },
      () => {
        if (!controller.signal.aborted) setError("error");
      },
    );
    return () => {
      controller.abort();
    };
  }, [client, attempt]);
  const route = configuration?.settings.route;
  const provider = configuration?.settings.providers.find(
    (entry) => entry.id === route?.providerId,
  );
  const modelReady =
    route &&
    provider &&
    (!provider.supportsModels || catalogs[route.providerId]?.status === "ready");
  const submit = () => {
    setError(null);
    if (step === 0 && confirmation !== details.password) {
      setError("mismatch");
      return;
    }
    if (step === 1 && !modelReady) {
      setError("modelRequired");
      return;
    }
    if (step < 3) {
      setStep(step + 1);
      return;
    }
    if (!modelReady) {
      setStep(1);
      setError("modelRequired");
      return;
    }
    setBusy(true);
    void client.finish({ ...details, connections, route, identityProviders }).then(
      (url) => {
        setReady(true);
        openDashboard(url);
      },
      () => {
        setError("error");
        setBusy(false);
      },
    );
  };
  return (
    <main className="shell setup-shell">
      <header className="masthead">
        <p className="eyebrow">Marea Code</p>
        <h1>{m.title}</h1>
        <p>{m.intro}</p>
        <label>
          {m.language}
          <select
            value={locale}
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "es" || value === "en" || value === "eu") setLocale(value);
            }}
          >
            <option value="es">Español</option>
            <option value="en">English</option>
            <option value="eu">Euskara</option>
          </select>
        </label>
      </header>
      <ol className="setup-steps">
        {m.steps.map((label, index) => (
          <li key={index} aria-current={index === step ? "step" : undefined}>
            {label}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{m[error]}</p>}
      {configuration === null ? (
        <p role="status">
          {error ? (
            <button
              onClick={() => {
                setAttempt(attempt + 1);
              }}
            >
              {m.retry}
            </button>
          ) : (
            m.loading
          )}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) submit();
          }}
          aria-busy={busy}
        >
          <fieldset disabled={busy}>
            <legend>{m.steps[step]}</legend>
            {step === 0 && (
              <SchoolFields
                value={details}
                change={setDetails}
                confirmation={confirmation}
                confirm={setConfirmation}
                m={m}
              />
            )}
            {step === 1 && (
              <div className="server-settings">
                <p>{m.modelHelp}</p>
                <ProviderConnections
                  state={configuration.settings}
                  connections={connections}
                  change={setConnections}
                  locale={locale}
                  catalogs={catalogs}
                  refresh={refresh}
                />
                <ModelSettings
                  state={configuration.settings}
                  connections={connections}
                  edit={(settings) => {
                    setConfiguration({ ...configuration, settings });
                  }}
                  locale={locale}
                  catalogs={catalogs}
                />
              </div>
            )}
            {step === 2 && (
              <>
                <AccessFields value={details} change={setDetails} m={m} />
                <IdentityFields
                  providers={configuration.identityProviders}
                  values={identityProviders}
                  change={setIdentityProviders}
                  locale={locale}
                  m={m}
                />
              </>
            )}
            {step === 3 && (
              <>
                <dl className="setup-review">
                  <dt>{m.center}</dt>
                  <dd>{details.center}</dd>
                  <dt>{m.classroom}</dt>
                  <dd>{details.classroom}</dd>
                  <dt>{m.teacher}</dt>
                  <dd>
                    {details.teacher} ({details.login})
                  </dd>
                  <dt>{m.steps[1]}</dt>
                  <dd>{configuration.settings.route?.model}</dd>
                  <dt>{m.network}</dt>
                  <dd>{m[details.access]}</dd>
                </dl>
                <p>{m.review}</p>
                <p>{m.optional}</p>
              </>
            )}
            <div className="setup-actions">
              {step > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStep(step - 1);
                  }}
                >
                  {m.back}
                </button>
              )}
              <button type="submit">{step === 3 ? m.finish : m.next}</button>
            </div>
          </fieldset>
          {busy && (
            <p role="status" className="setup-progress">
              {ready ? m.ready : m.saving}
            </p>
          )}
        </form>
      )}
    </main>
  );
}
