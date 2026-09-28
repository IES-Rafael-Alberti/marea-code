/* global Buffer */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const AUTHORING = "/api/v1/dashboard/skill-authoring";
export const TEACHING = "/api/v1/dashboard/teaching";
let sequence = 0;
export const envelope = (kind, fields) => ({
  protocolVersion: "0.1",
  requestId: `request:browser-proof-${String(++sequence)}`,
  kind,
  ...fields,
});
export const skillText = (description) =>
  `---\nname: browser-journey\ndescription: ${description}\n---\n\nSynthetic lesson.\n`;
export const plainFiles = (bundle) => bundle.files.map(({ path, content }) => ({ path, content }));

export function proofSupport(context, page, root, baseUrl, expect) {
  const origin = new URL(baseUrl).origin;
  const requests = [];
  const errors = [];
  const rejectedResponses = [];
  const consoleErrors = [];
  const failedRequests = [];
  const receivedResponses = new Map();
  page.on("request", (request) => {
    if (request.method() === "POST")
      requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  page.on("response", (response) => {
    if (response.request().method() === "POST")
      receivedResponses.set(response.request().postDataJSON().requestId, response.status());
    if (response.status() >= 400)
      rejectedResponses.push([new URL(response.url()).pathname, response.status()]);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) =>
    failedRequests.push({
      path: new URL(request.url()).pathname,
      requestId: request.postDataJSON()?.requestId,
      error: request.failure()?.errorText,
    }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });

  async function api(path, value, expected = 200, client = context, headers = {}) {
    const response = await client.request.post(`${origin}${path}`, {
      data: value,
      headers: { origin, ...headers },
    });
    const text = await response.text();
    assert.equal(response.status(), expected, `${path}: ${text}`);
    return JSON.parse(text);
  }
  async function login(client, loginName) {
    return api(
      "/v1/auth/login",
      envelope("credential-login", {
        credentials: { login: loginName, password: "synthetic-password" },
      }),
      200,
      client,
    );
  }
  async function action(path, trigger, expected = 200) {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.request().method() === "POST",
    );
    await trigger();
    const response = await responsePromise;
    assert.equal(response.status(), expected);
    // Chromium can discard completed fetch bodies. Match the host's exact serialized
    // response by the UI request ID instead of issuing/replaying a mutation.
    const requestId = response.request().postDataJSON().requestId;
    const observations = (await readFile(join(root, "http-proof.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const matches = observations.filter(
      (item) => item.path === path && JSON.parse(item.requestText).requestId === requestId,
    );
    assert.equal(matches.length, 1, "exactly one host effect for this browser request");
    assert.equal(matches[0].status, expected);
    const value = JSON.parse(matches[0].responseText);
    assert.equal(value.requestId, requestId);
    return value;
  }
  async function idle(module) {
    await expect(module).toHaveAttribute("aria-busy", "false");
  }
  async function readSkill(slug = "browser-journey", classId = "class:one") {
    return (
      await api(
        `${AUTHORING}/read`,
        envelope("skill-authoring-read", { classId, target: { scope: "personal", slug } }),
      )
    ).skill;
  }
  async function readTeaching(classId = "class:one") {
    return (await api(`${TEACHING}/read`, envelope("teaching-configuration-query", { classId })))
      .configuration;
  }
  function storedTeaching(classId = "class:one") {
    // Independent on-disk SQLite handle, not the server service or its HTTP projection.
    const database = new DatabaseSync(join(root, "state.sqlite"), { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT configuration_json FROM marea_class_teaching_revisions r JOIN marea_current_class_teaching c ON c.revision_id = r.id WHERE c.class_id = ?",
        )
        .get(classId);
      return row === undefined ? null : JSON.parse(row.configuration_json);
    } finally {
      database.close();
    }
  }
  async function verifyBundle(bundle, expectedFiles) {
    assert.equal(bundle.id, `teacher/t1/${bundle.name}`);
    assert.equal(bundle.source, "teacher");
    assert.deepEqual(plainFiles(bundle), expectedFiles);
    const hash = createHash("sha256");
    for (const file of bundle.files) {
      const bytes = await readFile(join(root, "teacher", bundle.kind, bundle.name, file.path));
      assert.equal(bytes.toString("utf8"), file.content);
      assert.equal(bytes.length, file.sizeBytes);
      hash.update(file.path).update("\0").update(bytes).update("\0");
    }
    assert.equal(bundle.digest, `sha256:${hash.digest("hex")}`);
  }
  async function verifyTeaching(configuration, classId = "class:one") {
    assert.deepEqual(await readTeaching(classId), configuration);
    const stored = storedTeaching(classId);
    assert.equal(stored.content.configurationVersion, configuration.version);
    assert.deepEqual(stored.selection, configuration.settings.selection);
    assert.deepEqual(stored.classInstructions, configuration.settings.classInstructions);
    return stored;
  }
  async function draftFiles(module, files) {
    await expect(module.getByLabel("File text", { exact: true })).toHaveCount(files.length);
    for (let index = 0; index < files.length; index += 1) {
      await expect(module.getByLabel("Relative file path", { exact: true }).nth(index)).toHaveValue(
        files[index].path,
      );
      await expect(module.getByLabel("File text", { exact: true }).nth(index)).toHaveValue(
        files[index].content,
      );
    }
  }
  async function exportFile(module, label) {
    const pending = page.waitForEvent("download");
    await module.getByRole("button", { name: label, exact: true }).click();
    const download = await pending;
    const stream = await download.createReadStream();
    assert.notEqual(stream, null);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(await download.failure(), null);
    return {
      name: download.suggestedFilename(),
      mimeType: "text/plain",
      buffer: Buffer.concat(chunks),
    };
  }
  async function verifyErrors(expectedRejections) {
    assert.deepEqual(errors, [], "page errors, failed requests or unhandled rejections");
    // Controllers abort their previous signal before a new operation. Chromium can
    // report that cancellation even after the UI consumed the complete response.
    // Accept only ERR_ABORTED for a correlated, received HTTP response, never a
    // dropped/unobserved request or a different network error.
    const receipts = (await readFile(join(root, "http-proof.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const request of failedRequests) {
      assert.equal(request.error, "net::ERR_ABORTED", JSON.stringify(request));
      const status = receivedResponses.get(request.requestId);
      assert.equal(
        status === 200 ||
          expectedRejections.some(
            ([path, expectedStatus]) => request.path === path && status === expectedStatus,
          ),
        true,
        JSON.stringify(request),
      );
      const receipt = receipts.filter(
        (item) =>
          item.path === request.path &&
          JSON.parse(item.requestText).requestId === request.requestId,
      );
      assert.equal(receipt.length, 1);
      assert.equal(receipt[0].status, status);
      // An unrouted endpoint's 404 is not a protocol envelope and carries no request ID.
      if (status !== 404)
        assert.equal(JSON.parse(receipt[0].responseText).requestId, request.requestId);
    }
    // Chromium may request a favicon; only its exact 404 is optional.
    assert.deepEqual(
      rejectedResponses.filter(([path]) => path !== "/favicon.ico"),
      expectedRejections,
    );
    for (const entry of consoleErrors) {
      const path = new URL(entry.url).pathname;
      const matching = rejectedResponses.filter(
        ([candidate, status]) =>
          candidate === path &&
          entry.text ===
            `Failed to load resource: the server responded with a status of ${String(status)} (${status === 409 ? "Conflict" : "Not Found"})`,
      );
      assert.equal(matching.length > 0, true, `Unexpected console error: ${JSON.stringify(entry)}`);
    }
  }
  return {
    api,
    login,
    action,
    idle,
    readSkill,
    readTeaching,
    storedTeaching,
    verifyBundle,
    verifyTeaching,
    draftFiles,
    exportFile,
    verifyErrors,
    requests,
  };
}
