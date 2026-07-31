import {
  MIGRATION_RECIPE_ID,
  MIGRATION_TARGET_PROFILE,
  type MigrationPlan,
  type PersistedMigrationPlan,
  type SessionMigrationPlan,
} from "./contracts";
import { buildSessionMigrationPlan } from "./recipe-v1-to-v2";
import {
  listLegacySessionIds,
  listSessionIds,
  readSchemaFingerprint,
  readSessionSourceSnapshot,
  readV2SessionSemanticDigest,
  resolveDatabasePath,
} from "./sqlite-source";
import { sha256 } from "./stable";

export interface BuildMigrationPlanInput {
  databasePath: string;
  sessionIds?: readonly string[];
}

function planDigest(input: {
  sourceSchemaFingerprint: string;
  sessions: readonly SessionMigrationPlan[];
  protectedSessions: readonly {
    sessionId: string;
    kind: "legacy" | "v2";
    semanticDigest: string;
  }[];
}): string {
  return sha256({
    schemaVersion: 1,
    recipeId: MIGRATION_RECIPE_ID,
    targetProfile: MIGRATION_TARGET_PROFILE,
    sourceSchemaFingerprint: input.sourceSchemaFingerprint,
    sessions: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      state: session.state === "resumable" ? "eligible" : session.state,
      sourceVersion: session.sourceVersion,
      sourceDigest: session.sourceDigest,
      sourceSessionImmutableDigest: session.sourceSessionImmutableDigest,
      baseSeq: session.baseSeq,
      targetLastSeq: session.targetLastSeq,
      generatedEventDigest: sha256(session.events),
      expectedSessionStateDigest: session.expectedSessionStateDigest,
      targetSemanticDigest: session.targetSemanticDigest,
      diagnostics: session.diagnostics,
    })),
    protectedSessions: input.protectedSessions,
  });
}

export function buildMigrationPlan(
  input: BuildMigrationPlanInput,
): MigrationPlan {
  const sourceDatabase = resolveDatabasePath(input.databasePath);
  const sourceSchemaFingerprint = readSchemaFingerprint(sourceDatabase);
  const selectedIds = [
    ...(input.sessionIds ?? listLegacySessionIds(sourceDatabase)),
  ].sort();
  const selected = new Set(selectedIds);
  const sessions = selectedIds.map((sessionId) =>
    buildSessionMigrationPlan(
      readSessionSourceSnapshot(sourceDatabase, sessionId),
    ),
  );

  const protectedSessions = listSessionIds(sourceDatabase)
    .filter((sessionId) => !selected.has(sessionId))
    .map((sessionId) => {
      const snapshot = readSessionSourceSnapshot(sourceDatabase, sessionId);
      const hasV2State =
        snapshot.v2MessageCount > 0 ||
        snapshot.v2InputCount > 0 ||
        snapshot.contextEpochCount > 0 ||
        snapshot.events.some((event) =>
          event.type.startsWith("session.next."),
        );
      return {
        sessionId,
        kind: hasV2State ? ("v2" as const) : ("legacy" as const),
        semanticDigest: hasV2State
          ? readV2SessionSemanticDigest(sourceDatabase, sessionId)
          : sha256(snapshot),
      };
    });

  return {
    schemaVersion: 1,
    recipeId: MIGRATION_RECIPE_ID,
    targetProfile: MIGRATION_TARGET_PROFILE,
    sourceDatabase,
    sourceSchemaFingerprint,
    planDigest: planDigest({
      sourceSchemaFingerprint,
      sessions,
      protectedSessions,
    }),
    createdAt: new Date().toISOString(),
    sessions,
    protectedSessions,
  };
}

export function persistablePlan(
  plan: MigrationPlan,
  runId: string,
): PersistedMigrationPlan {
  return {
    schemaVersion: 1,
    recipeId: plan.recipeId,
    targetProfile: plan.targetProfile,
    runId,
    sourceDatabase: plan.sourceDatabase,
    sourceSchemaFingerprint: plan.sourceSchemaFingerprint,
    planDigest: plan.planDigest,
    createdAt: plan.createdAt,
    sessions: plan.sessions.map((session) => ({
      sessionId: session.sessionId,
      state: session.state,
      sourceVersion: session.sourceVersion,
      sourceDigest: session.sourceDigest,
      sourceSessionImmutableDigest: session.sourceSessionImmutableDigest,
      baseSeq: session.baseSeq,
      currentSeq: session.currentSeq,
      targetLastSeq: session.targetLastSeq,
      existingReplayPrefix: session.existingReplayPrefix,
      sourceMessageCount: session.sourceMessageCount,
      sourcePartCount: session.sourcePartCount,
      generatedEventCount: session.events.length,
      generatedEventDigest: sha256(session.events),
      targetMessageCount: session.expectedMessages.length,
      targetInputCount: session.expectedInputs.length,
      expectedSessionStateDigest: session.expectedSessionStateDigest,
      targetSemanticDigest: session.targetSemanticDigest,
      diagnostics: session.diagnostics,
    })),
    protectedSessions: plan.protectedSessions,
  };
}

export function assertPlanStillCurrent(
  persisted: PersistedMigrationPlan,
  current: MigrationPlan,
): void {
  if (persisted.recipeId !== current.recipeId) {
    throw new Error("PLAN_STALE: recipe changed");
  }
  if (persisted.targetProfile !== current.targetProfile) {
    throw new Error("PLAN_STALE: target profile changed");
  }
  if (persisted.sourceSchemaFingerprint !== current.sourceSchemaFingerprint) {
    throw new Error("PLAN_STALE: source schema changed");
  }
  if (persisted.planDigest !== current.planDigest) {
    throw new Error("PLAN_STALE: source content or target plan changed");
  }
}
