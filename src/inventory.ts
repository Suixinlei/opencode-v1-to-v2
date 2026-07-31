import { stat } from "node:fs/promises";
import {
  listLegacySessionIds,
  listSessionIds,
  readDatabaseChecks,
  readSchemaFingerprint,
  readSessionSourceSnapshot,
  readV2SessionSemanticDigest,
  resolveDatabasePath,
} from "./sqlite-source";
import { sha256File } from "./files";

const LEGACY_MESSAGE_ROLES = new Set(["user", "assistant"]);
const LEGACY_PART_TYPES = new Set([
  "agent",
  "compaction",
  "file",
  "patch",
  "reasoning",
  "retry",
  "snapshot",
  "step-finish",
  "step-start",
  "subtask",
  "text",
  "tool",
]);
const LEGACY_TOOL_STATES = new Set([
  "completed",
  "error",
  "pending",
  "running",
]);
const DURABLE_EVENT_TYPES = new Set([
  "message.part.removed.1",
  "message.part.updated.1",
  "message.removed.1",
  "message.updated.1",
  "session.created.1",
  "session.next.agent.switched.1",
  "session.next.model.switched.1",
  "session.next.prompted.1",
  "session.next.reasoning.ended.1",
  "session.next.reasoning.started.1",
  "session.next.retried.1",
  "session.next.step.ended.2",
  "session.next.step.failed.2",
  "session.next.step.started.1",
  "session.next.synthetic.1",
  "session.next.text.ended.1",
  "session.next.text.started.1",
  "session.next.tool.called.1",
  "session.next.tool.failed.1",
  "session.next.tool.input.ended.1",
  "session.next.tool.input.started.1",
  "session.next.tool.success.1",
  "session.updated.1",
]);

function frequency(
  values: readonly (string | undefined)[],
  allowed?: ReadonlySet<string>,
): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    const key =
      value === undefined
        ? "<missing>"
        : allowed && !allowed.has(value)
          ? "<unknown>"
          : value;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function projectionClass(
  snapshot: ReturnType<typeof readSessionSourceSnapshot>,
): "legacy-only" | "legacy-and-v2" | "v2-only" | "neither" {
  const hasLegacy =
    snapshot.messages.length > 0 || snapshot.parts.length > 0;
  const hasV2 =
    snapshot.v2MessageCount > 0 ||
    snapshot.v2InputCount > 0 ||
    snapshot.contextEpochCount > 0 ||
    snapshot.events.some((event) =>
      event.type.startsWith("session.next."),
    );
  if (hasLegacy && hasV2) return "legacy-and-v2";
  if (hasLegacy) return "legacy-only";
  if (hasV2) return "v2-only";
  return "neither";
}

export async function inventoryDatabase(input: {
  databasePath: string;
  sessionIds?: readonly string[];
  runId: string;
}): Promise<Record<string, unknown>> {
  const database = resolveDatabasePath(input.databasePath);
  const allSessionIds = listSessionIds(database);
  const legacySessionIds = listLegacySessionIds(database);
  const selected = [...(input.sessionIds ?? legacySessionIds)].sort();
  const selectedSet = new Set(selected);
  const allSnapshots = new Map(
    allSessionIds.map((sessionId) => [
      sessionId,
      readSessionSourceSnapshot(database, sessionId),
    ]),
  );
  const sessions = selected.map((sessionId) => {
    const snapshot = allSnapshots.get(sessionId);
    if (!snapshot) throw new Error(`Session not found: ${sessionId}`);
    return {
      sessionId,
      version: snapshot.session.version,
      projectionClass: projectionClass(snapshot),
      legacyMessages: snapshot.messages.length,
      legacyParts: snapshot.parts.length,
      legacyMessageRoles: frequency(
        snapshot.messages.map((message) =>
          typeof message.data.role === "string" ? message.data.role : undefined,
        ),
        LEGACY_MESSAGE_ROLES,
      ),
      legacyPartTypes: frequency(
        snapshot.parts.map((part) =>
          typeof part.data.type === "string" ? part.data.type : undefined,
        ),
        LEGACY_PART_TYPES,
      ),
      legacyToolStates: frequency(
        snapshot.parts
          .filter((part) => part.data.type === "tool")
          .map((part) => {
            const state =
              part.data.state &&
              typeof part.data.state === "object" &&
              !Array.isArray(part.data.state)
                ? (part.data.state as Record<string, unknown>)
                : undefined;
            return typeof state?.status === "string"
              ? state.status
              : undefined;
          }),
        LEGACY_TOOL_STATES,
      ),
      durableEvents: snapshot.events.length,
      durableEventTypes: frequency(
        snapshot.events.map((event) => event.type),
        DURABLE_EVENT_TYPES,
      ),
      eventSequence: snapshot.sequence?.seq ?? null,
      eventOwned: snapshot.sequence?.ownerId !== undefined,
      v2Messages: snapshot.v2MessageCount,
      v2Inputs: snapshot.v2InputCount,
      v2DurableEvents: snapshot.events.filter((event) =>
        event.type.startsWith("session.next."),
      ).length,
      pendingV2Inputs: snapshot.pendingV2InputCount,
      contextEpochs: snapshot.contextEpochCount,
      hasActiveRevert: snapshot.session.revert !== undefined,
    };
  });
  const protectedV2Sessions = allSessionIds
    .filter((sessionId) => !selectedSet.has(sessionId))
    .flatMap((sessionId) => {
      const snapshot = allSnapshots.get(sessionId)!;
      const kind = projectionClass(snapshot);
      if (kind !== "v2-only" && kind !== "legacy-and-v2") {
        return [];
      }
      return [
        {
          sessionId,
          projectionClass: kind,
          legacyMessages: snapshot.messages.length,
          legacyParts: snapshot.parts.length,
          messages: snapshot.v2MessageCount,
          inputs: snapshot.v2InputCount,
          pendingInputs: snapshot.pendingV2InputCount,
          contextEpochs: snapshot.contextEpochCount,
          semanticDigest: readV2SessionSemanticDigest(database, sessionId),
        },
      ];
    });
  const checks = readDatabaseChecks(database);
  return {
    schemaVersion: 1,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    database: {
      path: database,
      size: (await stat(database)).size,
      sha256: await sha256File(database),
      schemaFingerprint: readSchemaFingerprint(database),
      quickCheck: checks.quickCheck,
      foreignKeyViolationCount: checks.foreignKeyViolations.length,
    },
    counts: {
      allSessions: allSessionIds.length,
      legacySessions: legacySessionIds.length,
      selectedSessions: selected.length,
      protectedV2Sessions: protectedV2Sessions.length,
      projectionClasses: frequency(
        allSessionIds.map((sessionId) =>
          projectionClass(allSnapshots.get(sessionId)!),
        ),
      ),
    },
    sessions,
    protectedV2Sessions,
  };
}
