import { Database } from "bun:sqlite";
import type {
  ExpectedSessionInput,
  ExpectedSessionMessage,
  JsonObject,
  MigrationPlan,
  MigrationVerification,
  SessionMigrationPlan,
  SessionVerification,
} from "./contracts";
import { versionedType } from "./recipe-v1-to-v2";
import {
  readDatabaseChecks,
  readSessionSourceSnapshot,
  readV2SessionSemanticDigest,
  resolveDatabasePath,
} from "./sqlite-source";
import { asObject, sha256, stableJson } from "./stable";

interface EventRow {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  type: ExpectedSessionMessage["type"];
  seq: number;
  time_created: number;
  data: string;
}

interface InputRow {
  id: string;
  session_id: string;
  prompt: string;
  delivery: "steer" | "queue";
  admitted_seq: number;
  promoted_seq: number | null;
  time_created: number;
}

interface SessionStateRow {
  agent: string | null;
  model: string | null;
  time_updated: number;
}

function parseObject(value: string, field: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    const object = asObject(parsed);
    if (!object) throw new Error();
    return object;
  } catch {
    throw new Error(`${field} is not valid JSON object`);
  }
}

function readActualMessages(
  database: Database,
  sessionId: string,
): ExpectedSessionMessage[] {
  return database
    .query<MessageRow, [string]>(
      `SELECT id, session_id, type, seq, time_created, data
       FROM session_message
       WHERE session_id = ?
       ORDER BY seq`,
    )
    .all(sessionId)
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      seq: row.seq,
      timeCreated: row.time_created,
      data: parseObject(row.data, `session_message(${row.id}).data`),
    }));
}

function readActualInputs(
  database: Database,
  sessionId: string,
): ExpectedSessionInput[] {
  return database
    .query<InputRow, [string]>(
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
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      prompt: parseObject(row.prompt, `session_input(${row.id}).prompt`),
      delivery: row.delivery as "steer",
      admittedSeq: row.admitted_seq,
      promotedSeq: row.promoted_seq ?? -1,
      timeCreated: row.time_created,
    }));
}

function verifyNoDangling(
  messages: readonly ExpectedSessionMessage[],
): string[] {
  const errors: string[] = [];
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    const time = asObject(message.data.time);
    if (typeof time?.completed !== "number") {
      errors.push(`assistant ${message.id} is not settled`);
    }
    const content = message.data.content;
    if (!Array.isArray(content)) {
      errors.push(`assistant ${message.id} has invalid content`);
      continue;
    }
    for (const entry of content) {
      const item = asObject(entry);
      if (item?.type !== "tool") continue;
      const state = asObject(item.state);
      if (state?.status !== "completed" && state?.status !== "error") {
        errors.push(`assistant ${message.id} tool ${String(item.id)} is dangling`);
      }
    }
  }
  return errors;
}

