import { constants, Database } from "bun:sqlite";
import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MIGRATION_RECIPE_ID,
  MIGRATION_TARGET_PROFILE,
  type ExpectedSessionInput,
  type ExpectedSessionMessage,
  type JsonObject,
  type SessionMigrationPlan,
} from "./contracts";
import { checkpointDatabase } from "./cleanup";
import {
  copyDatabaseBackup,
  sha256File,
  writeJsonSecure,
} from "./files";
import { projectReplayEvents } from "./projector";
import { versionedType, buildSessionMigrationPlan } from "./recipe-v1-to-v2";
import {
  readDatabaseChecks,
  readSchemaFingerprint,
  readSessionSourceSnapshot,
  resolveDatabasePath,
} from "./sqlite-source";
import { asObject, asString, sha256, stableJson } from "./stable";

export const MIXED_MIGRATION_RECIPE_ID =
  `${MIGRATION_RECIPE_ID}+mixed-splice@3` as const;

const LEGACY_EVENT_TYPES = new Set([
  "session.created.1",
  "session.updated.1",
  "message.updated.1",
  "message.removed.1",
  "message.part.updated.1",
  "message.part.removed.1",
]);

const SUPPORTED_V2_EVENT_TYPES = new Set([
  "session.next.agent.switched.1",
  "session.next.context.updated.1",
  "session.next.model.switched.1",
  "session.next.prompt.admitted.1",
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
]);

const ALLOWED_MIXED_DIAGNOSTICS = new Set([
  "CORRUPT_LEGACY_EVENTS:legacy and V2 durable events are interleaved",
  "MIXED_EVENT_DIVERGENCE:existing V2 event suffix is longer than the migration plan",
  "MIXED_EVENT_DIVERGENCE:V2 context epoch state exists and cannot be overwritten by a V1 migration",
]);

export type MixedSessionShape =
  | "bootstrap-v2-then-legacy"
  | "legacy-then-v2"
  | "v2-then-legacy-tail"
  | "v2-dual-write-cleanup";

interface EventRow {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: JsonObject;
}

interface SessionMessageRow {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: JsonObject;
}

interface SessionInputRow {
  id: string;
  session_id: string;
  prompt: JsonObject;
  delivery: string;
  admitted_seq: number;
  promoted_seq: number | null;
  time_created: number;
}

interface ContextEpochRow {
  session_id: string;
  baseline: string;
  snapshot: string;
  baseline_seq: number;
}

interface LegacyMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: JsonObject;
}

interface LegacyPartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: JsonObject;
}

interface SequenceRow {
  aggregate_id: string;
  seq: number;
  owner_id: string | null;
}

interface MixedSessionState {
  session: Record<string, unknown>;
  sequence: SequenceRow;
  events: EventRow[];
  legacyMessages: LegacyMessageRow[];
  legacyParts: LegacyPartRow[];
  messages: SessionMessageRow[];
  inputs: SessionInputRow[];
  contextEpochs: ContextEpochRow[];
}

interface MixedSessionPlan {
  sessionId: string;
  shape: MixedSessionShape;
  insertionSeq: number;
  shiftBy: number;
  sourceStateDigest: string;
  existingV2Digest: string;
  lowering: SessionMigrationPlan;
  sourceState: MixedSessionState;
  expectedMigratedState: MixedSessionState;
  expectedCleanedState: MixedSessionState;
  acceptedBlockingDiagnostics: readonly string[];
  historicalProjectionVariants: readonly HistoricalProjectionVariantCount[];
  sparseLegacyPrefix: boolean;
}

interface MixedMigrationPlan {
  sourceDatabase: string;
  sourceDatabaseSha256: string;
  sourceSchemaFingerprint: string;
  protectedDigest: string;
  planDigest: string;
  sessions: readonly MixedSessionPlan[];
}

export interface PersistedMixedSessionPlan {
  sessionId: string;
  shape: MixedSessionShape;
  insertionSeq: number;
  shiftedExistingV2Rows: boolean;
  generatedEventCount: number;
  generatedMessageCount: number;
  generatedInputCount: number;
  sourceLegacyMessageCount: number;
  sourceLegacyPartCount: number;
  sourceStateDigest: string;
  existingV2Digest: string;
  generatedEventDigest: string;
  expectedMigratedStateDigest: string;
  expectedCleanedStateDigest: string;
  acceptedBlockingDiagnostics: readonly string[];
  historicalProjectionVariants: readonly HistoricalProjectionVariantCount[];
  sparseLegacyPrefix: boolean;
}

type HistoricalProjectionVariant =
  | "reasoning-provider-metadata-null"
  | "reasoning-time-omitted"
  | "tool-output-paths-empty-omitted"
  | "tool-provider-false-omitted"
  | "tool-ran-omitted";

interface HistoricalProjectionVariantCount {
  kind: HistoricalProjectionVariant;
  count: number;
}

interface ProjectionMessage {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  timeCreated: number;
  data: JsonObject;
}

export interface PersistedMixedMigrationPlan {
  schemaVersion: 1;
  recipeId: typeof MIXED_MIGRATION_RECIPE_ID;
  targetProfile: typeof MIGRATION_TARGET_PROFILE;
  runId: string;
  sourceDatabase: string;
  sourceDatabaseSha256: string;
  sourceSchemaFingerprint: string;
  protectedDigest: string;
  planDigest: string;
  createdAt: string;
  sessions: readonly PersistedMixedSessionPlan[];
}

export interface MixedVerification {
  schemaVersion: 1;
  planDigest: string;
  expectLegacyRemoved: boolean;
  verified: boolean;
  protectedStatePreserved: boolean;
  databaseIntegrityPassed: boolean;
  sessions: readonly {
    sessionId: string;
    shape: MixedSessionShape;
    verified: boolean;
    eventCount: number;
    messageCount: number;
    inputCount: number;
    legacyMessageCount: number;
    legacyPartCount: number;
    errors: readonly string[];
  }[];
}

function parseObject(value: string, field: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    const result = asObject(parsed);
    if (!result) throw new Error();
    return result;
  } catch {
    throw new Error(`INVALID_JSON_OBJECT: ${field}`);
  }
}

