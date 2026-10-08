import { useEffect, useState } from "react";
import type { DashboardLocale } from "../messages.js";
import type { EditableSettings } from "../modules/server-settings/client.boundary.js";
import { validateForm, showFieldValidity } from "../forms/validation.js";
import { SetupFeatures } from "./features.js";
import { SetupModel, isSetupModelReady } from "./model.js";
import { SetupReview } from "./review.js";
import { initialModelRoute } from "../modules/server-settings/model-settings.js";
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
    addresses?: string[];
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
          const [provider, ...others] = value.settings.providers;
          const single = provider !== undefined && others.length === 0;
          setConfiguration({
            settings:
              single && value.settings.route === null
                ? { ...value.settings, route: initialModelRoute(provider.id) }
                : value.settings,
            identityProviders: value.identityProviders,
            addresses: value.addresses ?? [],
          });
          if (single) setConnections({ [provider.id]: {} });
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
  const modelReady =
    configuration !== null && isSetupModelReady(route, configuration.settings.providers, catalogs);
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
    if (step < 4) {
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
        <h1>{[m.title, ...m.steps.slice(1)][step]}</h1>
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
            if (!busy && validateForm(event.currentTarget)) submit();
          }}
          aria-busy={busy}
          noValidate
          onInvalid={(event) => {
            event.preventDefault();
            if (event.target instanceof HTMLInputElement) showFieldValidity(event.target);
          }}
        >
          <fieldset disabled={busy}>
            <legend className="sr-only">{m.steps[step]}</legend>
            {step === 0 && (
              <SchoolFields
                value={details}
                change={setDetails}
                confirmation={confirmation}
                confirm={setConfirmation}
                m={m}
                locale={locale}
              />
            )}
            {step === 1 && (
              <SetupModel
                settings={configuration.settings}
                connections={connections}
                changeConnections={setConnections}
                edit={(settings) => {
                  setConfiguration({ ...configuration, settings });
                }}
                locale={locale}
                catalogs={catalogs}
                refresh={refresh}
              />
            )}
            {step === 2 && (
              <>
                <AccessFields
                  value={details}
                  change={setDetails}
                  m={m}
                  addresses={configuration.addresses}
                />
                <IdentityFields
                  providers={configuration.identityProviders}
                  values={identityProviders}
                  change={setIdentityProviders}
                  locale={locale}
                  m={m}
                />
              </>
            )}
            {step === 3 && <SetupFeatures value={details} change={setDetails} m={m} />}
            {step === 4 && (
              <SetupReview value={details} model={route?.model ?? ""} m={m} edit={setStep} />
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
              {step === 3 && (
                <button
                  type="button"
                  onClick={() => {
                    setDetails({
                      ...details,
                      testingSkill: false,
                      features: { map: false, reports: false, automaticEvaluation: false },
                    });
                    setStep(4);
                  }}
                >
                  {m.skip}
                </button>
              )}
              <button type="submit">{step === 4 ? m.finish : m.next}</button>
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
