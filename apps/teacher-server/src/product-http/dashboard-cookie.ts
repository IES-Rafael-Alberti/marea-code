import { TeacherDomainError } from "../identity/errors.js";

function hasSingleValue(values: readonly string[]): values is readonly [string] {
  return values.length === 1;
}

export function parseCookie(header: string | null, name: string): string {
  if (header === null || header.length > 8_192) throw new TeacherDomainError("auth.invalid");
  const prefix = `${name}=`;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (!hasSingleValue(matches)) throw new TeacherDomainError("auth.invalid");
  const token = matches[0].slice(prefix.length);
  if (token.length === 0 || /\s/u.test(token)) {
    throw new TeacherDomainError("auth.invalid");
  }
  return token;
}

export function dashboardCookie(name: string, token: string, secure: boolean, maxAge = ""): string {
  return `${name}=${token}; Path=/api/v1/dashboard;${maxAge} HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function validateCookieName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
    throw new TypeError("The dashboard cookie name is invalid.");
  }
  return name;
}
