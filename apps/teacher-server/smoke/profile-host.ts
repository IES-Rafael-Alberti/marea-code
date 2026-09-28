import { syntheticHostPost } from "./synthetic-host-http.fixture.js";
import { syntheticProfileHostServices } from "../src/platform/teacher-host/profile-host-options.fixture.js";
import assert from "node:assert/strict";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "../src/platform/teacher-host/teacher-host.fixture.js";
import { startTeacherHost } from "../src/platform/teacher-host/teacher-host.js";
import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";
import { release, schemas } from "../src/dashboard-profiles/release.fixture.js";

const f = teacherHostInstallation();
f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });
initializeSqliteStorage({ databasePath: f.databasePath, schema: "dashboard-profiles" }).close();
let revision = 0;
const host = await startTeacherHost({
  installationRoot: f.root,
  releaseId: "release:host",
  serve: bunServe,
  ...syntheticProfileHostServices(() => `profile-${String(++revision)}`),
});
try {
  assert.equal(host.state, "ready");
  const post = syntheticHostPost(host.url);
  const login = await post("/v1/auth/login", {
    protocolVersion: "0.1",
    requestId: "login",
    kind: "credential-login",
    credentials: { login: "teacher", password: "teacher-password" },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const envelope = { protocolVersion: "0.1", requestId: "profile", scope: { kind: "teacher" } };
  const save = {
    ...envelope,
    kind: "dashboard-profile-save",
    catalogRevision: release.revision,
    expectedRevision: null,
    expectedPersonalRevision: null,
    discardUnavailable: false,
    value: release.defaults,
  };
  assert.equal(
    (await post("/api/v1/dashboard/profiles/read", { ...envelope, kind: "dashboard-profile-read" }))
      .status,
    401,
  );
  const saved = await post("/api/v1/dashboard/profiles/save", save, cookie);
  assert.equal(saved.status, 200);
  assert.equal(schemas.state.parse(await saved.json()).personal.revision, "profile-1");
  assert.equal((await post("/api/v1/dashboard/profiles/save", save, cookie)).status, 409);
  const read = await post(
    "/api/v1/dashboard/profiles/read",
    { ...envelope, kind: "dashboard-profile-read" },
    cookie,
  );
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(schemas.state.parse(await read.json()).personal.value, release.defaults);
  console.log("Compiled profile host: authenticated save/readback/conflict passed.");
} finally {
  if (host.state === "ready") await host.stop();
  cleanupTeacherHostInstallations();
}