function verifySession(
  databasePath: string,
  database: Database,
  plan: SessionMigrationPlan,
  expectLegacyRemoved: boolean,
  allowContinuationSuffix: boolean,
): SessionVerification {
  const errors: string[] = [];
  const sourceSnapshot = readSessionSourceSnapshot(
    databasePath,
    plan.sessionId,
  );
  if (
    sourceSnapshot.sessionImmutableDigest !==
    plan.sourceSessionImmutableDigest
  ) {
    errors.push("immutable session fields differ from the migration plan");
  }
  const events = database
    .query<EventRow, [string, number, number]>(
      `SELECT id, aggregate_id, seq, type, data
       FROM event
       WHERE aggregate_id = ?
         AND seq BETWEEN ? AND ?
       ORDER BY seq`,
    )
    .all(plan.sessionId, plan.baseSeq + 1, plan.targetLastSeq);
  const normalizedEvents = events.map((event) => ({
    id: event.id,
    aggregateID: event.aggregate_id,
    seq: event.seq,
    type: event.type,
    data: parseObject(event.data, `event(${event.id}).data`),
  }));
  const expectedEvents = plan.events.map((event) => ({
    ...event,
    type: versionedType(event.type),
  }));
  if (stableJson(normalizedEvents) !== stableJson(expectedEvents)) {
    errors.push("durable event suffix differs from migration plan");
  }

  const sequence = database
    .query<{ seq: number }, [string]>(
      "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
    )
    .get(plan.sessionId);
  if (
    sequence === null ||
    sequence === undefined ||
    (allowContinuationSuffix
      ? sequence.seq < plan.targetLastSeq
      : sequence.seq !== plan.targetLastSeq)
  ) {
    errors.push(
      `event_sequence is ${sequence?.seq ?? "missing"}, expected ${plan.targetLastSeq}`,
    );
  }
  if (
    allowContinuationSuffix &&
    sequence !== null &&
    sequence !== undefined &&
    sequence.seq >= plan.targetLastSeq
  ) {
    const suffix = database
      .query<{ count: number; maximum: number | null }, [string, number]>(
        `SELECT COUNT(*) AS count, MAX(seq) AS maximum
         FROM event
         WHERE aggregate_id = ?
           AND seq > ?`,
      )
      .get(plan.sessionId, plan.targetLastSeq)!;
    const expectedSuffixCount = sequence.seq - plan.targetLastSeq;
    if (
      suffix.count !== expectedSuffixCount ||
      (expectedSuffixCount > 0 && suffix.maximum !== sequence.seq)
    ) {
      errors.push(
        "continuation event suffix is not contiguous with event_sequence",
      );
    }
  }

  const messages = readActualMessages(database, plan.sessionId);
  const inputs = readActualInputs(database, plan.sessionId);
  const sessionRow = database
    .query<SessionStateRow, [string]>(
      "SELECT agent, model, time_updated FROM session WHERE id = ?",
    )
    .get(plan.sessionId);
  if (!sessionRow) {
    errors.push("session row is missing");
  }
  const sessionState = {
    ...(sessionRow?.agent === null || sessionRow?.agent === undefined
      ? {}
      : { agent: sessionRow.agent }),
    ...(sessionRow?.model === null || sessionRow?.model === undefined
      ? {}
      : {
          model: parseObject(
            sessionRow.model,
            `session(${plan.sessionId}).model`,
          ),
        }),
    ...(sessionRow == null
      ? {}
      : { timeUpdated: sessionRow.time_updated }),
  };
  const expectedMessagesMatch = allowContinuationSuffix
    ? messages.length >= plan.expectedMessages.length &&
      stableJson(messages.slice(0, plan.expectedMessages.length)) ===
        stableJson(plan.expectedMessages)
    : stableJson(messages) === stableJson(plan.expectedMessages);
  if (!expectedMessagesMatch) {
    errors.push("session_message projection differs from expected projection");
  }
  const expectedInputsMatch = allowContinuationSuffix
    ? inputs.length >= plan.expectedInputs.length &&
      stableJson(inputs.slice(0, plan.expectedInputs.length)) ===
        stableJson(plan.expectedInputs)
    : stableJson(inputs) === stableJson(plan.expectedInputs);
  if (!expectedInputsMatch) {
    errors.push("session_input projection differs from expected projection");
  }
  if (inputs.some((input) => input.promotedSeq < 0)) {
    errors.push("session has pending V2 input");
  }
  errors.push(...verifyNoDangling(messages));
  if (
    !allowContinuationSuffix &&
    sha256(sessionState) !== plan.expectedSessionStateDigest
  ) {
    errors.push("session agent/model state differs from migration plan");
  }

  if (expectLegacyRemoved) {
    const legacy = database
      .query<
        { messages: number; parts: number },
        [string, string]
      >(
        `SELECT
           (SELECT COUNT(*) FROM message WHERE session_id = ?) AS messages,
           (SELECT COUNT(*) FROM part WHERE session_id = ?) AS parts`,
      )
      .get(plan.sessionId, plan.sessionId)!;
    if (legacy.messages !== 0 || legacy.parts !== 0) {
      errors.push(
        "legacy projections remain: " +
          `message=${legacy.messages}, part=${legacy.parts}`,
      );
    }
  }

  const semanticDigest = sha256({
    messages,
    inputs,
    session: sessionState,
  });
  if (
    !allowContinuationSuffix &&
    semanticDigest !== plan.targetSemanticDigest
  ) {
    errors.push("target semantic digest differs from migration plan");
  }

  return {
    sessionId: plan.sessionId,
    verified: errors.length === 0,
    eventCount: events.length,
    messageCount: messages.length,
    inputCount: inputs.length,
    semanticDigest,
    errors,
  };
}

export function verifyMigration(
  databasePath: string,
  plan: MigrationPlan,
  options: {
    expectLegacyRemoved?: boolean;
    allowContinuationSuffix?: boolean;
  } = {},
): MigrationVerification {
  const resolved = resolveDatabasePath(databasePath);
  const database = new Database(resolved, { readonly: true, strict: true });
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    const sessions = plan.sessions
      .filter(
        (session) =>
          session.state === "eligible" || session.state === "resumable",
      )
      .map((session) =>
        verifySession(
          resolved,
          database,
          session,
          options.expectLegacyRemoved === true,
          options.allowContinuationSuffix === true,
        ),
      );

    for (const protectedSession of plan.protectedSessions) {
      const current =
        protectedSession.kind === "v2"
          ? readV2SessionSemanticDigest(
              resolved,
              protectedSession.sessionId,
            )
          : sha256(
              readSessionSourceSnapshot(
                resolved,
                protectedSession.sessionId,
              ),
            );
      if (current !== protectedSession.semanticDigest) {
        sessions.push({
          sessionId: protectedSession.sessionId,
          verified: false,
          eventCount: 0,
          messageCount: 0,
          inputCount: 0,
          errors: [
            `protected ${protectedSession.kind} session semantic digest changed`,
          ],
        });
      }
    }

    const checks = readDatabaseChecks(resolved);
    if (
      checks.quickCheck.length !== 1 ||
      checks.quickCheck[0]?.toLowerCase() !== "ok" ||
      checks.foreignKeyViolations.length > 0
    ) {
      sessions.push({
        sessionId: "<database>",
        verified: false,
        eventCount: 0,
        messageCount: 0,
        inputCount: 0,
        errors: [
          `quick_check=${checks.quickCheck.join(",")}`,
          `foreign_key_violations=${checks.foreignKeyViolations.length}`,
        ],
      });
    }

    return {
      planDigest: plan.planDigest,
      verified:
        sessions.length > 0 && sessions.every((session) => session.verified),
      sessions,
    };
  } finally {
    database.close();
  }
}
