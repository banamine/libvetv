import { execFileSync } from "node:child_process";
import { appendFile, copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLISH_PATH = /^daily\/(latest\/[a-z0-9-]+\.(json|m3u)|latest\/index\.json|\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\/playlist\.(json|m3u))$/;

export function validateChangedPaths(text) {
  const paths = text.split(/\r?\n/).filter((path) => path !== "");
  if (paths.length === 0 || paths.length > 1000 || new Set(paths).size !== paths.length ||
      paths.some((path) => !PUBLISH_PATH.test(path))) throw new Error("publish_path_rejected");
  return paths;
}

async function rejectSymlinks(root, path, required) {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    try {
      const info = await lstat(resolve(root, ...parts.slice(0, i)));
      if (info.isSymbolicLink() || (i < parts.length ? !info.isDirectory() : !info.isFile())) {
        throw new Error("publish_file_rejected");
      }
    } catch (error) {
      if (error.code === "ENOENT" && !required) return;
      throw error;
    }
  }
}

export async function stageChanges({ root = process.cwd(), artifactDir = resolve(root, ".tmp/out"), git }) {
  const paths = validateChangedPaths(await readFile(resolve(artifactDir, "changed-files.txt"), "utf8"));
  // Validate everything before copying anything. Never traverse an artifact or destination symlink.
  for (const path of paths) {
    await rejectSymlinks(artifactDir, path, true);
    await rejectSymlinks(root, path, false);
  }
  if (git(["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("publish_checkout_dirty");
  for (const path of paths) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await copyFile(resolve(artifactDir, path), resolve(root, path));
  }
  git(["add", "--", ...paths]);
  const staged = git(["diff", "--cached", "--name-only"]).trim().split("\n").filter(Boolean);
  if (staged.length === 0) throw new Error("publish_no_staged_changes");
  if (staged.some((path) => !paths.includes(path) || !PUBLISH_PATH.test(path))) {
    throw new Error("publish_staged_path_rejected");
  }
  return staged;
}

async function main() {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const staged = await stageChanges({ git });
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  git(["commit", "-m", "chore: publish changed daily playlists"]);
  git(["push", "origin", "HEAD:main"]); // No force and no retries; reject concurrent main changes visibly.
  const sha = git(["rev-parse", "HEAD"]).trim();
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `commit_sha=${sha}\n`);
  console.log(`published_paths=${staged.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("publish_failed"); process.exitCode = 1; });
}
