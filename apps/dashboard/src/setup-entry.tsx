import "./browser-schema-config.js";
import { createRoot } from "react-dom/client";
import { selectLocale } from "@marea/i18n";
import { createSetupClient } from "./setup/client.boundary.js";
import { SetupWizard } from "./setup/wizard.js";
import { setupMessages } from "./setup/messages.js";
import "./styles.css";
import "./modules/server-settings/settings.css";
import "./setup/setup.css";

const root = document.getElementById("root");
const locale = selectLocale(navigator.languages);
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (root !== null) {
  createRoot(root).render(
    token && /^[A-Za-z0-9_-]{43}$/.test(token) ? (
      <SetupWizard
        initialLocale={locale}
        client={createSetupClient(token, fetch)}
        openDashboard={(url) => {
          location.replace(url);
        }}
      />
    ) : (
      <main className="shell">
        <h1>Marea Code</h1>
        <p role="alert">{setupMessages(locale).token}</p>
      </main>
    ),
  );
}
