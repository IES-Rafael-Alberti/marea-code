import type { ProviderSettingsDescriptor } from "@marea/plugin-api";
import type { DashboardLocale } from "../messages.js";

/** Plugins supply their own instructions; the host only renders safe, validated links. */
export function ProviderHelp({
  guides,
  locale,
}: {
  guides: ProviderSettingsDescriptor["guides"];
  locale: DashboardLocale;
}) {
  return (
    <>
      {guides?.map((guide) => (
        <details key={guide.id} className="provider-help">
          <summary>{guide.title[locale]}</summary>
          <GuideSteps steps={guide.steps} locale={locale} />
        </details>
      ))}
    </>
  );
}

export function GuideSteps({
  steps,
  locale,
}: {
  steps: NonNullable<ProviderSettingsDescriptor["guides"]>[number]["steps"];
  locale: DashboardLocale;
}) {
  return (
    <ol>
      {steps.map((step, index) => (
        <li key={index}>
          {step.href ? (
            <a href={step.href} target="_blank" rel="noreferrer">
              {step.text[locale]}
            </a>
          ) : (
            step.text[locale]
          )}
        </li>
      ))}
    </ol>
  );
}