function openReadonly(databasePath: string): Database {
  const resolved = resolveDatabasePath(databasePath);
  const walPath = `${resolved}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw new Error(
      "UNSAFE_WAL_PRESENT: checkpoint the database before mixed inventory",
    );
  }
  const uri = pathToFileURL(resolved);
  uri.searchParams.set("immutable", "1");
  const database = new Database(
    uri.href,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

function readSessionState(
  database: Database,
  sessionId: string,
): MixedSessionState {
  const session = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM session WHERE id = ?",
    )
    .get(sessionId);
  if (!session) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
  const sequence = database
    .query<SequenceRow, [string]>(
      `SELECT aggregate_id, seq, owner_id
       FROM event_sequence
       WHERE aggregate_id = ?`,
    )
    .get(sessionId);
  if (!sequence) {
    throw new Error(`MISSING_EVENT_SEQUENCE: ${sessionId}`);
  }
  const events = database
    .query<
      {
        id: string;
        aggregate_id: string;
        seq: number;
        type: string;
        data: string;
      },
      [string]
    >(
      `SELECT id, aggregate_id, seq, type, data
       FROM event
       WHERE aggregate_id = ?
       ORDER BY seq, id`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      data: parseObject(row.data, `event(${row.id}).data`),
    }));
  const legacyMessages = database
    .query<
      {
        id: string;
        session_id: string;
        time_created: number;
        time_updated: number;
        data: string;
      },
      [string]
    >(
      `SELECT id, session_id, time_created, time_updated, data
       FROM message
       WHERE session_id = ?
       ORDER BY time_created, id`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      data: parseObject(row.data, `message(${row.id}).data`),
    }));
  const legacyParts = database
    .query<
      {
        id: string;
        message_id: string;
        session_id: string;
        time_created: number;
        time_updated: number;
        data: string;
      },
      [string]
    >(
      `SELECT
         id, message_id, session_id, time_created, time_updated, data
       FROM part
       WHERE session_id = ?
       ORDER BY message_id, id`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      data: parseObject(row.data, `part(${row.id}).data`),
    }));
  const messages = database
    .query<
      {
        id: string;
        session_id: string;
        type: string;
        seq: number;
        time_created: number;
        time_updated: number;
        data: string;
      },
      [string]
    >(
      `SELECT
         id, session_id, type, seq, time_created, time_updated, data
       FROM session_message
       WHERE session_id = ?
       ORDER BY seq, id`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      data: parseObject(row.data, `session_message(${row.id}).data`),
    }));
  const inputs = database
    .query<
      {
        id: string;
        session_id: string;
        prompt: string;
        delivery: string;
        admitted_seq: number;
        promoted_seq: number | null;
        time_created: number;
      },
      [string]
    >(
      `SELECT
         id, session_id, prompt, delivery,
         admitted_seq, promoted_seq, time_created
       FROM session_input
       WHERE session_id = ?
       ORDER BY admitted_seq, id`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      prompt: parseObject(row.prompt, `session_input(${row.id}).prompt`),
    }));
  const contextEpochs = database
    .query<ContextEpochRow, [string]>(
      `SELECT session_id, baseline, snapshot, baseline_seq
       FROM session_context_epoch
       WHERE session_id = ?
       ORDER BY session_id`,
    )
    .all(sessionId);
  return {
    session,
    sequence,
    events,
    legacyMessages,
    legacyParts,
    messages,
    inputs,
    contextEpochs,
  };
}

function stateDigest(state: MixedSessionState): string {
  return sha256(state);
}

function existingV2Digest(state: MixedSessionState): string {
  return sha256({
    events: state.events.filter((event) =>
      event.type.startsWith("session.next."),
    ),
    messages: state.messages,
    inputs: state.inputs,
    contextEpochs: state.contextEpochs,
  });
}

function selectedWhere(
  selected: readonly string[],
  column: string,
): { sql: string; bindings: string[] } {
  if (selected.length === 0) return { sql: "", bindings: [] };
  return {
    sql: ` WHERE ${column} NOT IN (${selected.map(() => "?").join(", ")})`,
    bindings: [...selected],
  };
}

function protectedDigest(
  database: Database,
  selected: readonly string[],
): string {
  const tables = [
    ["session", "id", "id"],
    ["event_sequence", "aggregate_id", "aggregate_id"],
    ["event", "aggregate_id", "aggregate_id, seq, id"],
    ["message", "session_id", "session_id, time_created, id"],
    ["part", "session_id", "session_id, message_id, id"],
    ["session_message", "session_id", "session_id, seq, id"],
    ["session_input", "session_id", "session_id, admitted_seq, id"],
    ["session_context_epoch", "session_id", "session_id"],
  ] as const;
  return sha256(
    tables.map(([table, column, order]) => {
      const where = selectedWhere(selected, column);
      const rows = database
        .query<Record<string, unknown>, string[]>(
          `SELECT * FROM ${table}${where.sql} ORDER BY ${order}`,
        )
        .all(...where.bindings);
      return { table, rows };
    }),
  );
}

function listMixedSessionIds(database: Database): string[] {
  return database
    .query<{ id: string }, []>(
      `SELECT s.id
       FROM session s
       WHERE (
         EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
         OR EXISTS (SELECT 1 FROM part p WHERE p.session_id = s.id)
       )
         AND (
           EXISTS (
             SELECT 1 FROM event e
             WHERE e.aggregate_id = s.id
               AND e.type LIKE 'session.next.%'
           )
           OR EXISTS (
             SELECT 1 FROM session_message sm WHERE sm.session_id = s.id
           )
           OR EXISTS (
             SELECT 1 FROM session_input si WHERE si.session_id = s.id
           )
           OR EXISTS (
             SELECT 1 FROM session_context_epoch sce
             WHERE sce.session_id = s.id
           )
         )
       ORDER BY s.id`,
    )
    .all()
    .map((row) => row.id);
}

function classifyShape(
  sessionId: string,
  events: readonly EventRow[],
): {
  shape: MixedSessionShape;
  insertionSeq: number;
  sparseLegacyPrefix: boolean;
} {
  const legacy = events.filter((event) => LEGACY_EVENT_TYPES.has(event.type));
  const v2 = events.filter((event) =>
    SUPPORTED_V2_EVENT_TYPES.has(event.type),
  );
  if (legacy.length === 0 || v2.length === 0) {
    throw new Error(`MIXED_SHAPE_REQUIRED: ${sessionId}`);
  }
  const unsupported = events.filter(
    (event) =>
      !LEGACY_EVENT_TYPES.has(event.type) &&
      !SUPPORTED_V2_EVENT_TYPES.has(event.type),
  );
  if (unsupported.length > 0) {
    throw new Error(`UNSUPPORTED_EVENT_TYPE: ${sessionId}`);
  }
  if (events[0]?.seq !== 0) {
    throw new Error(`INVALID_EVENT_SEQUENCE_ORIGIN: ${sessionId}`);
  }
  const order = events
    .map((event) => (LEGACY_EVENT_TYPES.has(event.type) ? "legacy" : "v2"))
    .filter((kind, index, all) => index === 0 || all[index - 1] !== kind);
  const lastLegacy = legacy.at(-1)!.seq;
  const firstV2 = v2[0]!.seq;
  if (stableJson(order) === stableJson(["legacy", "v2"])) {
    const v2Seqs = new Set(v2.map((event) => event.seq));
    const maximum = events.at(-1)!.seq;
    for (let seq = firstV2; seq <= maximum; seq++) {
      if (!v2Seqs.has(seq)) {
        throw new Error(`NONCONTIGUOUS_V2_SUFFIX: ${sessionId}`);
      }
    }
    return {
      shape: "legacy-then-v2",
      insertionSeq: firstV2,
      sparseLegacyPrefix: legacy.length !== lastLegacy + 1,
    };
  }
  if (
    stableJson(order) === stableJson(["legacy", "v2", "legacy"])
  ) {
    for (let seq = 0; seq <= events.at(-1)!.seq; seq++) {
      if (events[seq]?.seq !== seq) {
        throw new Error(`NONCONTIGUOUS_MIXED_APPEND: ${sessionId}`);
      }
    }
    const controlOnly = v2.every(
      (event) =>
        event.type === "session.next.agent.switched.1" ||
        event.type === "session.next.model.switched.1",
    );
    return {
      shape: controlOnly
        ? "bootstrap-v2-then-legacy"
        : "v2-then-legacy-tail",
      insertionSeq: events.at(-1)!.seq + 1,
      sparseLegacyPrefix: false,
    };
  }
  throw new Error(`UNSUPPORTED_MIXED_ORDER: ${sessionId}`);
}

function legacyInfo(row: LegacyMessageRow): JsonObject {
  return {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  };
}

function legacyPart(row: LegacyPartRow): JsonObject {
  return {
    ...row.data,
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
  };
}

function assertLegacyEventsAreMatchingSubset(
  sessionId: string,
  state: MixedSessionState,
): void {
  const messages = new Map<string, JsonObject>();
  const parts = new Map<string, JsonObject>();
  for (const event of state.events) {
    if (!LEGACY_EVENT_TYPES.has(event.type)) continue;
    if (event.type === "message.updated.1") {
      const value = asObject(event.data.info);
      const id = value && asString(value.id);
      if (!value || !id) {
        throw new Error(`INVALID_LEGACY_MESSAGE_EVENT: ${sessionId}`);
      }
      messages.set(id, value);
    }
    if (event.type === "message.removed.1") {
      const id = asString(event.data.messageID);
      if (!id) throw new Error(`INVALID_LEGACY_REMOVE_EVENT: ${sessionId}`);
      messages.delete(id);
      for (const [partId, value] of parts) {
        if (asString(value.messageID) === id) parts.delete(partId);
      }
    }
    if (event.type === "message.part.updated.1") {
      const value = asObject(event.data.part);
      const id = value && asString(value.id);
      if (!value || !id) {
        throw new Error(`INVALID_LEGACY_PART_EVENT: ${sessionId}`);
      }
      parts.set(id, value);
    }
    if (event.type === "message.part.removed.1") {
      const id = asString(event.data.partID);
      if (!id) {
        throw new Error(`INVALID_LEGACY_PART_REMOVE_EVENT: ${sessionId}`);
      }
      parts.delete(id);
    }
  }
  const storedMessages = new Map(
    state.legacyMessages.map((row) => [row.id, legacyInfo(row)]),
  );
  const storedParts = new Map(
    state.legacyParts.map((row) => [row.id, legacyPart(row)]),
  );
  for (const [id, value] of messages) {
    const stored = storedMessages.get(id);
    if (!stored || stableJson(stored) !== stableJson(value)) {
      throw new Error(`LEGACY_MESSAGE_SUBSET_MISMATCH: ${sessionId}`);
    }
  }
  for (const [id, value] of parts) {
    const stored = storedParts.get(id);
    if (!stored || stableJson(stored) !== stableJson(value)) {
      throw new Error(`LEGACY_PART_SUBSET_MISMATCH: ${sessionId}`);
    }
  }
}

function hasCompleteDualWriteCoverage(state: MixedSessionState): boolean {
  if (state.legacyMessages.length === 0) return false;
  const v2Messages = new Map(
    state.messages.map((message) => [message.id, message]),
  );
  const covered = new Set<string>();
  for (const legacy of state.legacyMessages) {
    const v2 = v2Messages.get(legacy.id);
    if (
      !v2 ||
      asString(legacy.data.role) !== v2.type ||
      legacy.time_created !== v2.time_created
    ) {
      return false;
    }
    covered.add(legacy.id);
  }
  return state.legacyParts.every((part) => covered.has(part.message_id));
}

function cleanupOnlyLowering(
  lowering: SessionMigrationPlan,
  state: MixedSessionState,
): SessionMigrationPlan {
  return {
    ...lowering,
    state: "already-v2",
    baseSeq: state.sequence.seq,
    currentSeq: state.sequence.seq,
    targetLastSeq: state.sequence.seq,
    existingReplayPrefix: 0,
    events: [],
    expectedMessages: [],
    expectedInputs: [],
    diagnostics: [],
  };
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function historicalProjectionVariants(
  actualMessages: readonly ProjectionMessage[],
  projectedMessages: readonly ProjectionMessage[],
  compatibleMessageIds: ReadonlySet<string>,
): {
  compatible: boolean;
  variants: HistoricalProjectionVariant[];
} {
  const actual = structuredClone(actualMessages);
  const projected = structuredClone(projectedMessages);
  const variants: HistoricalProjectionVariant[] = [];
  if (actual.length !== projected.length) {
    return { compatible: false, variants };
  }
  for (let index = 0; index < actual.length; index++) {
    const stored = actual[index]!;
    const replayed = projected[index]!;
    if (
      stored.id !== replayed.id ||
      !compatibleMessageIds.has(stored.id) ||
      stored.type !== "assistant" ||
      replayed.type !== "assistant"
    ) {
      continue;
    }
    const storedContent = stored.data.content;
    const replayedContent = replayed.data.content;
    if (
      !Array.isArray(storedContent) ||
      !Array.isArray(replayedContent) ||
      storedContent.length !== replayedContent.length
    ) {
      continue;
    }
    for (
      let contentIndex = 0;
      contentIndex < storedContent.length;
      contentIndex++
    ) {
      const storedPart = asObject(storedContent[contentIndex]);
      const replayedPart = asObject(replayedContent[contentIndex]);
      if (!storedPart || !replayedPart || storedPart.type !== replayedPart.type) {
        continue;
      }
      if (storedPart.type === "tool") {
        const replayedProvider = asObject(replayedPart.provider);
        if (
          !hasOwn(storedPart, "provider") &&
          replayedProvider?.executed === false &&
          stableJson(Object.keys(replayedProvider).sort()) ===
            stableJson(["executed"])
        ) {
          delete replayedPart.provider;
          variants.push("tool-provider-false-omitted");
        }
        const storedTime = asObject(storedPart.time);
        const replayedTime = asObject(replayedPart.time);
        if (
          storedTime &&
          replayedTime &&
          !hasOwn(storedTime, "ran") &&
          typeof replayedTime.ran === "number" &&
          Number.isFinite(replayedTime.ran)
        ) {
          delete replayedTime.ran;
          variants.push("tool-ran-omitted");
        }
        const storedState = asObject(storedPart.state);
        const replayedState = asObject(replayedPart.state);
        if (
          storedState &&
          replayedState &&
          !hasOwn(storedState, "outputPaths") &&
          Array.isArray(replayedState.outputPaths) &&
          replayedState.outputPaths.length === 0
        ) {
          delete replayedState.outputPaths;
          variants.push("tool-output-paths-empty-omitted");
        }
      }
      if (storedPart.type === "reasoning") {
        if (
          hasOwn(storedPart, "providerMetadata") &&
          storedPart.providerMetadata === null &&
          !hasOwn(replayedPart, "providerMetadata")
        ) {
          delete storedPart.providerMetadata;
          variants.push("reasoning-provider-metadata-null");
        }
        const replayedTime = asObject(replayedPart.time);
        if (
          !hasOwn(storedPart, "time") &&
          replayedTime &&
          typeof replayedTime.created === "number" &&
          Number.isFinite(replayedTime.created) &&
          typeof replayedTime.completed === "number" &&
          Number.isFinite(replayedTime.completed) &&
          stableJson(Object.keys(replayedTime).sort()) ===
            stableJson(["completed", "created"])
        ) {
          delete replayedPart.time;
          variants.push("reasoning-time-omitted");
        }
      }
    }
  }
  return {
    compatible: stableJson(actual) === stableJson(projected),
    variants,
  };
}

function countHistoricalProjectionVariants(
  variants: readonly HistoricalProjectionVariant[],
): HistoricalProjectionVariantCount[] {
  const counts = new Map<HistoricalProjectionVariant, number>();
  for (const variant of variants) {
    counts.set(variant, (counts.get(variant) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
}

function assertExistingV2ProjectionAnchors(
  sessionId: string,
  state: MixedSessionState,
): HistoricalProjectionVariantCount[] {
  const v2Events = state.events.filter((event) =>
    SUPPORTED_V2_EVENT_TYPES.has(event.type),
  );
  const v2BySeq = new Map(v2Events.map((event) => [event.seq, event]));
  const replay = v2Events.map((event) => ({
    id: event.id,
    aggregateID: event.aggregate_id,
    seq: event.seq,
    type: event.type.replace(/\.(?:1|2)$/, ""),
    data: structuredClone(event.data),
  }));
  const projected = projectReplayEvents(replay);
  const actualMessages = state.messages.map((message) => ({
    id: message.id,
    sessionId: message.session_id,
    type: message.type,
    seq: message.seq,
    timeCreated: message.time_created,
    data: structuredClone(message.data),
  }));
  const compatibility = historicalProjectionVariants(
    actualMessages,
    projected.messages,
    new Set(actualMessages.map((message) => message.id)),
  );
  if (!compatibility.compatible) {
    throw new Error(`V2_MESSAGE_PROJECTION_DIVERGENCE: ${sessionId}`);
  }
  const eventInputIds = [
    ...new Set(
      v2Events
        .filter(
          (event) =>
            event.type === "session.next.prompt.admitted.1" ||
            event.type === "session.next.prompted.1",
        )
        .map((event) => asString(event.data.messageID))
        .filter((id): id is string => id !== undefined),
    ),
  ].sort();
  const storedInputIds = state.inputs.map((input) => input.id).sort();
  if (stableJson(storedInputIds) !== stableJson(eventInputIds)) {
    throw new Error(`V2_INPUT_PROJECTION_DIVERGENCE: ${sessionId}`);
  }
  for (const input of state.inputs) {
    const admitted = v2BySeq.get(input.admitted_seq);
    const promoted =
      input.promoted_seq === null
        ? undefined
        : v2BySeq.get(input.promoted_seq);
    if (!admitted || !promoted || input.promoted_seq === null) {
      throw new Error(`V2_INPUT_WITHOUT_SETTLED_EVENTS: ${sessionId}`);
    }
    if (
      (admitted.type !== "session.next.prompt.admitted.1" &&
        admitted.type !== "session.next.prompted.1") ||
      promoted.type !== "session.next.prompted.1"
    ) {
      throw new Error(`V2_INPUT_EVENT_TYPE_DIVERGENCE: ${sessionId}`);
    }
    const admittedPrompt = asObject(admitted.data.prompt);
    const promotedPrompt = asObject(promoted.data.prompt);
    if (
      asString(admitted.data.messageID) !== input.id ||
      asString(promoted.data.messageID) !== input.id ||
      asString(admitted.data.sessionID) !== sessionId ||
      asString(promoted.data.sessionID) !== sessionId ||
      stableJson(admittedPrompt) !== stableJson(input.prompt) ||
      stableJson(promotedPrompt) !== stableJson(input.prompt) ||
      asString(admitted.data.delivery) !== input.delivery ||
      asString(promoted.data.delivery) !== input.delivery ||
      admitted.data.timestamp !== input.time_created
    ) {
      throw new Error(`V2_INPUT_PROJECTION_DIVERGENCE: ${sessionId}`);
    }
  }
  for (const epoch of state.contextEpochs) {
    if (
      epoch.baseline_seq < 0 ||
      epoch.baseline_seq > state.sequence.seq
    ) {
      throw new Error(`INVALID_CONTEXT_BASELINE: ${sessionId}`);
    }
  }
  return countHistoricalProjectionVariants(compatibility.variants);
}

function acceptedDiagnostics(
  lowering: SessionMigrationPlan,
  sparseLegacyPrefix: boolean,
): string[] {
  const result: string[] = [];
  for (const diagnostic of lowering.diagnostics) {
    if (diagnostic.severity !== "blocking") continue;
    const exact = `${diagnostic.code}:${diagnostic.message}`;
    if (
      ALLOWED_MIXED_DIAGNOSTICS.has(exact) ||
      (diagnostic.code === "MIXED_EVENT_DIVERGENCE" &&
        diagnostic.message.startsWith(
          "existing V2 event diverges at aggregate seq ",
        )) ||
      (sparseLegacyPrefix &&
        diagnostic.code === "EVENT_SEQUENCE_GAP") ||
      (sparseLegacyPrefix &&
        diagnostic.code === "LEGACY_PROJECTION_DIVERGENCE" &&
        (diagnostic.message ===
          "legacy message rows differ from replayed V1 events" ||
          diagnostic.message ===
            "legacy part rows differ from replayed V1 events" ||
          diagnostic.message ===
            "session agent/model/update-time differs from its durable event projection"))
    ) {
      result.push(exact);
      continue;
    }
    throw new Error(
      `UNAPPROVED_MIXED_DIAGNOSTIC: ${lowering.sessionId}:${diagnostic.code}`,
    );
  }
  return result.sort();
}

function cloneState(state: MixedSessionState): MixedSessionState {
  return structuredClone(state);
}

function generatedEventRows(
  lowering: SessionMigrationPlan,
): EventRow[] {
  return lowering.events.map((event) => ({
    id: event.id,
    aggregate_id: event.aggregateID,
    seq: event.seq,
    type: versionedType(event.type),
    data: structuredClone(event.data),
  }));
}

function generatedMessageRows(
  messages: readonly ExpectedSessionMessage[],
): SessionMessageRow[] {
  return messages.map((message) => ({
    id: message.id,
    session_id: message.sessionId,
    type: message.type,
    seq: message.seq,
    time_created: message.timeCreated,
    time_updated: message.timeCreated,
    data: structuredClone(message.data),
  }));
}

function generatedInputRows(
  inputs: readonly ExpectedSessionInput[],
): SessionInputRow[] {
  return inputs.map((input) => ({
    id: input.id,
    session_id: input.sessionId,
    prompt: structuredClone(input.prompt),
    delivery: input.delivery,
    admitted_seq: input.admittedSeq,
    promoted_seq: input.promotedSeq,
    time_created: input.timeCreated,
  }));
}

function expectedState(
  source: MixedSessionState,
  lowering: SessionMigrationPlan,
  insertionSeq: number,
  shiftBy: number,
  cleaned: boolean,
): MixedSessionState {
  const result = cloneState(source);
  if (shiftBy > 0) {
    for (const event of result.events) {
      if (event.seq >= insertionSeq) event.seq += shiftBy;
    }
    for (const message of result.messages) {
      if (message.seq >= insertionSeq) message.seq += shiftBy;
    }
    for (const input of result.inputs) {
      if (input.admitted_seq >= insertionSeq) input.admitted_seq += shiftBy;
      if (
        input.promoted_seq !== null &&
        input.promoted_seq >= insertionSeq
      ) {
        input.promoted_seq += shiftBy;
      }
    }
    for (const epoch of result.contextEpochs) {
      if (epoch.baseline_seq >= insertionSeq) {
        epoch.baseline_seq += shiftBy;
      }
    }
  }
  result.events.push(...generatedEventRows(lowering));
  result.events.sort((left, right) => left.seq - right.seq);
  result.messages.push(...generatedMessageRows(lowering.expectedMessages));
  result.messages.sort(
    (left, right) => left.seq - right.seq || left.id.localeCompare(right.id),
  );
  result.inputs.push(...generatedInputRows(lowering.expectedInputs));
  result.inputs.sort(
    (left, right) =>
      left.admitted_seq - right.admitted_seq ||
      left.id.localeCompare(right.id),
  );
  result.sequence.seq += lowering.events.length;
  if (cleaned) {
    result.legacyMessages = [];
    result.legacyParts = [];
    result.session.version = "1.18.9";
    result.session.time_compacting = null;
  }
  return result;
}

function assertCombinedProjectionStable(
  sessionId: string,
  state: MixedSessionState,
  compatibleMessageIds: ReadonlySet<string>,
): void {
  const replay = state.events
    .filter((event) => SUPPORTED_V2_EVENT_TYPES.has(event.type))
    .map((event) => ({
      id: event.id,
      aggregateID: event.aggregate_id,
      seq: event.seq,
      type: event.type.replace(/\.(?:1|2)$/, ""),
      data: structuredClone(event.data),
    }));
  const projected = projectReplayEvents(replay);
  const stored = state.messages.map((message) => ({
    id: message.id,
    sessionId: message.session_id,
    type: message.type,
    seq: message.seq,
    timeCreated: message.time_created,
    data: structuredClone(message.data),
  }));
  if (
    !historicalProjectionVariants(
      stored,
      projected.messages,
      compatibleMessageIds,
    ).compatible
  ) {
    throw new Error(`COMBINED_V2_PROJECTION_DIVERGENCE: ${sessionId}`);
  }
}

function assertGeneratedRowsDoNotCollide(
  database: Database,
  plan: SessionMigrationPlan,
): void {
  const checks = [
    ["event", plan.events.map((event) => event.id)],
    ["session_message", plan.expectedMessages.map((message) => message.id)],
    ["session_input", plan.expectedInputs.map((input) => input.id)],
  ] as const;
  for (const [table, ids] of checks) {
    for (const id of ids) {
      const row = database
        .query<{ found: number }, [string]>(
          `SELECT COUNT(*) AS found FROM ${table} WHERE id = ?`,
        )
        .get(id)!;
      if (row.found > 0) {
        throw new Error(`GENERATED_ID_COLLISION: ${table}`);
      }
    }
  }
}

function assertAppendSelectionSafe(
  shape: MixedSessionShape,
  lowering: SessionMigrationPlan,
  state: MixedSessionState,
): void {
  if (shape === "legacy-then-v2") return;
  const storedAgent =
    typeof state.session.agent === "string"
      ? state.session.agent
      : undefined;
  let storedModel: JsonObject | undefined;
  if (typeof state.session.model === "string") {
    storedModel = parseObject(
      state.session.model,
      `session(${lowering.sessionId}).model`,
    );
  }
  if (
    storedAgent !== lowering.expectedSessionAgent ||
    stableJson(storedModel) !== stableJson(lowering.expectedSessionModel)
  ) {
    throw new Error(`APPEND_SELECTION_DIVERGENCE: ${lowering.sessionId}`);
  }
}

function buildSessionPlan(
  databasePath: string,
  database: Database,
  sessionId: string,
): MixedSessionPlan {
  const state = readSessionState(database, sessionId);
  if (state.sequence.owner_id !== null) {
    throw new Error(`OWNER_CONFLICT: ${sessionId}`);
  }
  if (
    state.session.revert !== null &&
    state.session.revert !== undefined
  ) {
    throw new Error(`ACTIVE_REVERT: ${sessionId}`);
  }
  if (
    state.session.time_compacting !== null &&
    state.session.time_compacting !== undefined
  ) {
    throw new Error(`ACTIVE_COMPACTION: ${sessionId}`);
  }
  const maximum = state.events.at(-1)?.seq ?? -1;
  if (maximum !== state.sequence.seq) {
    throw new Error(`EVENT_SEQUENCE_MISMATCH: ${sessionId}`);
  }
  const shape = classifyShape(sessionId, state.events);
  assertLegacyEventsAreMatchingSubset(sessionId, state);
  const historicalVariants = assertExistingV2ProjectionAnchors(
    sessionId,
    state,
  );
  const plannedLowering = buildSessionMigrationPlan(
    readSessionSourceSnapshot(databasePath, sessionId),
  );
  if (hasCompleteDualWriteCoverage(state)) {
    const lowering = cleanupOnlyLowering(plannedLowering, state);
    const migrated = expectedState(
      state,
      lowering,
      state.sequence.seq + 1,
      0,
      false,
    );
    const cleaned = expectedState(
      state,
      lowering,
      state.sequence.seq + 1,
      0,
      true,
    );
    assertCombinedProjectionStable(
      sessionId,
      migrated,
      new Set(state.messages.map((message) => message.id)),
    );
    return {
      sessionId,
      shape: "v2-dual-write-cleanup",
      insertionSeq: state.sequence.seq + 1,
      shiftBy: 0,
      sourceStateDigest: stateDigest(state),
      existingV2Digest: existingV2Digest(state),
      lowering,
      sourceState: state,
      expectedMigratedState: migrated,
      expectedCleanedState: cleaned,
      acceptedBlockingDiagnostics: [
        "DUAL_WRITE_CLEANUP:all legacy message IDs have role/time-matched V2 rows",
      ],
      historicalProjectionVariants: historicalVariants,
      sparseLegacyPrefix: shape.sparseLegacyPrefix,
    };
  }
  const lowering = plannedLowering;
  if (lowering.events.length === 0) {
    throw new Error(`MIXED_PLAN_NO_EVENTS: ${sessionId}`);
  }
  if (lowering.baseSeq + 1 !== shape.insertionSeq) {
    throw new Error(`MIXED_INSERTION_BOUNDARY_MISMATCH: ${sessionId}`);
  }
  const accepted = acceptedDiagnostics(
    lowering,
    shape.sparseLegacyPrefix,
  );
  assertGeneratedRowsDoNotCollide(database, lowering);
  assertAppendSelectionSafe(shape.shape, lowering, state);
  const shiftBy =
    shape.shape === "legacy-then-v2" ? lowering.events.length : 0;
  const migrated = expectedState(
    state,
    lowering,
    shape.insertionSeq,
    shiftBy,
    false,
  );
  const cleaned = expectedState(
    state,
    lowering,
    shape.insertionSeq,
    shiftBy,
    true,
  );
  assertCombinedProjectionStable(
    sessionId,
    migrated,
    new Set(state.messages.map((message) => message.id)),
  );
  return {
    sessionId,
    shape: shape.shape,
    insertionSeq: shape.insertionSeq,
    shiftBy,
    sourceStateDigest: stateDigest(state),
    existingV2Digest: existingV2Digest(state),
    lowering,
    sourceState: state,
    expectedMigratedState: migrated,
    expectedCleanedState: cleaned,
    acceptedBlockingDiagnostics: accepted,
    historicalProjectionVariants: historicalVariants,
    sparseLegacyPrefix: shape.sparseLegacyPrefix,
  };
}

function publicPlanDigest(input: {
  sourceDatabaseSha256: string;
  sourceSchemaFingerprint: string;
  protectedDigest: string;
  sessions: readonly MixedSessionPlan[];
}): string {
  return sha256({
    schemaVersion: 1,
    recipeId: MIXED_MIGRATION_RECIPE_ID,
    targetProfile: MIGRATION_TARGET_PROFILE,
    sourceDatabaseSha256: input.sourceDatabaseSha256,
    sourceSchemaFingerprint: input.sourceSchemaFingerprint,
    protectedDigest: input.protectedDigest,
    sessions: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      shape: session.shape,
      insertionSeq: session.insertionSeq,
      shiftBy: session.shiftBy,
      sourceStateDigest: session.sourceStateDigest,
      existingV2Digest: session.existingV2Digest,
      generatedEventDigest: sha256(session.lowering.events),
      expectedMigratedStateDigest: stateDigest(
        session.expectedMigratedState,
      ),
      expectedCleanedStateDigest: stateDigest(
        session.expectedCleanedState,
      ),
      acceptedBlockingDiagnostics: session.acceptedBlockingDiagnostics,
      historicalProjectionVariants: session.historicalProjectionVariants,
      sparseLegacyPrefix: session.sparseLegacyPrefix,
    })),
  });
}

export async function buildMixedMigrationPlan(input: {
  databasePath: string;
  sessionIds?: readonly string[];
}): Promise<MixedMigrationPlan> {
  const sourceDatabase = resolveDatabasePath(input.databasePath);
  const sourceDatabaseSha256 = await sha256File(sourceDatabase);
  const sourceSchemaFingerprint = readSchemaFingerprint(sourceDatabase);
  const checks = readDatabaseChecks(sourceDatabase);
  if (
    checks.quickCheck.length !== 1 ||
    checks.quickCheck[0]?.toLowerCase() !== "ok" ||
    checks.foreignKeyViolations.length > 0
  ) {
    throw new Error("SOURCE_DATABASE_INTEGRITY_FAILED");
  }
  const database = openReadonly(sourceDatabase);
  try {
    const selected = [
      ...(input.sessionIds ?? listMixedSessionIds(database)),
    ].sort();
    if (selected.length === 0) {
      throw new Error("MIXED_PLAN_NOOP: no mixed sessions selected");
    }
    if (new Set(selected).size !== selected.length) {
      throw new Error("DUPLICATE_SESSION_SELECTION");
    }
    const sessions = selected.map((sessionId) =>
      buildSessionPlan(sourceDatabase, database, sessionId),
    );
    const protectedState = protectedDigest(database, selected);
    return {
      sourceDatabase,
      sourceDatabaseSha256,
      sourceSchemaFingerprint,
      protectedDigest: protectedState,
      planDigest: publicPlanDigest({
        sourceDatabaseSha256,
        sourceSchemaFingerprint,
        protectedDigest: protectedState,
        sessions,
      }),
      sessions,
    };
  } finally {
    database.close();
  }
}

export function persistableMixedPlan(
  plan: MixedMigrationPlan,
  runId: string,
): PersistedMixedMigrationPlan {
  return {
    schemaVersion: 1,
    recipeId: MIXED_MIGRATION_RECIPE_ID,
    targetProfile: MIGRATION_TARGET_PROFILE,
    runId,
    sourceDatabase: plan.sourceDatabase,
    sourceDatabaseSha256: plan.sourceDatabaseSha256,
    sourceSchemaFingerprint: plan.sourceSchemaFingerprint,
    protectedDigest: plan.protectedDigest,
    planDigest: plan.planDigest,
    createdAt: new Date().toISOString(),
    sessions: plan.sessions.map((session) => ({
      sessionId: session.sessionId,
      shape: session.shape,
      insertionSeq: session.insertionSeq,
      shiftedExistingV2Rows: session.shiftBy > 0,
      generatedEventCount: session.lowering.events.length,
      generatedMessageCount: session.lowering.expectedMessages.length,
      generatedInputCount: session.lowering.expectedInputs.length,
      sourceLegacyMessageCount: session.sourceState.legacyMessages.length,
      sourceLegacyPartCount: session.sourceState.legacyParts.length,
      sourceStateDigest: session.sourceStateDigest,
      existingV2Digest: session.existingV2Digest,
      generatedEventDigest: sha256(session.lowering.events),
      expectedMigratedStateDigest: stateDigest(
        session.expectedMigratedState,
      ),
      expectedCleanedStateDigest: stateDigest(
        session.expectedCleanedState,
      ),
      acceptedBlockingDiagnostics: session.acceptedBlockingDiagnostics,
      historicalProjectionVariants: session.historicalProjectionVariants,
      sparseLegacyPrefix: session.sparseLegacyPrefix,
    })),
  };
}

async function assertPlanStillCurrent(
  persisted: PersistedMixedMigrationPlan,
  current: MixedMigrationPlan,
): Promise<void> {
  if (
    persisted.recipeId !== MIXED_MIGRATION_RECIPE_ID ||
    persisted.targetProfile !== MIGRATION_TARGET_PROFILE
  ) {
    throw new Error("MIXED_PLAN_STALE: recipe or target changed");
  }
  if (
    persisted.sourceDatabaseSha256 !== current.sourceDatabaseSha256 ||
    persisted.sourceSchemaFingerprint !== current.sourceSchemaFingerprint ||
    persisted.protectedDigest !== current.protectedDigest ||
    persisted.planDigest !== current.planDigest
  ) {
    throw new Error("MIXED_PLAN_STALE: source content changed");
  }
}

function assertDistinctDatabaseFiles(
  sourceDatabase: string,
  candidateDatabase: string,
): void {
  const source = resolveDatabasePath(sourceDatabase);
  const candidate = resolve(candidateDatabase);
  const unresolved: string[] = [];
  let existingParent = candidate;
  while (!existsSync(existingParent)) {
    unresolved.unshift(basename(existingParent));
    const parent = dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  const canonicalCandidate = existsSync(candidate)
    ? realpathSync(candidate)
    : resolve(realpathSync(existingParent), ...unresolved);
  const sameFile =
    existsSync(candidate) &&
    (() => {
      const sourceStat = statSync(source);
      const candidateStat = statSync(candidate);
      return (
        sourceStat.dev === candidateStat.dev &&
        sourceStat.ino === candidateStat.ino
      );
    })();
  if (source === canonicalCandidate || sameFile) {
    throw new Error(
      "SOURCE_CANDIDATE_COLLISION: candidate must not overwrite backup",
    );
  }
}

function shiftExistingV2Suffix(
  database: Database,
  session: MixedSessionPlan,
): void {
  if (session.shiftBy === 0) return;
  database
    .query<never, [string, number]>(
      `UPDATE event
       SET seq = -seq - 1
       WHERE aggregate_id = ? AND seq >= ?`,
    )
    .run(session.sessionId, session.insertionSeq);
  database
    .query<never, [number, string]>(
      `UPDATE event
       SET seq = -seq - 1 + ?
       WHERE aggregate_id = ? AND seq < 0`,
    )
    .run(session.shiftBy, session.sessionId);
  database
    .query<never, [string, number]>(
      `UPDATE session_message
       SET seq = -seq - 1
       WHERE session_id = ? AND seq >= ?`,
    )
    .run(session.sessionId, session.insertionSeq);
  database
    .query<never, [number, string]>(
      `UPDATE session_message
       SET seq = -seq - 1 + ?
       WHERE session_id = ? AND seq < 0`,
    )
    .run(session.shiftBy, session.sessionId);
  database
    .query<never, [number, number, number, number, string]>(
      `UPDATE session_input
       SET admitted_seq =
             CASE WHEN admitted_seq >= ? THEN admitted_seq + ? ELSE admitted_seq END,
           promoted_seq =
             CASE
               WHEN promoted_seq >= ? THEN promoted_seq + ?
               ELSE promoted_seq
             END
       WHERE session_id = ?`,
    )
    .run(
      session.insertionSeq,
      session.shiftBy,
      session.insertionSeq,
      session.shiftBy,
      session.sessionId,
    );
  database
    .query<never, [number, number, string]>(
      `UPDATE session_context_epoch
       SET baseline_seq =
         CASE WHEN baseline_seq >= ? THEN baseline_seq + ? ELSE baseline_seq END
       WHERE session_id = ?`,
    )
    .run(session.insertionSeq, session.shiftBy, session.sessionId);
}

function insertGeneratedRows(
  database: Database,
  session: MixedSessionPlan,
): void {
  if (
    session.lowering.events.length === 0 &&
    session.lowering.expectedMessages.length === 0 &&
    session.lowering.expectedInputs.length === 0
  ) {
    return;
  }
  for (const event of session.lowering.events) {
    database
      .query<never, [string, string, number, string, string]>(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.aggregateID,
        event.seq,
        versionedType(event.type),
        JSON.stringify(event.data),
      );
  }
  for (const message of session.lowering.expectedMessages) {
    database
      .query<
        never,
        [string, string, string, number, number, number, string]
      >(
        `INSERT INTO session_message(
           id, session_id, type, seq, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.type,
        message.seq,
        message.timeCreated,
        message.timeCreated,
        JSON.stringify(message.data),
      );
  }
  for (const input of session.lowering.expectedInputs) {
    database
      .query<
        never,
        [string, string, string, string, number, number, number]
      >(
        `INSERT INTO session_input(
           id, session_id, prompt, delivery,
           admitted_seq, promoted_seq, time_created
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        JSON.stringify(input.prompt),
        input.delivery,
        input.admittedSeq,
        input.promotedSeq,
        input.timeCreated,
      );
  }
  const update = database
    .query<never, [number, string, number]>(
      `UPDATE event_sequence
       SET seq = ?
       WHERE aggregate_id = ? AND seq = ? AND owner_id IS NULL`,
    )
    .run(
      session.sourceState.sequence.seq + session.lowering.events.length,
      session.sessionId,
      session.sourceState.sequence.seq,
    );
  if (update.changes !== 1) {
    throw new Error(`MIXED_SEQUENCE_UPDATE_FAILED: ${session.sessionId}`);
  }
}

function transformCandidate(
  databasePath: string,
  plan: MixedMigrationPlan,
): void {
  const database = new Database(resolveDatabasePath(databasePath), {
    strict: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const session of plan.sessions) {
      const actual = readSessionState(database, session.sessionId);
      if (stateDigest(actual) !== session.sourceStateDigest) {
        throw new Error(
          `MIXED_CANDIDATE_SOURCE_DIVERGENCE: ${session.sessionId}`,
        );
      }
      shiftExistingV2Suffix(database, session);
      insertGeneratedRows(database, session);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Transaction may already be closed.
    }
    throw error;
  } finally {
    database.close();
  }
}

function stateErrors(
  actual: MixedSessionState,
  expected: MixedSessionState,
): string[] {
  const errors: string[] = [];
  const fields = [
    "session",
    "sequence",
    "events",
    "legacyMessages",
    "legacyParts",
    "messages",
    "inputs",
    "contextEpochs",
  ] as const;
  for (const field of fields) {
    if (stableJson(actual[field]) !== stableJson(expected[field])) {
      errors.push(`${field} differs from the expected mixed migration`);
    }
  }
  return errors;
}

export function verifyMixedCandidate(
  databasePath: string,
  plan: MixedMigrationPlan,
  options: { expectLegacyRemoved?: boolean } = {},
): MixedVerification {
  checkpointDatabase(databasePath);
  const database = openReadonly(databasePath);
  const expectLegacyRemoved = options.expectLegacyRemoved === true;
  try {
    const sessions = plan.sessions.map((session) => {
      const actual = readSessionState(database, session.sessionId);
      const expected = expectLegacyRemoved
        ? session.expectedCleanedState
        : session.expectedMigratedState;
      const errors = stateErrors(actual, expected);
      return {
        sessionId: session.sessionId,
        shape: session.shape,
        verified: errors.length === 0,
        eventCount: actual.events.length,
        messageCount: actual.messages.length,
        inputCount: actual.inputs.length,
        legacyMessageCount: actual.legacyMessages.length,
        legacyPartCount: actual.legacyParts.length,
        errors,
      };
    });
    const protectedStatePreserved =
      protectedDigest(
        database,
        plan.sessions.map((session) => session.sessionId),
      ) === plan.protectedDigest;
    const checks = readDatabaseChecks(databasePath);
    const databaseIntegrityPassed =
      checks.quickCheck.length === 1 &&
      checks.quickCheck[0]?.toLowerCase() === "ok" &&
      checks.foreignKeyViolations.length === 0;
    return {
      schemaVersion: 1,
      planDigest: plan.planDigest,
      expectLegacyRemoved,
      verified:
        sessions.every((session) => session.verified) &&
        protectedStatePreserved &&
        databaseIntegrityPassed,
      protectedStatePreserved,
      databaseIntegrityPassed,
      sessions,
    };
  } finally {
    database.close();
  }
}

function candidateMatchesSource(
  candidateDatabase: string,
  plan: MixedMigrationPlan,
): boolean {
  const database = openReadonly(candidateDatabase);
  try {
    return plan.sessions.every(
      (session) =>
        stateDigest(readSessionState(database, session.sessionId)) ===
        session.sourceStateDigest,
    );
  } finally {
    database.close();
  }
}

export async function migrateMixedLocal(input: {
  sourceDatabase: string;
  candidateDatabase: string;
  persistedPlan: PersistedMixedMigrationPlan;
  runDir: string;
}): Promise<MixedVerification> {
  const source = resolve(input.sourceDatabase);
  const candidate = resolve(input.candidateDatabase);
  assertDistinctDatabaseFiles(source, candidate);
  const current = await buildMixedMigrationPlan({
    databasePath: source,
    sessionIds: input.persistedPlan.sessions.map(
      (session) => session.sessionId,
    ),
  });
  await assertPlanStillCurrent(input.persistedPlan, current);
  if (!existsSync(candidate)) {
    await copyDatabaseBackup(source, candidate);
  } else {
    checkpointDatabase(candidate);
    const alreadyMigrated = verifyMixedCandidate(candidate, current);
    if (alreadyMigrated.verified) {
      await writeJsonSecure(
        resolve(input.runDir, "mixed-verification.json"),
        alreadyMigrated,
        { overwrite: true },
      );
      return alreadyMigrated;
    }
    if (!candidateMatchesSource(candidate, current)) {
      throw new Error("MIXED_CANDIDATE_DIVERGENCE");
    }
  }
  transformCandidate(candidate, current);
  checkpointDatabase(candidate);
  const verification = verifyMixedCandidate(candidate, current);
  await writeJsonSecure(
    resolve(input.runDir, "mixed-verification.json"),
    verification,
    { overwrite: true },
  );
  if (!verification.verified) throw new Error("MIXED_VERIFY_FAILED");
  await writeJsonSecure(
    resolve(input.runDir, "mixed-receipt.json"),
    {
      schemaVersion: 1,
      recipeId: MIXED_MIGRATION_RECIPE_ID,
      targetProfile: MIGRATION_TARGET_PROFILE,
      runId: input.persistedPlan.runId,
      planDigest: current.planDigest,
      sourceDatabaseSha256: current.sourceDatabaseSha256,
      completedAt: new Date().toISOString(),
      sessions: current.sessions.map((session) => ({
        sessionId: session.sessionId,
        shape: session.shape,
        insertionSeq: session.insertionSeq,
        shiftedExistingV2Rows: session.shiftBy > 0,
        generatedEvents: session.lowering.events.length,
      })),
    },
    { overwrite: true },
  );
  return verification;
}

export async function cleanupMixedLocal(input: {
  sourceDatabase: string;
  candidateDatabase: string;
  persistedPlan: PersistedMixedMigrationPlan;
  runDir: string;
}): Promise<MixedVerification> {
  const source = resolve(input.sourceDatabase);
  const candidate = resolve(input.candidateDatabase);
  assertDistinctDatabaseFiles(source, candidate);
  const current = await buildMixedMigrationPlan({
    databasePath: source,
    sessionIds: input.persistedPlan.sessions.map(
      (session) => session.sessionId,
    ),
  });
  await assertPlanStillCurrent(input.persistedPlan, current);
  checkpointDatabase(candidate);
  const alreadyCleaned = verifyMixedCandidate(candidate, current, {
    expectLegacyRemoved: true,
  });
  if (alreadyCleaned.verified) {
    await writeJsonSecure(
      resolve(input.runDir, "mixed-cleanup-verification.json"),
      alreadyCleaned,
      { overwrite: true },
    );
    return alreadyCleaned;
  }
  const before = verifyMixedCandidate(candidate, current);
  if (!before.verified) {
    throw new Error("MIXED_VERIFY_FAILED: refusing legacy cleanup");
  }
  const database = new Database(resolveDatabasePath(candidate), {
    strict: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const session of current.sessions) {
      database
        .query<never, [string]>("DELETE FROM part WHERE session_id = ?")
        .run(session.sessionId);
      database
        .query<never, [string]>("DELETE FROM message WHERE session_id = ?")
        .run(session.sessionId);
      database
        .query<never, [string]>(
          `UPDATE session
           SET version = '1.18.9', time_compacting = NULL
           WHERE id = ?`,
        )
        .run(session.sessionId);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Transaction may already be closed.
    }
    throw error;
  } finally {
    database.close();
  }
  checkpointDatabase(candidate);
  const verification = verifyMixedCandidate(candidate, current, {
    expectLegacyRemoved: true,
  });
  await writeJsonSecure(
    resolve(input.runDir, "mixed-cleanup-verification.json"),
    verification,
    { overwrite: true },
  );
  if (!verification.verified) {
    throw new Error("MIXED_CLEANUP_VERIFY_FAILED");
  }
  await writeJsonSecure(
    resolve(input.runDir, "mixed-cleanup-receipt.json"),
    {
      schemaVersion: 1,
      recipeId: MIXED_MIGRATION_RECIPE_ID,
      targetProfile: MIGRATION_TARGET_PROFILE,
      runId: input.persistedPlan.runId,
      planDigest: current.planDigest,
      sourceDatabaseSha256: current.sourceDatabaseSha256,
      completedAt: new Date().toISOString(),
      sessions: current.sessions.map((session) => ({
        sessionId: session.sessionId,
        removedLegacyMessages: session.sourceState.legacyMessages.length,
        removedLegacyParts: session.sourceState.legacyParts.length,
      })),
    },
    { overwrite: true },
  );
  return verification;
}

export function replayEventsForMixedPlan(
  plan: PersistedMixedMigrationPlan,
): readonly {
  sessionId: string;
  shape: MixedSessionShape;
  generatedEventCount: number;
}[] {
  return plan.sessions.map((session) => ({
    sessionId: session.sessionId,
    shape: session.shape,
    generatedEventCount: session.generatedEventCount,
  }));
}

export type { MixedMigrationPlan };
