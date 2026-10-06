"""Read-only verification of every asset in an already published native preview."""

import hashlib
import json
import pathlib
import re
import subprocess
import sys

repository, version, directory, verifier = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
    raise ValueError("Invalid repository")
if not re.fullmatch(r"\d+\.\d+\.\d+-preview\.\d+", version):
    raise ValueError("Invalid preview version")
tag = "v" + version
root = pathlib.Path(directory)


def gh(*arguments):
    return json.loads(subprocess.check_output(["gh", *arguments]))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


release = gh("api", f"repos/{repository}/releases/tags/{tag}")
require(release["prerelease"] and not release["draft"], "Not a published prerelease")
require(release["tag_name"] == tag, "Wrong release tag")
pages = gh(
    "api",
    f"repos/{repository}/releases/{release['id']}/assets?per_page=100",
    "--paginate",
    "--slurp",
)
assets = {asset["name"]: asset for page in pages for asset in page}
require(len(assets) == sum(map(len, pages)), "Duplicate release assets")
require({path.name for path in root.iterdir()} == set(assets), "Download inventory differs")
for name, asset in assets.items():
    path = root / name
    require(path.is_file() and not path.is_symlink(), "Nonregular download")
    require(asset["digest"] == "sha256:" + digest(path), f"Download checksum mismatch: {name}")

matrix = {
    "student-darwin-arm64", "server-darwin-arm64", "student-linux-x64",
    "server-linux-x64", "student-linux-arm64", "student-win32-x64",
    "server-win32-x64", "student-win32-arm64",
}
identity = f"https://github.com/{repository}/.github/workflows/native-release-candidate.yml@refs/tags/{tag}"
commit = subprocess.check_output(["git", "rev-parse", f"{tag}^{{commit}}"], text=True).strip()
expected = {"install.sh", "install.ps1"}
for key in sorted(matrix):
    name = key + ".manifest.json"
    signature = name + ".sigstore.json"
    expected.update((name, signature))
    subprocess.run([
        verifier, "verify-blob", "--bundle", str(root / signature),
        "--certificate-identity", identity, "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com", str(root / name),
    ], check=True)
    manifest = json.loads((root / name).read_text())
    require(manifest["version"] == version and manifest["commit"] == commit, "Wrong source")
    require(manifest["component"] + "-" + manifest["target"] == key, "Wrong native target")
    for file in manifest["files"]:
        checksum = file["sha256"]
        require(re.fullmatch(r"[0-9a-f]{64}", checksum), "Invalid signed checksum")
        asset_name = "sha256-" + checksum
        expected.add(asset_name)
        require(assets[asset_name]["digest"] == "sha256:" + checksum, "Signed checksum mismatch")
require(set(assets) == expected, "Signed inventory differs from published assets")
subprocess.run(["sh", "-n", str(root / "install.sh")], check=True)
print(f"Verified {len(matrix)} signatures and all {len(assets)} published assets for {tag}")
