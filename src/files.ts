import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function createRunId(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

export async function ensurePrivateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await chmod(absolute, 0o700);
  return absolute;
}

export async function writeJsonSecure(
  path: string,
  value: unknown,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, options.overwrite ? "w" : "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function copyDatabaseBackup(
  source: string,
  destination: string,
): Promise<{
  source: string;
  destination: string;
  size: number;
  sha256: string;
}> {
  const absoluteSource = resolve(source);
  const absoluteDestination = resolve(destination);
  if (absoluteSource === absoluteDestination) {
    throw new Error("Candidate database must not overwrite the backup");
  }
  if (existsSync(absoluteDestination)) {
    throw new Error(`Candidate already exists: ${absoluteDestination}`);
  }
  const walPath = `${absoluteSource}-wal`;
  if (existsSync(walPath)) {
    const sidecar = await stat(walPath);
    if (sidecar.size > 0) {
      throw new Error(
        `Backup has non-empty ${basename(absoluteSource)}-wal; checkpoint it before copying`,
      );
    }
  }
  await ensurePrivateDirectory(dirname(absoluteDestination));
  await copyFile(absoluteSource, absoluteDestination);
  await chmod(absoluteDestination, 0o600);
  const destinationHandle = await open(absoluteDestination, "r+");
  try {
    await destinationHandle.sync();
  } finally {
    await destinationHandle.close();
  }
  const sourceDigest = await sha256File(absoluteSource);
  const destinationDigest = await sha256File(absoluteDestination);
  if (sourceDigest !== destinationDigest) {
    throw new Error("Candidate copy checksum differs from backup");
  }
  return {
    source: absoluteSource,
    destination: absoluteDestination,
    size: (await stat(absoluteDestination)).size,
    sha256: destinationDigest,
  };
}
