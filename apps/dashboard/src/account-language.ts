import type { LocalePreference } from "@marea/i18n";
import type { createAccountLanguageClient } from "./account-language-client.boundary.js";

/** Each login owns its requests. Late responses cannot change another account or overwrite edits. */
export class AccountLanguage {
  private connection: AbortController | null = null;
  private revision = Symbol();
  constructor(
    private readonly request: ReturnType<typeof createAccountLanguageClient>,
    private readonly changed: (
      preference: LocalePreference | null,
      warning: boolean,
      busy: boolean,
    ) => void,
  ) {}
  connect(): Promise<void> {
    this.disconnect();
    this.connection = new AbortController();
    return this.exchange(null);
  }
  disconnect(): void {
    this.connection?.abort();
    this.connection = null;
  }
  save(preference: LocalePreference): Promise<void> {
    return this.exchange(preference);
  }
  private async exchange(preference: LocalePreference | null): Promise<void> {
    const connection = this.connection;
    if (connection === null) return;
    const revision = Symbol();
    this.revision = revision;
    const current = () => !connection.signal.aborted && revision === this.revision;
    this.changed(null, false, true);
    try {
      const result = await this.request(preference, connection.signal);
      if (current()) this.changed(result, false, false);
    } catch {
      if (current()) this.changed(null, true, false);
    }
  }
}
