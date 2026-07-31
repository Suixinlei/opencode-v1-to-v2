import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = resolve(root, "src/cli.ts");

async function runCli(args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("migration CLI", () => {
  for (const args of [[], ["--help"], ["-h"], ["inventory", "--help"]]) {
    test(`prints help without migration arguments: ${args.join(" ") || "<empty>"}`, async () => {
      const result = await runCli(args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("OpenCode V1 → V2 session migration");
      expect(result.stdout).toContain("inventory --database <db>");
      expect(result.stdout).toContain("--execute");
      expect(result.stdout).not.toContain("Missing --run-dir");
    });
  }
});
