import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MigrationPlan,
  MigrationReceipt,
  PersistedMigrationPlan,
} from "./contracts";
import { replayDirectly } from "./direct-replay";
import { checkpointDatabase, cleanupLegacyProjections } from "./cleanup";
import {
  copyDatabaseBackup,
  sha256File,
  writeJsonSecure,
} from "./files";
import { replayWithPinnedOpenCode } from "./open-code-replay";
import {
  assertPlanStillCurrent,
  buildMigrationPlan,
  persistablePlan,
} from "./planner";
import { versionedType } from "./recipe-v1-to-v2";
import { sha256 } from "./stable";
import { verifyMigration } from "./verifier";

function selectedSessionIds(plan: PersistedMigrationPlan): string[] {
  return plan.sessions.map((session) => session.sessionId);
}

function assertDistinctDatabases(source: string, candidate: string): void {
  const sourcePath = resolve(source);
  const candidatePath = resolve(candidate);
  const samePath = sourcePath === candidatePath;
  const sameFile =
    existsSync(sourcePath) &&
    existsSync(candidatePath) &&
    (() => {
      const sourceStat = statSync(sourcePath);
      const candidateStat = statSync(candidatePath);
      return (
        sourceStat.dev === candidateStat.dev &&
        sourceStat.ino === candidateStat.ino
      );
    })();
  if (samePath || sameFile) {
    throw new Error(
      "SOURCE_CANDIDATE_COLLISION: candidate must not overwrite the backup",
    );
  }
}

async function createReceipt(input: {
  plan: MigrationPlan;
  sourceDatabase: string;
  legacyRowsRemoved: boolean;
  existingReplayPrefix?: ReadonlyMap<string, number>;
}): Promise<MigrationReceipt> {
  return {
    schemaVersion: 1,
    recipeId: input.plan.recipeId,
    targetProfile: input.plan.targetProfile,
    planDigest: input.plan.planDigest,
    sourceDatabase: resolve(input.sourceDatabase),
    backup: {
      path: resolve(input.sourceDatabase),
      sha256: await sha256File(input.sourceDatabase),
    },
    completedAt: new Date().toISOString(),
    sessions: input.plan.sessions
      .filter(
        (session) =>
          session.state === "eligible" || session.state === "resumable",
      )
      .map((session) => ({
        sessionId: session.sessionId,
        sourceDigest: session.sourceDigest,
        targetSemanticDigest: session.targetSemanticDigest,
        startSeq: session.baseSeq + 1,
        endSeq: session.targetLastSeq,
        appendedEvents: Math.max(
          0,
          session.events.length -
            (input.existingReplayPrefix?.get(session.sessionId) ??
              session.existingReplayPrefix),
        ),
        legacyRowsRemoved: input.legacyRowsRemoved,
      })),
  };
}

function assertMigratable(plan: PersistedMigrationPlan): void {
  const blocked = plan.sessions.filter((session) => session.state === "blocked");
  if (blocked.length > 0) {
    throw new Error(
      `PLAN_BLOCKED: ${blocked.map((session) => session.sessionId).join(", ")}`,
    );
  }
  const candidates = plan.sessions.filter(
    (session) =>
      session.state === "eligible" || session.state === "resumable",
  );
  if (candidates.length === 0) {
    throw new Error("PLAN_NOOP: no legacy session is eligible for migration");
  }
}

export async function migrateLocal(input: {
  sourceDatabase: string;
  candidateDatabase: string;
  persistedPlan: PersistedMigrationPlan;
  runDir: string;
  image?: string;
  stopAfterEvents?: number;
  directReplay?: boolean;
}): Promise<
  | {
      state: "interrupted";
      replayedAtMost: number;
    }
  | {
      state: "verified";
      receipt: MigrationReceipt;
    }
