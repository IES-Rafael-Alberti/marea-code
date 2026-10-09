import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { previewChannelSchema, repositoryName } from "./preview-channel.ts";

const branch = "marea-preview-channel";
export function githubJson(repository, endpoint, method = "GET", input, allowMissing = false) {
  repositoryName.parse(repository);
  const args = ["api", "--method", method, `repos/${repository}/${endpoint}`];
  if (input !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  if (result.status !== 0) {
    if (allowMissing && result.stdout.includes('"status":"404"')) return undefined;
    const reason = result.error?.code ?? `exit ${String(result.status)}`;
    throw new Error(`GitHub channel request failed: ${endpoint} (${reason})`);
  }
  return JSON.parse(result.stdout);
}
function decoded(record) {
  if (record.encoding !== "base64") throw new Error("Unsupported channel encoding");
  const bytes = Buffer.from(record.content, "base64");
  if (bytes.length > 65_536) throw new Error("Preview channel exceeds size limit");
  return previewChannelSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/** The file SHA is a compare-and-swap token; concurrent promotions cannot overwrite each other. */
export function updatePreviewChannel(repository, message, transform) {
  const ref = githubJson(repository, `git/ref/heads/${branch}`, "GET", undefined, true);
  const file =
    ref === undefined
      ? undefined
      : githubJson(repository, `contents/preview.json?ref=${ref.object.sha}`);
  const previous = file === undefined ? undefined : decoded(file);
  const next = previewChannelSchema.parse(transform(previous));
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  const content = JSON.stringify(next, null, 2) + "\n";
  if (Buffer.byteLength(content) > 65_536) throw new Error("Preview channel exceeds size limit");
  if (file === undefined) {
    // One metadata-only orphan branch; never adopt or overwrite an existing source branch.
    const tree = githubJson(repository, "git/trees", "POST", {
      tree: [{ path: "preview.json", mode: "100644", type: "blob", content }],
    });
    const commit = githubJson(repository, "git/commits", "POST", {
      message,
      tree: tree.sha,
      parents: [],
    });
    githubJson(repository, "git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  } else {
    githubJson(repository, "contents/preview.json", "PUT", {
      message,
      branch,
      sha: file.sha,
      content: Buffer.from(content).toString("base64"),
    });
  }
  const saved = decoded(githubJson(repository, `contents/preview.json?ref=${branch}`));
  if (JSON.stringify(saved) !== JSON.stringify(next))
    throw new Error("Preview channel readback failed");
}
