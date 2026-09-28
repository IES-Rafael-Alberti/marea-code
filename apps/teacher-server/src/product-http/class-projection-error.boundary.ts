import { TeacherDomainError } from "../identity/errors.js";
import { protocolError } from "./response.js";

/** Private projections share a closed public failure mapping, never exception text. */
export function classProjectionError(error: unknown): Response {
  if (error instanceof TeacherDomainError)
    return protocolError(
      error.code === "auth.invalid" ? 401 : 403,
      error.code === "auth.invalid" ? "auth.invalid" : "request.invalid",
      false,
    );
  return protocolError(500, "server.error", false);
}
