import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { checkpointDatabase } from "../src/cleanup";
import { proveContinuationLocal } from "../src/continuation-proof";
import { cleanupLocal, migrateLocal } from "../src/executor";
import {
  assertCompatibleOpenCodeImage,
  REQUIRED_OPENCODE_VERSION,
  resolvePinnedOpenCodeImage,
} from "../src/open-code-replay";
import { buildMigrationPlan, persistablePlan } from "../src/planner";
import { runCommand } from "../src/process";
import {
  FIXTURE_PROMPT,
  FIXTURE_SESSION_ID,
  seedLegacyFixture,
} from "../tests/helpers/fixture";

function usage(): never {
  throw new Error(
    "USAGE: bun scripts/verify-target-image.ts <repository@sha256:digest>",
  );
}

const image = resolvePinnedOpenCodeImage(process.argv[2] ?? usage());
const root = mkdtempSync(join(tmpdir(), "opencode-target-image-e2e-"));
const sourceDatabase = join(root, "source", "opencode.db");
const candidateDatabase = join(root, "candidate", "opencode.db");
const replayRunDir = join(root, "run", "replay");
const cleanupRunDir = join(root, "run", "cleanup");
const continuationRunDir = join(root, "run", "continuation");
const sentinelFile = join(root, "legacy-sentinel.txt");
const runId = "public-target-image-e2e";
const keepRun = process.env.KEEP_TARGET_IMAGE_RUN === "1";

async function initializeOpenCodeDatabase(): Promise<void> {
  mkdirSync(dirname(sourceDatabase), { recursive: true, mode: 0o700 });
  const name = `opencode-target-init-${process.pid}`.slice(0, 63);
  await runCommand(["docker", "rm", "-f", name], { allowFailure: true });
  await runCommand([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::4096",
    "--volume",
    `${dirname(sourceDatabase)}:/migration`,
    "--env",
    `OPENCODE_DB=/migration/${basename(sourceDatabase)}`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-lc",
    "exec opencode serve --hostname 0.0.0.0 --port 4096",
  ]);
  try {
    let port = "";
    const portDeadline = Date.now() + 30_000;
    while (Date.now() < portDeadline) {
      const result = await runCommand(
        ["docker", "port", name, "4096/tcp"],
        { allowFailure: true },
      );
      const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
      if (match?.[1]) {
        port = match[1];
        break;
      }
      await Bun.sleep(200);
    }
    if (!port) throw new Error("TARGET_IMAGE_INIT_PORT_TIMEOUT");

    const healthDeadline = Date.now() + 90_000;
    while (Date.now() < healthDeadline) {
      try {
        // Use the same bounded curl path as the production replay checks.
        // Bun fetch can wait indefinitely on some Docker Desktop loopback paths.
        const result = await runCommand(
          [
            "curl",
            "--silent",
            "--show-error",
            "--max-time",
            "5",
            `http://127.0.0.1:${port}/global/health`,
          ],
          { allowFailure: true },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr);
        const health = JSON.parse(result.stdout) as {
          healthy?: boolean;
          version?: string;
        };
        if (
          health.healthy === true &&
          health.version === REQUIRED_OPENCODE_VERSION
        ) {
          return;
        }
      } catch {
        // The server may not have bound the port yet.
      }
      await Bun.sleep(500);
    }
    throw new Error("TARGET_IMAGE_INIT_HEALTH_TIMEOUT");
  } finally {
    await runCommand(["docker", "stop", "--timeout", "10", name], {
      allowFailure: true,
    });
  }
}

try {
  for (const directory of [
    replayRunDir,
    cleanupRunDir,
    continuationRunDir,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  await assertCompatibleOpenCodeImage(image);
  await initializeOpenCodeDatabase();
  checkpointDatabase(sourceDatabase);
  seedLegacyFixture(sourceDatabase);
  checkpointDatabase(sourceDatabase);
  const plan = buildMigrationPlan({
    databasePath: sourceDatabase,
    sessionIds: [FIXTURE_SESSION_ID],
  });
  const persistedPlan = persistablePlan(plan, runId);

  const replay = await migrateLocal({
    sourceDatabase,
    candidateDatabase,
    persistedPlan,
    runDir: replayRunDir,
    image,
  });
  if (replay.state !== "verified") {
    throw new Error(`OFFICIAL_REPLAY_${replay.state.toUpperCase()}`);
  }

  await cleanupLocal({
    sourceDatabase,
    candidateDatabase,
    persistedPlan,
    runDir: cleanupRunDir,
  });

  writeFileSync(sentinelFile, `${FIXTURE_PROMPT}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(sentinelFile, 0o600);
  const continuation = await proveContinuationLocal({
    candidateDatabase,
    sessionId: FIXTURE_SESSION_ID,
    legacySentinelFile: sentinelFile,
    runDir: continuationRunDir,
    runId,
    image,
  });

  console.log(
    JSON.stringify(
      {
        targetProfile: plan.targetProfile,
        image,
        officialReplayVerified: true,
        cleanupVerified: true,
        continuation: {
          sameSession: continuation.sameSession,
          oldContextReachedModel: continuation.oldContextReachedModel,
          assistantWritePersisted: continuation.assistantWritePersisted,
          restartReadbackPassed: continuation.restartReadbackPassed,
          noNewSessionCreated: continuation.noNewSessionCreated,
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (keepRun) {
    console.error(`Target image verification files kept at ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}
