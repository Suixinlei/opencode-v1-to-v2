import { Database } from "bun:sqlite";
import type { MigrationPlan } from "./contracts";
import { buildSessionMigrationPlan } from "./recipe-v1-to-v2";
import {
  readDatabaseChecks,
  readSessionSourceSnapshot,
  resolveDatabasePath,
} from "./sqlite-source";
import { verifyMigration } from "./verifier";

export function checkpointDatabase(databasePath: string): void {
  const database = new Database(resolveDatabasePath(databasePath), {
    strict: true,
  });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

export function cleanupLegacyProjections(
  databasePath: string,
  plan: MigrationPlan,
): {
  removedMessages: number;
  removedParts: number;
  sessions: number;
} {
  const alreadyCleaned = verifyMigration(databasePath, plan, {
    expectLegacyRemoved: true,
    allowContinuationSuffix: true,
  });
  if (alreadyCleaned.verified) {
    return {
      removedMessages: 0,
      removedParts: 0,
      sessions: 0,
    };
  }

  const before = verifyMigration(databasePath, plan, {
    allowContinuationSuffix: true,
  });
  if (!before.verified) {
    throw new Error("VERIFY_FAILED: refusing legacy cleanup");
  }
  for (const session of plan.sessions) {
    if (
      session.state !== "eligible" &&
      session.state !== "resumable"
    ) {
      continue;
    }
    const current = buildSessionMigrationPlan(
      readSessionSourceSnapshot(databasePath, session.sessionId),
    );
    if (
      current.sourceDigest !== session.sourceDigest ||
      current.sourceSessionImmutableDigest !==
        session.sourceSessionImmutableDigest
    ) {
      throw new Error(
        `SOURCE_DIVERGENCE: legacy source changed for ${session.sessionId}`,
      );
    }
  }
  const resolved = resolveDatabasePath(databasePath);
  const database = new Database(resolved, { strict: true });
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  let removedMessages = 0;
  let removedParts = 0;
  let sessions = 0;
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const session of plan.sessions) {
      if (
        session.state !== "eligible" &&
        session.state !== "resumable"
      ) {
        continue;
      }
      const partResult = database
        .query<never, [string]>("DELETE FROM part WHERE session_id = ?")
        .run(session.sessionId);
      const messageResult = database
        .query<never, [string]>("DELETE FROM message WHERE session_id = ?")
        .run(session.sessionId);
      database
        .query<never, [string]>(
          `UPDATE session
           SET version = '1.18.9',
               time_compacting = NULL
           WHERE id = ?`,
        )
        .run(session.sessionId);
      removedParts += partResult.changes;
      removedMessages += messageResult.changes;
      sessions++;
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  } finally {
    database.close();
  }

  checkpointDatabase(resolved);
  const after = verifyMigration(resolved, plan, {
    expectLegacyRemoved: true,
    allowContinuationSuffix: true,
  });
  if (!after.verified) {
    throw new Error("CLEANUP_VERIFY_FAILED");
  }
  const checks = readDatabaseChecks(resolved);
  if (
    checks.quickCheck.length !== 1 ||
    checks.quickCheck[0]?.toLowerCase() !== "ok" ||
    checks.foreignKeyViolations.length > 0
  ) {
    throw new Error("CLEANUP_INTEGRITY_FAILED");
  }
  return {
    removedMessages,
    removedParts,
    sessions,
  };
}
