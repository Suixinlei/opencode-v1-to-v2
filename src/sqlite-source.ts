import { constants, Database } from "bun:sqlite";
import { existsSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
  JsonObject,
  LegacyMessage,
  LegacyPart,
  LegacySession,
  SessionSourceSnapshot,
  StoredEvent,
} from "./contracts";
import { asObject, sha256 } from "./stable";

const REQUIRED_TABLES = [
  "event",
  "event_sequence",
  "message",
  "part",
  "session",
  "session_context_epoch",
  "session_input",
  "session_message",
] as const;

type JsonColumn = string | null;

interface SessionRow {
  id: string;
  version: string;
  agent: string | null;
  model: JsonColumn;
  metadata: JsonColumn;
  revert: JsonColumn;
  time_created: number;
  time_updated: number;
  time_compacting: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface EventRow {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: string;
}

interface CountRow {
  count: number;
}

function parseJson(value: JsonColumn, field: string): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${field}`);
  }
}

function parseObject(value: JsonColumn, field: string): JsonObject | undefined {
  const parsed = parseJson(value, field);
  if (parsed === undefined) return undefined;
  const object = asObject(parsed);
  if (!object) throw new Error(`${field} must contain a JSON object`);
  return object;
}

export function resolveDatabasePath(databasePath: string): string {
  return realpathSync(databasePath);
}

function openReadonly(databasePath: string): Database {
  const resolved = resolveDatabasePath(databasePath);
  const walPath = `${resolved}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw new Error(
      "UNSAFE_WAL_PRESENT: checkpoint the database before read-only inventory",
    );
  }
  const uri = pathToFileURL(resolved);
  uri.searchParams.set("immutable", "1");
  // Bun requires SQLITE_OPEN_URI explicitly on Linux. Without it the same
  // immutable URI works on macOS but is treated as a literal filename on Linux.
  const database = new Database(
    uri.href,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

function assertRequiredSchema(database: Database): void {
  const rows = database
    .query<{ name: string }, []>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
       ORDER BY name`,
    )
    .all();
  const available = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !available.has(table));
  if (missing.length > 0) {
    throw new Error(`Unsupported OpenCode schema; missing ${missing.join(", ")}`);
  }
}

export function readSchemaFingerprint(databasePath: string): string {
  const database = openReadonly(databasePath);
  try {
    assertRequiredSchema(database);
    const rows = database
      .query<
        { type: string; name: string; tbl_name: string; sql: string | null },
        []
      >(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE tbl_name IN (
           'event',
           'event_sequence',
           'message',
           'part',
           'session',
           'session_context_epoch',
           'session_input',
           'session_message'
         )
         ORDER BY type, name`,
      )
      .all();
    return sha256(rows);
  } finally {
    database.close();
  }
}

