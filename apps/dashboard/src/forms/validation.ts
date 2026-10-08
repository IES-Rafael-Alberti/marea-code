/** Use the browser's localized constraint messages beside the field, including on blur. */
export function showFieldValidity(input: HTMLInputElement): void {
  input.dataset.touched = "true";
  const invalid = !input.validity.valid;
  input.setAttribute("aria-invalid", String(invalid));
  const message = input.closest("label")?.querySelector<HTMLElement>(".field-error");
  if (message) message.textContent = invalid ? `⚠ ${input.validationMessage}` : "";
}

/** Suppress the browser tooltip, reveal all errors and focus the first affected field. */
export function validateForm(form: HTMLFormElement): boolean {
  const valid = form.checkValidity();
  if (!valid)
    form.querySelector<HTMLElement>("input:invalid, select:invalid, textarea:invalid")?.focus();
  return valid;
}
