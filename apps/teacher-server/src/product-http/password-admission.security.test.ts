import { describe, expect, it } from "vitest";
import { TeacherDomainError } from "../identity/errors.js";
import {
  BASE_URL,
  createApplication,
  createServices,
  enrollmentRequest,
  RecordingProvider,
} from "./product-http.fixture.js";

describe("password admission public errors", () => {
  it.each(["/v1/auth/login", "/v1/auth/enroll", "/api/v1/dashboard/session/login"])(
    "keeps %s busy failures generic and retryable",
    async (path) => {
      const services = createServices(new RecordingProvider());
      const busy = () => Promise.reject(new TeacherDomainError("auth.busy"));
      const app = createApplication({
        ...services,
        identity: { ...services.identity, login: busy, enroll: busy },
      });
      const body = path.endsWith("/enroll")
        ? enrollmentRequest
        : {
            kind: "credential-login",
            protocolVersion: "0.1",
            requestId: "request:login",
            credentials: { login: "synthetic", password: "synthetic-private-password" },
          };
      const response = await app.fetch(
        new Request(`${BASE_URL}${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            host: "teacher.test",
            origin: "https://dashboard.test",
          },
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({
        protocolVersion: "0.1",
        requestId: body.requestId,
        error: { code: "server.error", retryable: true },
      });
    },
  );
});