export function listSessionIds(databasePath: string): string[] {
  const database = openReadonly(databasePath);
  try {
    assertRequiredSchema(database);
    return database
      .query<{ id: string }, []>("SELECT id FROM session ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    database.close();
  }
}

export function listLegacySessionIds(databasePath: string): string[] {
  const database = openReadonly(databasePath);
  try {
    assertRequiredSchema(database);
    return database
      .query<{ id: string }, []>(
        `SELECT s.id
         FROM session s
         WHERE (
           EXISTS (
             SELECT 1 FROM message m WHERE m.session_id = s.id
           )
           OR EXISTS (
             SELECT 1 FROM part p WHERE p.session_id = s.id
           )
         )
           AND NOT EXISTS (
             SELECT 1 FROM event e
             WHERE e.aggregate_id = s.id
               AND e.type LIKE 'session.next.%'
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_message sm WHERE sm.session_id = s.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_input si WHERE si.session_id = s.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_context_epoch sce
             WHERE sce.session_id = s.id
           )
         ORDER BY s.id`,
      )
      .all()
      .map((row) => row.id);
  } finally {
    database.close();
  }
}

export function readSessionSourceSnapshot(
  databasePath: string,
  sessionId: string,
): SessionSourceSnapshot {
  const database = openReadonly(databasePath);
  try {
    assertRequiredSchema(database);
    const row = database
      .query<SessionRow, [string]>(
        `SELECT
           id,
           version,
           agent,
           model,
           metadata,
           revert,
           time_created,
           time_updated,
           time_compacting
         FROM session
         WHERE id = ?`,
      )
      .get(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);

    const model = parseObject(row.model, "session.model");
    const session: LegacySession = {
      id: row.id,
      version: row.version,
      ...(row.agent === null ? {} : { agent: row.agent }),
      ...(model &&
      typeof model.id === "string" &&
      typeof model.providerID === "string"
        ? {
            model: {
              id: model.id,
              providerID: model.providerID,
              ...(typeof model.variant === "string"
                ? { variant: model.variant }
                : {}),
            },
          }
        : {}),
      ...(parseObject(row.metadata, "session.metadata")
        ? { metadata: parseObject(row.metadata, "session.metadata")! }
        : {}),
      ...(parseObject(row.revert, "session.revert")
        ? { revert: parseObject(row.revert, "session.revert")! }
        : {}),
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      ...(row.time_compacting === null
        ? {}
        : { timeCompacting: row.time_compacting }),
    };
    const fullSessionRow = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM session WHERE id = ?",
      )
      .get(sessionId)!;
    const {
      agent: _agent,
      model: _model,
      version: _version,
      time_updated: _timeUpdated,
      time_compacting: _timeCompacting,
      ...immutableSessionRow
    } = fullSessionRow;
    const sessionImmutableDigest = sha256(immutableSessionRow);

    const messages: LegacyMessage[] = database
      .query<MessageRow, [string]>(
        `SELECT id, session_id, time_created, time_updated, data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created, id`,
      )
      .all(sessionId)
      .map((message) => ({
        id: message.id,
        sessionId: message.session_id,
        timeCreated: message.time_created,
        timeUpdated: message.time_updated,
        data: parseObject(message.data, `message(${message.id}).data`)!,
      }));

    const parts: LegacyPart[] = database
      .query<PartRow, [string]>(
        `SELECT id, message_id, session_id, time_created, time_updated, data
         FROM part
         WHERE session_id = ?
         ORDER BY message_id, id`,
      )
      .all(sessionId)
      .map((part) => ({
        id: part.id,
        messageId: part.message_id,
        sessionId: part.session_id,
        timeCreated: part.time_created,
        timeUpdated: part.time_updated,
        data: parseObject(part.data, `part(${part.id}).data`)!,
      }));

    const events: StoredEvent[] = database
      .query<EventRow, [string]>(
        `SELECT id, aggregate_id, seq, type, data
         FROM event
         WHERE aggregate_id = ?
         ORDER BY seq`,
      )
      .all(sessionId)
      .map((event) => ({
        id: event.id,
        aggregateId: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: parseObject(event.data, `event(${event.id}).data`)!,
      }));

    const sequence = database
      .query<{ seq: number; owner_id: string | null }, [string]>(
        `SELECT seq, owner_id
         FROM event_sequence
         WHERE aggregate_id = ?`,
      )
      .get(sessionId);
    const v2MessageCount = database
      .query<CountRow, [string]>(
        "SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?",
      )
      .get(sessionId)!.count;
    const v2InputCount = database
      .query<CountRow, [string]>(
        "SELECT COUNT(*) AS count FROM session_input WHERE session_id = ?",
      )
      .get(sessionId)!.count;
    const pendingV2InputCount = database
      .query<CountRow, [string]>(
        `SELECT COUNT(*) AS count
         FROM session_input
         WHERE session_id = ?
           AND promoted_seq IS NULL`,
      )
      .get(sessionId)!.count;
    const contextEpochCount = database
      .query<CountRow, [string]>(
        `SELECT COUNT(*) AS count
         FROM session_context_epoch
         WHERE session_id = ?`,
      )
      .get(sessionId)!.count;

    return {
      session,
      messages,
      parts,
      events,
      ...(sequence
        ? {
            sequence: {
              seq: sequence.seq,
              ...(sequence.owner_id === null
                ? {}
                : { ownerId: sequence.owner_id }),
            },
          }
        : {}),
      v2MessageCount,
      v2InputCount,
      pendingV2InputCount,
      contextEpochCount,
      sessionImmutableDigest,
    };
  } finally {
    database.close();
  }
}