> {
  if (
    input.stopAfterEvents !== undefined &&
    (!Number.isInteger(input.stopAfterEvents) || input.stopAfterEvents < 0)
  ) {
    throw new Error(
      "INVALID_STOP_AFTER_EVENTS: expected a non-negative integer",
    );
  }
  if (input.directReplay && input.stopAfterEvents !== undefined) {
    throw new Error(
      "DIRECT_REPLAY_INTERRUPTION_UNSUPPORTED: stop-after-events is unavailable",
    );
  }
  assertDistinctDatabases(input.sourceDatabase, input.candidateDatabase);
  assertMigratable(input.persistedPlan);
  const sourcePlan = buildMigrationPlan({
    databasePath: input.sourceDatabase,
    sessionIds: selectedSessionIds(input.persistedPlan),
  });
  assertPlanStillCurrent(input.persistedPlan, sourcePlan);

  const candidate = resolve(input.candidateDatabase);
  if (!existsSync(candidate)) {
    await copyDatabaseBackup(input.sourceDatabase, candidate);
  }
  checkpointDatabase(candidate);
  const alreadyCleaned = verifyMigration(candidate, sourcePlan, {
    expectLegacyRemoved: true,
    allowContinuationSuffix: true,
  });
  if (alreadyCleaned.verified) {
    const receipt = await createReceipt({
      plan: sourcePlan,
      sourceDatabase: input.sourceDatabase,
      legacyRowsRemoved: true,
      existingReplayPrefix: new Map(
        sourcePlan.sessions.map((session) => [
          session.sessionId,
          session.events.length,
        ]),
      ),
    });
    await writeJsonSecure(resolve(input.runDir, "receipt.json"), receipt, {
      overwrite: true,
    });
    return { state: "verified", receipt };
  }

  const candidatePlan = buildMigrationPlan({
    databasePath: candidate,
    sessionIds: selectedSessionIds(input.persistedPlan),
  });
  assertPlanStillCurrent(input.persistedPlan, candidatePlan);

  if (input.directReplay) {
    const direct = replayDirectly(candidate, sourcePlan);
    checkpointDatabase(candidate);
    const verification = verifyMigration(candidate, sourcePlan);
    await writeJsonSecure(
      resolve(input.runDir, "verification.json"),
      verification,
      { overwrite: true },
    );
    if (!verification.verified) throw new Error("VERIFY_FAILED");
    const receipt = await createReceipt({
      plan: sourcePlan,
      sourceDatabase: input.sourceDatabase,
      legacyRowsRemoved: false,
      existingReplayPrefix: new Map(
        candidatePlan.sessions.map((session) => [
          session.sessionId,
          session.existingReplayPrefix,
        ]),
      ),
    });
    await writeJsonSecure(resolve(input.runDir, "receipt.json"), receipt, {
      overwrite: true,
    });
    await writeJsonSecure(
      resolve(input.runDir, "direct-replay.json"),
      {
        schemaVersion: 1,
        runId: input.persistedPlan.runId,
        ...direct,
      },
      { overwrite: true },
    );
    return { state: "verified", receipt };
  }

  const replay = await replayWithPinnedOpenCode({
    candidateDatabase: candidate,
    plan: sourcePlan,
    runId: input.persistedPlan.runId,
    image: input.image,
    stopAfterEvents: input.stopAfterEvents,
  });
  checkpointDatabase(candidate);

  if (replay.intentionallyInterrupted) {
    const report = {
      schemaVersion: 1,
      runId: input.persistedPlan.runId,
      planDigest: sourcePlan.planDigest,
      state: "interrupted",
      replayedAtMost: input.stopAfterEvents ?? 0,
      createdAt: new Date().toISOString(),
    };
    await writeJsonSecure(
      resolve(input.runDir, "interruption.json"),
      report,
      { overwrite: true },
    );
    return {
      state: "interrupted",
      replayedAtMost: input.stopAfterEvents ?? 0,
    };
  }

  const verification = verifyMigration(candidate, sourcePlan);
  await writeJsonSecure(
    resolve(input.runDir, "verification.json"),
    verification,
    { overwrite: true },
  );
  if (!verification.verified) {
    throw new Error("VERIFY_FAILED");
  }

  for (const smoke of replay.smoke) {
    const expected = sourcePlan.sessions.find(
      (session) => session.sessionId === smoke.sessionId,
    );
    const expectedMessages = expected?.expectedMessages.map((message) => ({
      id: message.id,
      type: message.type,
      ...message.data,
    }));
    const expectedHistory = expected?.events.map((event) => ({
      id: event.id,
      type: event.type,
      durable: {
        aggregateID: event.aggregateID,
        seq: event.seq,
        version: Number.parseInt(
          versionedType(event.type).split(".").at(-1) ?? "",
          10,
        ),
      },
      data: event.data,
    }));
    if (
      !expected ||
      smoke.messages !== expected.expectedMessages.length ||
      smoke.historyEvents !== expected.events.length ||
      smoke.contextMessages !== expected.expectedMessages.length ||
      smoke.messagesDigest !== sha256(expectedMessages) ||
      smoke.contextDigest !== sha256(expectedMessages) ||
      smoke.historyDigest !== sha256(expectedHistory)
    ) {
      throw new Error(`SMOKE_FAILED: ${smoke.sessionId}`);
    }
  }

  const receipt = await createReceipt({
    plan: sourcePlan,
    sourceDatabase: input.sourceDatabase,
    legacyRowsRemoved: false,
    existingReplayPrefix: new Map(
      candidatePlan.sessions.map((session) => [
        session.sessionId,
        session.existingReplayPrefix,
      ]),
    ),
  });
  await writeJsonSecure(resolve(input.runDir, "receipt.json"), receipt, {
    overwrite: true,
  });
  await writeJsonSecure(
    resolve(input.runDir, "official-replay.json"),
    {
      runId: input.persistedPlan.runId,
      image: replay.image,
      version: replay.version,
      smoke: replay.smoke,
    },
    { overwrite: true },
  );
  return { state: "verified", receipt };
}

