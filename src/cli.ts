import { basename, resolve } from "node:path";
import type { PersistedMigrationPlan } from "./contracts";
import { proveContinuationLocal } from "./continuation-proof";
import { cleanupLocal, migrateLocal } from "./executor";
import {
  createRunId,
  ensurePrivateDirectory,
  readJson,
  writeJsonSecure,
} from "./files";
import { inventoryDatabase } from "./inventory";
import { proveContinuationLive } from "./live-continuation-proof";
import {
  buildMixedMigrationPlan,
  cleanupMixedLocal,
  migrateMixedLocal,
  persistableMixedPlan,
  type PersistedMixedMigrationPlan,
} from "./mixed-migration";
import { buildMigrationPlan, persistablePlan } from "./planner";

type Parsed = {
  command: string;
  values: Map<string, string[]>;
  flags: Set<string>;
};

function parse(argv: readonly string[]): Parsed {
  const command = argv[0] ?? "";
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    const list = values.get(key);
    if (list) list.push(next);
    else values.set(key, [next]);
    index++;
  }
  return { command, values, flags };
}

function value(parsed: Parsed, key: string, required = true): string | undefined {
  const result = parsed.values.get(key)?.at(-1);
  if (required && !result) throw new Error(`Missing --${key}`);
  return result;
}

function values(parsed: Parsed, key: string): string[] {
  return parsed.values.get(key) ?? [];
}

function requireExecute(parsed: Parsed): void {
  if (!parsed.flags.has("execute")) {
    throw new Error("Write operation requires --execute");
  }
}

function runIdFromDirectory(runDir: string): string {
  const name = basename(resolve(runDir));
  return name || createRunId();
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^([A-Z][A-Z0-9_]+)/);
  return match?.[1] ?? "MIGRATION_FAILED";
}

function usageText(): string {
  return [
    "OpenCode V1 → V2 session migration",
    "",
    "Usage:",
    "  inventory --database <db> --run-dir <dir> [--session <id>...]",
    "  mixed-inventory --database <db> --run-dir <dir> [--session <id>...]",
    "  migrate-local --database <backup> --candidate <db> --run-dir <dir> --plan <plan.json> [--image <name@sha256:digest>] [--stop-after-events <n> | --direct-replay] --execute",
    "  cleanup-local --database <backup> --candidate <db> --run-dir <dir> --plan <plan.json> --execute",
    "  mixed-migrate-local --database <backup> --candidate <db> --run-dir <dir> --plan <mixed-plan.json> --execute",
    "  mixed-cleanup-local --database <backup> --candidate <db> --run-dir <dir> --plan <mixed-plan.json> --execute",
    "  prove-continuation-local --database <candidate> --session <id> --sentinel-file <private-file> --image <name@sha256:digest> --run-dir <dir> --execute",
    "  prove-continuation-live --database <source-db> --session <id> --app-code <app> --user-id <user> --cookie-file <private-file> --runtime-base-url <url> --controller-base-url <url> --run-dir <dir> [--expect-legacy-removed] --execute",
    "",
    "Global options:",
    "  -h, --help  Show this help without reading or writing migration data",
    "  --image     Digest-pinned OpenCode image; alternatively set OPENCODE_MIGRATION_IMAGE",
  ].join("\n");
}

