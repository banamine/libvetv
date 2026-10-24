import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonMaybe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeFileAtomic(path, content, options = {}) {
  const renameImpl = options.renameImpl || rename;
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await renameImpl(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeIfChangedAtomic(path, content, options = {}) {
  try {
    if ((await readFile(path, "utf8")) === content) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFileAtomic(path, content, options);
  return true;
}