export function readV2SessionSemanticDigest(
  databasePath: string,
  sessionId: string,
): string {
  const database = openReadonly(databasePath);
  try {
    assertRequiredSchema(database);
    const session = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM session WHERE id = ?",
      )
      .get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const sequence = database
      .query<Record<string, unknown>, [string]>(
        `SELECT aggregate_id, seq, owner_id
         FROM event_sequence
         WHERE aggregate_id = ?`,
      )
      .get(sessionId);
    const events = database
      .query<EventRow, [string]>(
        `SELECT id, aggregate_id, seq, type, data
         FROM event
         WHERE aggregate_id = ?
         ORDER BY seq`,
      )
      .all(sessionId)
      .map((event) => ({
        ...event,
        data: parseJson(event.data, `event(${event.id}).data`),
      }));
    const legacyMessages = database
      .query<MessageRow, [string]>(
        `SELECT id, session_id, time_created, time_updated, data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created, id`,
      )
      .all(sessionId)
      .map((message) => ({
        ...message,
        data: parseJson(
          message.data,
          `message(${message.id}).data`,
        ),
      }));
    const legacyParts = database
      .query<PartRow, [string]>(
        `SELECT id, message_id, session_id, time_created, time_updated, data
         FROM part
         WHERE session_id = ?
         ORDER BY message_id, id`,
      )
      .all(sessionId)
      .map((part) => ({
        ...part,
        data: parseJson(part.data, `part(${part.id}).data`),
      }));
    const messages = database
      .query<Record<string, unknown>, [string]>(
        `SELECT id, session_id, type, seq, time_created, data
         FROM session_message
         WHERE session_id = ?
         ORDER BY seq`,
      )
      .all(sessionId)
      .map((message) => ({
        ...message,
        data: parseJson(message.data as string, "session_message.data"),
      }));
    const inputs = database
      .query<Record<string, unknown>, [string]>(
        `SELECT
           id,
           session_id,
           prompt,
           delivery,
           admitted_seq,
           promoted_seq,
           time_created
         FROM session_input
         WHERE session_id = ?
         ORDER BY admitted_seq`,
      )
      .all(sessionId)
      .map((input) => ({
        ...input,
        prompt: parseJson(input.prompt as string, "session_input.prompt"),
      }));
    const contextEpochs = database
      .query<Record<string, unknown>, [string]>(
        `SELECT session_id, baseline, snapshot, baseline_seq
         FROM session_context_epoch
         WHERE session_id = ?
         ORDER BY session_id`,
      )
      .all(sessionId);
    return sha256({
      session,
      sequence,
      events,
      legacyMessages,
      legacyParts,
      messages,
      inputs,
      contextEpochs,
    });
  } finally {
    database.close();
  }
}

export function readDatabaseChecks(databasePath: string): {
  quickCheck: string[];
  foreignKeyViolations: Record<string, unknown>[];
} {
  const database = openReadonly(databasePath);
  try {
    const quickCheck = database
      .query<Record<string, string>, []>("PRAGMA quick_check")
      .all()
      .flatMap((row) => Object.values(row));
    const foreignKeyViolations = database
      .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
      .all();
    return { quickCheck, foreignKeyViolations };
  } finally {
    database.close();
  }
}