function usage(): never {
  throw new Error(usageText());
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (
    argv.length === 0 ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }
  const parsed = parse(argv);
  const runDir = await ensurePrivateDirectory(value(parsed, "run-dir")!);
  const runId = runIdFromDirectory(runDir);

  try {
    if (parsed.command === "inventory") {
      const database = value(parsed, "database")!;
      const sessionIds = values(parsed, "session");
      const inventory = await inventoryDatabase({
        databasePath: database,
        sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
        runId,
      });
      const plan = buildMigrationPlan({
        databasePath: database,
        sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
      });
      const persisted = persistablePlan(plan, runId);
      await writeJsonSecure(resolve(runDir, "inventory.json"), inventory);
      await writeJsonSecure(resolve(runDir, "plan.json"), persisted);
      process.stdout.write(
        `${JSON.stringify({
          runId,
          planDigest: persisted.planDigest,
          sessions: persisted.sessions.map((session) => ({
            sessionId: session.sessionId,
            state: session.state,
            messages: session.sourceMessageCount,
            parts: session.sourcePartCount,
            generatedEvents: session.generatedEventCount,
            blockingDiagnostics: session.diagnostics.filter(
              (diagnostic) => diagnostic.severity === "blocking",
            ).length,
          })),
        })}\n`,
      );
      return;
    }

    if (parsed.command === "mixed-inventory") {
      const database = value(parsed, "database")!;
      const sessionIds = values(parsed, "session");
      const plan = await buildMixedMigrationPlan({
        databasePath: database,
        sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
      });
      const persisted = persistableMixedPlan(plan, runId);
      await writeJsonSecure(resolve(runDir, "mixed-plan.json"), persisted);
      process.stdout.write(
        `${JSON.stringify({
          runId,
          planDigest: persisted.planDigest,
          sessions: persisted.sessions.map((session) => ({
            sessionId: session.sessionId,
            shape: session.shape,
            generatedEvents: session.generatedEventCount,
            shiftedExistingV2Rows: session.shiftedExistingV2Rows,
            sparseLegacyPrefix: session.sparseLegacyPrefix,
          })),
        })}\n`,
      );
      return;
    }

    if (parsed.command === "migrate-local") {
      requireExecute(parsed);
      const planPath = value(parsed, "plan")!;
      const persisted = await readJson<PersistedMigrationPlan>(planPath);
      if (parsed.flags.has("stop-after-events")) {
        throw new Error("Missing --stop-after-events value");
      }
      const stopAfter = value(parsed, "stop-after-events", false);
      const result = await migrateLocal({
        sourceDatabase: value(parsed, "database")!,
        candidateDatabase: value(parsed, "candidate")!,
        persistedPlan: persisted,
        runDir,
        image: value(parsed, "image", false),
        directReplay: parsed.flags.has("direct-replay"),
        ...(stopAfter === undefined
          ? {}
          : { stopAfterEvents: Number.parseInt(stopAfter, 10) }),
      });
      process.stdout.write(
        `${JSON.stringify({ runId: persisted.runId, state: result.state })}\n`,
      );
      return;
    }

    if (parsed.command === "mixed-migrate-local") {
      requireExecute(parsed);
      const persisted = await readJson<PersistedMixedMigrationPlan>(
        value(parsed, "plan")!,
      );
      const result = await migrateMixedLocal({
        sourceDatabase: value(parsed, "database")!,
        candidateDatabase: value(parsed, "candidate")!,
        persistedPlan: persisted,
        runDir,
      });
      process.stdout.write(
        `${JSON.stringify({
          runId: persisted.runId,
          state: "mixed-verified",
          sessions: result.sessions.map((session) => session.sessionId),
        })}\n`,
      );
      return;
    }

    if (parsed.command === "mixed-cleanup-local") {
      requireExecute(parsed);
      const persisted = await readJson<PersistedMixedMigrationPlan>(
        value(parsed, "plan")!,
      );
      const result = await cleanupMixedLocal({
        sourceDatabase: value(parsed, "database")!,
        candidateDatabase: value(parsed, "candidate")!,
        persistedPlan: persisted,
        runDir,
      });
      process.stdout.write(
        `${JSON.stringify({
          runId: persisted.runId,
          state: "mixed-cleaned",
          sessions: result.sessions.map((session) => session.sessionId),
        })}\n`,
      );
      return;
    }

    if (parsed.command === "cleanup-local") {
      requireExecute(parsed);
      const persisted = await readJson<PersistedMigrationPlan>(
        value(parsed, "plan")!,
      );
      const receipt = await cleanupLocal({
        sourceDatabase: value(parsed, "database")!,
        candidateDatabase: value(parsed, "candidate")!,
        persistedPlan: persisted,
        runDir,
      });
      process.stdout.write(
        `${JSON.stringify({
          runId: persisted.runId,
          state: "cleaned",
          sessions: receipt.sessions.map((session) => session.sessionId),
        })}\n`,
      );
      return;
    }

    if (parsed.command === "prove-continuation-local") {
      requireExecute(parsed);
      const receipt = await proveContinuationLocal({
        candidateDatabase: value(parsed, "database")!,
        sessionId: value(parsed, "session")!,
        legacySentinelFile: value(parsed, "sentinel-file")!,
        runDir,
        runId,
        image: value(parsed, "image", false),
      });
      process.stdout.write(
        `${JSON.stringify({
          runId,
          state: "proved",
          sessionId: receipt.sessionId,
          sameSession: receipt.sameSession,
          oldContextReachedModel: receipt.oldContextReachedModel,
          restartReadbackPassed: receipt.restartReadbackPassed,
        })}\n`,
      );
      return;
    }

    if (parsed.command === "prove-continuation-live") {
      requireExecute(parsed);
      const receipt = await proveContinuationLive({
        sourceDatabase: value(parsed, "database")!,
        sessionId: value(parsed, "session")!,
        appCode: value(parsed, "app-code")!,
        userId: value(parsed, "user-id")!,
        cookieFile: value(parsed, "cookie-file")!,
        runtimeBaseUrl: value(parsed, "runtime-base-url")!,
        controllerBaseUrl: value(parsed, "controller-base-url")!,
        runDir,
        expectLegacyRemoved:
          parsed.flags.has("expect-legacy-removed"),
      });
      process.stdout.write(
        `${JSON.stringify({
          runId,
          state: "proved-live",
          sessionId: receipt.sessionId,
          sameSession: receipt.sameSession,
          oldContextReachedModel: receipt.oldContextReachedModel,
          assistantWritePersisted: receipt.assistantWritePersisted,
          noNewSessionCreated: receipt.noNewSessionCreated,
          legacyRemovedAtProbe: receipt.legacyRemovedAtProbe,
        })}\n`,
      );
      return;
    }

    usage();
  } catch (error) {
    await writeJsonSecure(
      resolve(runDir, "failure.json"),
      {
        schemaVersion: 1,
        runId,
        command: parsed.command,
        code: errorCode(error),
        failedAt: new Date().toISOString(),
      },
      { overwrite: true },
    );
    throw error;
  }
}

await main();
