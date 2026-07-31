export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    allowFailure?: boolean;
    stdin?: string;
  } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error("Command stdin pipe was not created");
    stdin.write(options.stdin);
    stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && options.allowFailure !== true) {
    throw new Error(
      `Command failed (${exitCode}): ${command[0]} ${command
        .slice(1)
        .join(" ")}\n${stderr.trim()}`,
    );
  }
  return { stdout, stderr, exitCode };
}
