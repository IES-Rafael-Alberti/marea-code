import process from "node:process";
import { availablePreview, previewVersion, repositoryName } from "./preview-channel.ts";
import { githubJson, updatePreviewChannel } from "./preview-channel-store.mjs";

const [repository, version] = process.argv.slice(2);
repositoryName.parse(repository);
previewVersion.parse(version);
const release = githubJson(repository, `releases/tags/v${version}`);
if (release.tag_name !== `v${version}` || release.draft || !release.prerelease)
  throw new Error("Only a published preview can enter the available channel");
updatePreviewChannel(repository, `Publish available preview ${version}`, (previous) =>
  availablePreview(previous, version),
);
process.stdout.write(`Available preview ${version}; existing recommendations preserved.\n`);
