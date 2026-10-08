import { showFieldValidity } from "../../forms/validation.js";
import { serverSections, type ServerSection } from "./sections.js";

/** Hidden sections retain their drafts, so reveal the first invalid field before focusing it. */
export function validateSettingsForm(
  form: HTMLFormElement,
  reveal: (section: ServerSection) => void,
): boolean {
  if (form.checkValidity()) return true;
  const field = form.querySelector<HTMLInputElement>(
    "input:invalid, select:invalid, textarea:invalid",
  );
  const owner = field?.closest("[data-settings-section]")?.getAttribute("data-settings-section");
  const section = serverSections.find((id) => id === owner);
  if (section) reveal(section);
  if (field) {
    let disclosure = field.closest("details");
    while (disclosure) {
      disclosure.open = true;
      disclosure = disclosure.parentElement?.closest("details") ?? null;
    }
    showFieldValidity(field);
    setTimeout(() => {
      field.focus();
    }, 0);
  }
  return false;
}
