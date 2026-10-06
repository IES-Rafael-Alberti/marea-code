import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { recommendPreview } from "./preview-recommend.ts";
import { updatePreviewChannel } from "./preview-channel-store.mjs";
import { previewVersion, repositoryName } from "./preview-channel.ts";

const [repository, version, directory, verifier, selected] = process.argv.slice(2);
repositoryName.parse(repository);
previewVersion.parse(version);
if (!["student", "server", "both"].includes(selected))
  throw new Error("Choose student, server or both");
function run(command, args, input) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
  return result.stdout;
}
// Promotion always verifies every published asset and its immutable workflow/tag signature first.
run("python3", ["scripts/release/verify-published.py", repository, version, directory, verifier]);
const api = (path) => JSON.parse(run("gh", ["api", path]));
// A signature is emitted before some native acceptance steps. Require the successful publishing run as well.
const commit = run("git", ["rev-parse", `v${version}^{commit}`]).trim();
const runs = api(
  `repos/${repository}/actions/workflows/native-release-candidate.yml/runs?head_sha=${commit}&status=success&per_page=100`,
).workflow_runs;
const publishedWithGates = runs.some((candidate) => {
  if (candidate.head_sha !== commit || candidate.conclusion !== "success") return false;
  const jobs = api(`repos/${repository}/actions/runs/${candidate.id}/jobs?per_page=100`).jobs;
  return jobs.some((job) => job.name === "publish" && job.conclusion === "success");
});
if (!publishedWithGates)
  throw new Error("No successful native publication workflow for this exact source");
const inventories = [];
for (const component of selected === "both" ? ["student", "server"] : [selected]) {
  const targets =
    component === "student"
      ? ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]
      : ["darwin-arm64", "linux-x64", "win32-x64"];
  const compatibility = targets.map((target) => {
    const manifest = JSON.parse(
      readFileSync(join(directory, `${component}-${target}.manifest.json`), "utf8"),
    );
    const metadata = manifest.files.find((file) => file.path === "compatibility.json");
    if (!metadata) throw new Error("This release predates protocol-aware recommendations");
    return JSON.parse(readFileSync(join(directory, `sha256-${metadata.sha256}`), "utf8"));
  });
  inventories.push({ component, compatibility });
}
updatePreviewChannel(repository, `Recommend preview ${version} for ${selected}`, (previous) => {
  let channel = previous;
  for (const { component, compatibility } of inventories)
    channel = recommendPreview(channel, version, component, compatibility);
  return channel;
});
process.stdout.write(`Recommended v${version} for ${selected}; published releases unchanged.\n`);