export async function cleanupLocal(input: {
  sourceDatabase: string;
  candidateDatabase: string;
  persistedPlan: PersistedMigrationPlan;
  runDir: string;
}): Promise<MigrationReceipt> {
  assertDistinctDatabases(input.sourceDatabase, input.candidateDatabase);
  checkpointDatabase(input.candidateDatabase);
  const sourcePlan = buildMigrationPlan({
    databasePath: input.sourceDatabase,
    sessionIds: selectedSessionIds(input.persistedPlan),
  });
  assertPlanStillCurrent(input.persistedPlan, sourcePlan);
  const alreadyCleaned = verifyMigration(
    input.candidateDatabase,
    sourcePlan,
    {
      expectLegacyRemoved: true,
      allowContinuationSuffix: true,
    },
  );
  let result = {
    removedMessages: 0,
    removedParts: 0,
    sessions: 0,
  };
  if (!alreadyCleaned.verified) {
    result = cleanupLegacyProjections(
      input.candidateDatabase,
      sourcePlan,
    );
  }
  const verification = verifyMigration(input.candidateDatabase, sourcePlan, {
    expectLegacyRemoved: true,
    allowContinuationSuffix: true,
  });
  await writeJsonSecure(
    resolve(input.runDir, "cleanup-verification.json"),
    verification,
    { overwrite: true },
  );
  if (!verification.verified) throw new Error("CLEANUP_VERIFY_FAILED");

  const receipt = await createReceipt({
    plan: sourcePlan,
    sourceDatabase: input.sourceDatabase,
    legacyRowsRemoved: true,
    existingReplayPrefix: new Map(
      sourcePlan.sessions.map((session) => [
        session.sessionId,
        session.events.length,
      ]),
    ),
  });
  await writeJsonSecure(
    resolve(input.runDir, "cleanup-receipt.json"),
    {
      ...receipt,
      cleanup: result,
    },
    { overwrite: true },
  );
  return receipt;
}

export function rebuildPersistedPlan(input: {
  databasePath: string;
  sessionIds: readonly string[];
  runId: string;
}): PersistedMigrationPlan {
  return persistablePlan(
    buildMigrationPlan({
      databasePath: input.databasePath,
      sessionIds: input.sessionIds,
    }),
    input.runId,
  );
}
