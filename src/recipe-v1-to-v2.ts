/** Fail-closed V1 snapshot to pinned V2 durable-event recipe. */
import {
  MIGRATION_RECIPE_ID,
  MIGRATION_TARGET_PROFILE,
  type JsonObject,
  type LegacyMessage,
  type LegacyPart,
  type MigrationDiagnostic,
  type ReplayEvent,
  type SessionMigrationPlan,
  type SessionSourceSnapshot,
  type StoredEvent,
} from "./contracts";
import { projectReplayEvents } from "./projector";
import {
  asFiniteNumber,
  asObject,
  asString,
  deterministicId,
  sha256,
  stableJson,
} from "./stable";

const LEGACY_EVENT_TYPES = new Set([
  "session.created.1",
  "session.updated.1",
  "message.updated.1",
  "message.removed.1",
  "message.part.updated.1",
  "message.part.removed.1",
]);

const EVENT_VERSION: Readonly<Record<string, number>> = {
  "session.next.agent.switched": 1,
  "session.next.model.switched": 1,
  "session.next.prompted": 1,
  "session.next.synthetic": 1,
  "session.next.step.started": 1,
  "session.next.step.ended": 2,
  "session.next.step.failed": 2,
  "session.next.text.started": 1,
  "session.next.text.ended": 1,
  "session.next.reasoning.started": 1,
  "session.next.reasoning.ended": 1,
  "session.next.tool.input.started": 1,
  "session.next.tool.input.ended": 1,
  "session.next.tool.called": 1,
  "session.next.tool.success": 1,
  "session.next.tool.failed": 1,
  "session.next.retried": 1,
};

type DiagnosticInput = Omit<MigrationDiagnostic, "sessionId" | "severity"> & {
  severity?: MigrationDiagnostic["severity"];
};

interface SessionSelectionState {
  agent?: string;
  model?: JsonObject;
  timeUpdated: number;
}

function info(message: LegacyMessage): JsonObject {
  return {
    ...message.data,
    id: message.id,
    sessionID: message.sessionId,
  };
}

function part(partRow: LegacyPart): JsonObject {
  return {
    ...partRow.data,
    id: partRow.id,
    messageID: partRow.messageId,
    sessionID: partRow.sessionId,
  };
}

export function versionedType(type: string): string {
  const version = EVENT_VERSION[type];
  if (version === undefined) {
    throw new Error(`Missing durable version for ${type}`);
  }
  return `${type}.${version}`;
}

function sourceDigest(snapshot: SessionSourceSnapshot): string {
  return sha256({
    recipeId: MIGRATION_RECIPE_ID,
    targetProfile: MIGRATION_TARGET_PROFILE,
    // Official V2 agent/model projectors update agent, model and
    // time_updated while replaying. They are intentionally excluded so a
    // deterministic replay prefix can be recognized after a crash. The
    // historical per-turn agent/model/timestamps remain covered by messages,
    // parts and legacy events below.
    session: {
      id: snapshot.session.id,
      version: snapshot.session.version,
      metadata: snapshot.session.metadata,
      revert: snapshot.session.revert,
      timeCreated: snapshot.session.timeCreated,
      timeCompacting: snapshot.session.timeCompacting,
    },
    sessionImmutableDigest: snapshot.sessionImmutableDigest,
    messages: snapshot.messages,
    parts: snapshot.parts,
    legacyEvents: snapshot.events.filter((event) =>
      LEGACY_EVENT_TYPES.has(event.type),
    ),
  });
}

function validateEventStream(
  snapshot: SessionSourceSnapshot,
  diagnostic: (input: DiagnosticInput) => void,
): {
  legacyEvents: StoredEvent[];
  v2Events: StoredEvent[];
  baseSeq: number;
} {
  if (!snapshot.sequence) {
    diagnostic({
      code: "MISSING_EVENT_SEQUENCE",
      message: "session has no event_sequence row",
    });
    return { legacyEvents: [], v2Events: [], baseSeq: -1 };
  }

  const ordered = [...snapshot.events].sort((left, right) => left.seq - right.seq);
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index]?.seq !== index) {
      diagnostic({
        code: "EVENT_SEQUENCE_GAP",
        message: `event sequence is not contiguous at ${index}`,
      });
      break;
    }
  }
  const maximum = ordered.at(-1)?.seq ?? -1;
  if (maximum !== snapshot.sequence.seq) {
    diagnostic({
      code: "EVENT_SEQUENCE_MISMATCH",
      message: `event_sequence=${snapshot.sequence.seq}, max(event.seq)=${maximum}`,
    });
  }

  const legacyEvents: StoredEvent[] = [];
  const v2Events: StoredEvent[] = [];
  for (const event of ordered) {
    if (LEGACY_EVENT_TYPES.has(event.type)) {
      legacyEvents.push(event);
      continue;
    }
    if (event.type.startsWith("session.next.")) {
      v2Events.push(event);
      continue;
    }
    diagnostic({
      code: "CORRUPT_LEGACY_EVENTS",
      message: "unsupported durable event type",
      rawDigest: sha256(event),
    });
  }

  // /sync/replay claims an unowned aggregate on its first appended event.
  // A claimed aggregate is safe only when its V2 suffix is later proven to be
  // an exact deterministic prefix of this migration plan.
  if (snapshot.sequence.ownerId && v2Events.length === 0) {
    diagnostic({
      code: "OWNER_CONFLICT",
      message: "event aggregate is owned by sync and cannot be appended safely",
    });
  }

  const firstV2 = v2Events[0]?.seq;
  if (
    firstV2 !== undefined &&
    legacyEvents.some((event) => event.seq > firstV2)
  ) {
    diagnostic({
      code: "CORRUPT_LEGACY_EVENTS",
      message: "legacy and V2 durable events are interleaved",
    });
  }

  const roots = legacyEvents.filter(
    (event) => event.type === "session.created.1",
  );
  if (roots.length !== 1) {
    diagnostic({
      code: "CORRUPT_LEGACY_EVENTS",
      message: `expected one session.created.1 event, found ${roots.length}`,
    });
  }

  return {
    legacyEvents,
    v2Events,
    baseSeq: legacyEvents.at(-1)?.seq ?? -1,
  };
}

function readLegacySessionState(
  legacyEvents: readonly StoredEvent[],
  diagnostic: (input: DiagnosticInput) => void,
): SessionSelectionState | undefined {
  let result: SessionSelectionState | undefined;
  for (const event of legacyEvents) {
    if (
      event.type !== "session.created.1" &&
      event.type !== "session.updated.1"
    ) {
      continue;
    }
    const value = asObject(event.data.info);
    const time = value && asObject(value.time);
    const timeUpdated = time && asFiniteNumber(time.updated);
    if (!value || timeUpdated === undefined) {
      diagnostic({
        code: "CORRUPT_LEGACY_EVENTS",
        message: `invalid session info event at seq ${event.seq}`,
        rawDigest: sha256(event),
      });
      continue;
    }
    const agentValue = value.agent;
    const agent =
      agentValue === undefined || agentValue === null
        ? undefined
        : asString(agentValue);
    if (
      agentValue !== undefined &&
      agentValue !== null &&
      agent === undefined
    ) {
      diagnostic({
        code: "CORRUPT_LEGACY_EVENTS",
        message: `invalid session agent at seq ${event.seq}`,
        rawDigest: sha256(event),
      });
      continue;
    }
    const modelValue = value.model;
    const modelObject =
      modelValue === undefined || modelValue === null
        ? undefined
        : asObject(modelValue);
    const modelId = modelObject && asString(modelObject.id);
    const providerId = modelObject && asString(modelObject.providerID);
    const variantValue = modelObject?.variant;
    const variant =
      variantValue === undefined || variantValue === null
        ? undefined
        : asString(variantValue);
    if (
      modelValue !== undefined &&
      modelValue !== null &&
      (!modelObject ||
        !modelId ||
        !providerId ||
        (variantValue !== undefined &&
          variantValue !== null &&
          variant === undefined))
    ) {
      diagnostic({
        code: "CORRUPT_LEGACY_EVENTS",
        message: `invalid session model at seq ${event.seq}`,
        rawDigest: sha256(event),
      });
      continue;
    }
    result = {
      ...(agent === undefined ? {} : { agent }),
      ...(modelObject && modelId && providerId
        ? {
            model: {
              id: modelId,
              providerID: providerId,
              ...(variant === undefined ? {} : { variant }),
            },
          }
        : {}),
      timeUpdated,
    };
  }
  return result;
}

function projectExistingSessionState(
  initial: SessionSelectionState,
  v2Events: readonly StoredEvent[],
  diagnostic: (input: DiagnosticInput) => void,
): SessionSelectionState {
  const result: SessionSelectionState = structuredClone(initial);
  for (const event of v2Events) {
    if (
      event.type !== "session.next.agent.switched.1" &&
      event.type !== "session.next.model.switched.1"
    ) {
      continue;
    }
    const timestamp = asFiniteNumber(event.data.timestamp);
    if (timestamp === undefined) {
      diagnostic({
        code: "MIXED_EVENT_DIVERGENCE",
        message: `invalid V2 session switch at seq ${event.seq}`,
        rawDigest: sha256(event),
      });
      continue;
    }
    if (event.type === "session.next.agent.switched.1") {
      const agent = asString(event.data.agent);
      if (!agent) {
        diagnostic({
          code: "MIXED_EVENT_DIVERGENCE",
          message: `invalid V2 agent switch at seq ${event.seq}`,
          rawDigest: sha256(event),
        });
        continue;
      }
      result.agent = agent;
      result.timeUpdated = timestamp;
      continue;
    }
    const model = asObject(event.data.model);
    if (!model) {
      diagnostic({
        code: "MIXED_EVENT_DIVERGENCE",
        message: `invalid V2 model switch at seq ${event.seq}`,
        rawDigest: sha256(event),
      });
      continue;
    }
    result.model = structuredClone(model);
    result.timeUpdated = timestamp;
  }
  return result;
}

function nonSemanticStalePart(value: JsonObject): boolean {
  const type = asString(value.type);
  const keys = Object.keys(value);
  if (type === "step-start") {
    return keys.every((key) =>
      ["id", "messageID", "sessionID", "type"].includes(key)
    );
  }
  if (type !== "reasoning" || asString(value.text) !== "") return false;
  if (
    !keys.every((key) =>
      ["id", "messageID", "sessionID", "type", "text", "time"].includes(
        key,
      )
    )
  ) {
    return false;
  }
  if (value.time === undefined) return true;
  const time = asObject(value.time);
  return (
    time !== undefined &&
    Object.keys(time).every((key) => ["start", "end"].includes(key)) &&
    Object.values(time).every(
      (entry) => asFiniteNumber(entry) !== undefined,
    )
  );
}

function nonSemanticStaleAssistant(
  value: JsonObject,
  attachedParts: readonly JsonObject[],
): boolean {
  if (asString(value.role) !== "assistant") return false;
  const time = asObject(value.time);
  const completed = time && asFiniteNumber(time.completed);
  const hasError = asObject(value.error) !== undefined;
  if (completed !== undefined && !hasError) return false;
  return attachedParts.every(nonSemanticStalePart);
}

function normalizedEmptyErrorRaw(
  eventPart: JsonObject,
  storedPart: JsonObject,
): JsonObject | undefined {
  const eventState = asObject(eventPart.state);
  const storedState = asObject(storedPart.state);
  if (
    asString(eventPart.type) !== "tool" ||
    asString(storedPart.type) !== "tool" ||
    asString(eventState?.status) !== "error" ||
    asString(storedState?.status) !== "error" ||
    eventState === undefined ||
    storedState === undefined ||
    "raw" in eventState ||
    storedState.raw !== ""
  ) {
    return undefined;
  }
  const normalized = structuredClone(storedPart);
  const normalizedState = asObject(normalized.state);
  if (!normalizedState) return undefined;
  delete normalizedState.raw;
  return stableJson(eventPart) === stableJson(normalized)
    ? structuredClone(storedPart)
    : undefined;
}

function validateLegacyProjection(
  snapshot: SessionSourceSnapshot,
  legacyEvents: readonly StoredEvent[],
  v2Events: readonly StoredEvent[],
  diagnostic: (input: DiagnosticInput) => void,
): SessionSelectionState | undefined {
  const messages = new Map<string, JsonObject>();
  const parts = new Map<string, JsonObject>();

  for (const event of legacyEvents) {
    if (event.type === "message.updated.1") {
      const value = asObject(event.data.info);
      const id = value && asString(value.id);
      if (!value || !id) {
        diagnostic({
          code: "CORRUPT_LEGACY_EVENTS",
          message: `invalid message.updated.1 event at seq ${event.seq}`,
          rawDigest: sha256(event),
        });
      } else {
        messages.set(id, value);
      }
    }
    if (event.type === "message.removed.1") {
      const id = asString(event.data.messageID);
      if (id) {
        messages.delete(id);
        for (const [partId, value] of parts) {
          if (asString(value.messageID) === id) parts.delete(partId);
        }
      }
    }
    if (event.type === "message.part.updated.1") {
      const value = asObject(event.data.part);
      const id = value && asString(value.id);
      if (!value || !id) {
        diagnostic({
          code: "CORRUPT_LEGACY_EVENTS",
          message: `invalid message.part.updated.1 event at seq ${event.seq}`,
          rawDigest: sha256(event),
        });
      } else {
        parts.set(id, value);
      }
    }
    if (event.type === "message.part.removed.1") {
      const id = asString(event.data.partID);
      if (id) parts.delete(id);
    }
  }

  const storedMessages = new Map(
    snapshot.messages.map((message) => [message.id, info(message)]),
  );
  const storedParts = new Map(
    snapshot.parts.map((partRow) => [partRow.id, part(partRow)]),
  );

  const eventOnlyMessages = [...messages.keys()].filter(
    (id) => !storedMessages.has(id),
  );
  const storedOnlyMessages = [...storedMessages.keys()].filter(
    (id) => !messages.has(id),
  );
  const eventOnlyParts = [...parts.keys()].filter(
    (id) => !storedParts.has(id),
  );
  const storedOnlyParts = [...storedParts.keys()].filter(
    (id) => !parts.has(id),
  );
  const eventOnlyMessageSet = new Set(eventOnlyMessages);
  const staleTailIsNonSemantic =
    eventOnlyMessages.length > 0 &&
    storedOnlyMessages.length === 0 &&
    storedOnlyParts.length === 0 &&
    eventOnlyParts.every((id) =>
      eventOnlyMessageSet.has(asString(parts.get(id)?.messageID) ?? "")
    ) &&
    eventOnlyMessages.every((id) => {
      const value = messages.get(id);
      if (!value) return false;
      const attached = eventOnlyParts
        .map((partId) => parts.get(partId))
        .filter(
          (candidate): candidate is JsonObject =>
            candidate !== undefined &&
            asString(candidate.messageID) === id,
        );
      return nonSemanticStaleAssistant(value, attached);
    });
  if (staleTailIsNonSemantic) {
    for (const id of eventOnlyMessages) messages.delete(id);
    for (const id of eventOnlyParts) parts.delete(id);
    diagnostic({
      severity: "warning",
      code: "NORMALIZED_STALE_EVENT_TAIL",
      message:
        "non-semantic assistant events absent from the V1 projection are retained as durable history but excluded from V2 context",
      rawDigest: sha256({
        messages: [...eventOnlyMessages].sort(),
        parts: [...eventOnlyParts].sort(),
      }),
    });
  }

  for (const [id, eventPart] of parts) {
    const storedPart = storedParts.get(id);
    if (
      !storedPart ||
      stableJson(eventPart) === stableJson(storedPart)
    ) {
      continue;
    }
    const normalized = normalizedEmptyErrorRaw(eventPart, storedPart);
    if (!normalized) continue;
    parts.set(id, normalized);
    diagnostic({
      severity: "warning",
      code: "NORMALIZED_EXECUTION_FIELD",
      message:
        "empty pending-tool raw input retained by the V1 projection is execution-only for a settled error",
      partId: id,
      path: "state.raw",
      rawDigest: sha256({ eventPart, storedPart }),
    });
  }

  if (
    stableJson([...messages.entries()].sort()) !==
    stableJson([...storedMessages.entries()].sort())
  ) {
    diagnostic({
      code: "LEGACY_PROJECTION_DIVERGENCE",
      message: "legacy message rows differ from replayed V1 events",
    });
  }
  if (
    stableJson([...parts.entries()].sort()) !==
    stableJson([...storedParts.entries()].sort())
  ) {
    diagnostic({
      code: "LEGACY_PROJECTION_DIVERGENCE",
      message: "legacy part rows differ from replayed V1 events",
    });
  }

  const sourceState = readLegacySessionState(legacyEvents, diagnostic);
  if (!sourceState) {
    diagnostic({
      code: "LEGACY_PROJECTION_DIVERGENCE",
      message: "legacy event stream has no usable session state",
    });
    return undefined;
  }
  const expectedCurrent = projectExistingSessionState(
    sourceState,
    v2Events,
    diagnostic,
  );
  const storedCurrent = {
    ...(snapshot.session.agent === undefined
      ? {}
      : { agent: snapshot.session.agent }),
    ...(snapshot.session.model === undefined
      ? {}
      : { model: structuredClone(snapshot.session.model) }),
    timeUpdated: snapshot.session.timeUpdated,
  };
  const sameSelection =
    storedCurrent.agent === expectedCurrent.agent &&
    stableJson(storedCurrent.model) === stableJson(expectedCurrent.model);
  if (
    sameSelection &&
    storedCurrent.timeUpdated > expectedCurrent.timeUpdated
  ) {
    diagnostic({
      severity: "warning",
      code: "NORMALIZED_SESSION_TOUCH",
      message:
        "session update time advanced without changing agent or model; the later stored time is preserved",
      path: "session.time.updated",
      rawDigest: sha256({
        projected: expectedCurrent.timeUpdated,
        stored: storedCurrent.timeUpdated,
      }),
    });
    return storedCurrent;
  }
  if (stableJson(storedCurrent) !== stableJson(expectedCurrent)) {
    diagnostic({
      code: "LEGACY_PROJECTION_DIVERGENCE",
      message:
        "session agent/model/update-time differs from its durable event projection",
    });
  }
  return sourceState;
}

function requiredString(
  value: unknown,
  input: {
    diagnostic: (input: DiagnosticInput) => void;
    message: LegacyMessage;
    path: string;
  },
): string | undefined {
  const result = asString(value);
  if (result === undefined) {
    input.diagnostic({
      code: "UNSUPPORTED_SOURCE_FIELD",
      message: `${input.path} must be a string`,
      messageId: input.message.id,
      path: input.path,
    });
  }
  return result;
}

function requiredNumber(
  value: unknown,
  input: {
    diagnostic: (input: DiagnosticInput) => void;
    message: LegacyMessage;
    path: string;
  },
): number | undefined {
  const result = asFiniteNumber(value);
  if (result === undefined) {
    input.diagnostic({
      code: "UNSUPPORTED_SOURCE_FIELD",
      message: `${input.path} must be a finite number`,
      messageId: input.message.id,
      path: input.path,
    });
  }
  return result;
}

function modelRef(
  value: unknown,
  input: {
    diagnostic: (input: DiagnosticInput) => void;
    message: LegacyMessage;
    path: string;
    assistant: boolean;
  },
): JsonObject | undefined {
  const model = asObject(value);
  const providerID = model && asString(model.providerID);
  const id = model
    ? asString(input.assistant ? model.modelID : model.modelID)
    : undefined;
  if (!model || !providerID || !id) {
    input.diagnostic({
      code: "UNSUPPORTED_SOURCE_FIELD",
      message: `${input.path} has no providerID/modelID`,
      messageId: input.message.id,
      path: input.path,
    });
    return undefined;
  }
  return {
    providerID,
    id,
    variant: asString(model.variant) ?? "default",
  };
}

function tokens(
  value: unknown,
  input: {
    diagnostic: (input: DiagnosticInput) => void;
    message: LegacyMessage;
    path: string;
  },
): JsonObject | undefined {
  const token = asObject(value);
  const cache = token && asObject(token.cache);
  const result = {
    input: token && asFiniteNumber(token.input),
    output: token && asFiniteNumber(token.output),
    reasoning: token && asFiniteNumber(token.reasoning),
    read: cache && asFiniteNumber(cache.read),
    write: cache && asFiniteNumber(cache.write),
  };
  if (Object.values(result).some((entry) => entry === undefined)) {
    input.diagnostic({
      code: "UNSUPPORTED_SOURCE_FIELD",
      message: `${input.path} has an unsupported token shape`,
      messageId: input.message.id,
      path: input.path,
    });
    return undefined;
  }
  return {
    input: result.input!,
    output: result.output!,
    reasoning: result.reasoning!,
    cache: { read: result.read!, write: result.write! },
  };
}

function zeroTokens(): JsonObject {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
}

function providerMetadata(
  value: unknown,
  input: {
    diagnostic: (input: DiagnosticInput) => void;
    message: LegacyMessage;
    part: LegacyPart;
    path: string;
    exclude?: readonly string[];
  },
): JsonObject | undefined {
  if (value === undefined) return undefined;
  const metadata = asObject(value);
  if (!metadata) {
    input.diagnostic({
      code: "UNSUPPORTED_SOURCE_FIELD",
      message: `${input.path} must be an object`,
      messageId: input.message.id,
      partId: input.part.id,
      path: input.path,
    });
    return undefined;
  }
  const excluded = new Set(input.exclude ?? []);
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(metadata)) {
    if (excluded.has(key)) continue;
    const nested = asObject(entry);
    if (!nested) {
      input.diagnostic({
        code: "UNSUPPORTED_SOURCE_FIELD",
        message: `${input.path} contains invalid provider metadata`,
        messageId: input.message.id,
        partId: input.part.id,
        path: input.path,
        rawDigest: sha256({ key, entry }),
      });
      continue;
    }
    result[key] = structuredClone(nested);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

interface AssistantSegment {
  start?: LegacyPart;
  parts: LegacyPart[];
  contextPartCount: number;
}

function isAssistantContextPart(partRow: LegacyPart): boolean {
  return (
    partRow.data.type === "text" ||
    partRow.data.type === "reasoning" ||
    partRow.data.type === "tool"
  );
}

/**
 * Vercel AI SDK 6 flushes the current assistant block whenever it encounters
 * a step-start part. V2 persists one assistant row per provider block, so a
 * V1 assistant with multiple step-start markers must be split into stable,
 * unique V2 assistant messages to preserve the same LLM message ordering.
 */
function splitAssistantSegments(
  messageParts: readonly LegacyPart[],
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let current: AssistantSegment = {
    parts: [],
    contextPartCount: 0,
  };

  for (const partRow of messageParts) {
    if (partRow.data.type === "step-start") {
      if (current.contextPartCount > 0) {
        segments.push(current);
        current = {
          start: partRow,
          parts: [],
          contextPartCount: 0,
        };
      } else {
        // Consecutive leading markers flush no AI SDK block. Keep the latest
        // marker so its snapshot is attached if content eventually follows.
        current.start = partRow;
      }
      continue;
    }

    current.parts.push(partRow);
    if (isAssistantContextPart(partRow)) current.contextPartCount++;
  }

  if (
    current.contextPartCount > 0 ||
    current.parts.length > 0 ||
    segments.length === 0
  ) {
    segments.push(current);
  }
  return segments;
}

function buildEvents(
  snapshot: SessionSourceSnapshot,
  digest: string,
  baseSeq: number,
  targetSessionState: SessionSelectionState | undefined,
  diagnostic: (input: DiagnosticInput) => void,
): ReplayEvent[] {
  const partsByMessage = new Map<string, LegacyPart[]>();
  for (const partRow of snapshot.parts) {
    const list = partsByMessage.get(partRow.messageId);
    if (list) list.push(partRow);
    else partsByMessage.set(partRow.messageId, [partRow]);
  }
  for (const list of partsByMessage.values()) {
    // Pinned V1 hydration orders parts by message_id/id.
    list.sort((left, right) => left.id.localeCompare(right.id));
  }

  const events: ReplayEvent[] = [];
  let ordinal = 0;
  const emit = (input: {
    type: string;
    data: JsonObject;
    source: string;
    kind: string;
  }) => {
    const seq = baseSeq + events.length + 1;
    events.push({
      id: deterministicId(
        "evt_",
        MIGRATION_RECIPE_ID,
        MIGRATION_TARGET_PROFILE,
        digest,
        snapshot.session.id,
        input.source,
        input.kind,
        ordinal++,
      ),
      aggregateID: snapshot.session.id,
      seq,
      type: input.type,
      data: input.data,
    });
  };

  let currentAgent: string | undefined;
  let currentModel: JsonObject | undefined;
  const messages = [...snapshot.messages].sort(
    (left, right) =>
      left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
  );

  for (const message of messages) {
    const value = info(message);
    const role = asString(value.role);
    const messageParts = partsByMessage.get(message.id) ?? [];
    if (role === "user") {
      const agent = requiredString(value.agent, {
        diagnostic,
        message,
        path: "message.agent",
      });
      const model = modelRef(value.model, {
        diagnostic,
        message,
        path: "message.model",
        assistant: false,
      });
      const time = asObject(value.time);
      const timestamp = requiredNumber(time?.created, {
        diagnostic,
        message,
        path: "message.time.created",
      });
      if (!agent || !model || timestamp === undefined) continue;

      if (value.system !== undefined) {
        diagnostic({
          severity: "warning",
          code: "UNSUPPORTED_SOURCE_FIELD",
          message:
            "legacy per-turn system override is retained in legacy events but excluded from V2 continuation history",
          messageId: message.id,
          path: "message.system",
        });
      }
      if (value.tools !== undefined || value.format !== undefined) {
        diagnostic({
          severity: "warning",
          code: "UNSUPPORTED_SOURCE_FIELD",
          message:
            "legacy per-turn tools/format are execution-only and are not copied",
          messageId: message.id,
        });
      }

      if (currentAgent !== agent) {
        emit({
          type: "session.next.agent.switched",
          source: message.id,
          kind: "agent-switched",
          data: {
            timestamp,
            sessionID: snapshot.session.id,
            messageID: deterministicId(
              "msg_",
              digest,
              message.id,
              "agent-switched",
            ),
            agent,
          },
        });
        currentAgent = agent;
      }
      if (stableJson(currentModel) !== stableJson(model)) {
        emit({
          type: "session.next.model.switched",
          source: message.id,
          kind: "model-switched",
          data: {
            timestamp,
            sessionID: snapshot.session.id,
            messageID: deterministicId(
              "msg_",
              digest,
              message.id,
              "model-switched",
            ),
            model,
          },
        });
        currentModel = model;
      }

      const text: string[] = [];
      const files: JsonObject[] = [];
      const agents: JsonObject[] = [];
      for (const partRow of messageParts) {
        const partValue = part(partRow);
        const type = asString(partValue.type);
        if (type === "text") {
          const partText = asString(partValue.text);
          if (partText === undefined) {
            diagnostic({
              code: "UNSUPPORTED_SOURCE_FIELD",
              message: "text part has no text",
              messageId: message.id,
              partId: partRow.id,
              path: "part.text",
            });
          } else {
            if (partValue.ignored === true) {
              diagnostic({
                severity: "warning",
                code: "UNSUPPORTED_SOURCE_FIELD",
                message:
                  "ignored user text is retained in legacy events but excluded from V2 context",
                messageId: message.id,
                partId: partRow.id,
                path: "part.ignored",
              });
              continue;
            }
            if (partValue.synthetic === true) {
              diagnostic({
                severity: "warning",
                code: "UNSUPPORTED_SOURCE_FIELD",
                message:
                  "synthetic user text is normalized into the original V2 user prompt",
                messageId: message.id,
                partId: partRow.id,
                path: "part.synthetic",
              });
            }
            text.push(partText);
          }
          continue;
        }
        if (type === "file") {
          const uri = asString(partValue.url);
          const mime = asString(partValue.mime);
          if (!uri || !mime) {
            diagnostic({
              code: "UNSUPPORTED_SOURCE_FIELD",
              message: "file part requires url and mime",
              messageId: message.id,
              partId: partRow.id,
            });
            continue;
          }
          if (mime === "text/plain" || mime === "application/x-directory") {
            diagnostic({
              severity: "warning",
              code: "UNSUPPORTED_SOURCE_FIELD",
              message:
                "V1 text/directory file marker is retained in legacy events but excluded from V2 media",
              messageId: message.id,
              partId: partRow.id,
              path: "part.mime",
            });
            continue;
          }
          const source = asObject(partValue.source);
          const sourceText = source && asObject(source.text);
          files.push({
            uri,
            mime,
            ...(asString(partValue.filename)
              ? { name: asString(partValue.filename)! }
              : {}),
            ...(sourceText &&
            asFiniteNumber(sourceText.start) !== undefined &&
            asFiniteNumber(sourceText.end) !== undefined &&
            asString(sourceText.value) !== undefined
              ? {
                  source: {
                    start: asFiniteNumber(sourceText.start)!,
                    end: asFiniteNumber(sourceText.end)!,
                    text: asString(sourceText.value)!,
                  },
                }
              : {}),
          });
          continue;
        }
        if (type === "agent") {
          const name = asString(partValue.name);
          if (!name) {
            diagnostic({
              code: "UNSUPPORTED_SOURCE_FIELD",
              message: "agent part requires name",
              messageId: message.id,
              partId: partRow.id,
            });
            continue;
          }
          const source = asObject(partValue.source);
          agents.push({
            name,
            ...(source &&
            asFiniteNumber(source.start) !== undefined &&
            asFiniteNumber(source.end) !== undefined &&
            asString(source.value) !== undefined
              ? {
                  source: {
                    start: asFiniteNumber(source.start)!,
                    end: asFiniteNumber(source.end)!,
                    text: asString(source.value)!,
                  },
                }
              : {}),
          });
          continue;
        }
        if (type === "compaction") {
          diagnostic({
            code: "UNSUPPORTED_COMPACTION",
            message: "compaction requires a dedicated paired migration recipe",
            messageId: message.id,
            partId: partRow.id,
          });
          continue;
        }
        if (type === "subtask") {
          diagnostic({
            code: "UNKNOWN_PART_TYPE",
            message:
              "subtask prompt semantics are not supported by the current recipe",
            messageId: message.id,
            partId: partRow.id,
          });
          continue;
        }
        diagnostic({
          code: "UNKNOWN_PART_TYPE",
          message: "unsupported user part type",
          messageId: message.id,
          partId: partRow.id,
          rawDigest: sha256(type),
        });
      }

      if (text.length > 1) {
        diagnostic({
          code: "UNSUPPORTED_SOURCE_FIELD",
          message:
            "multiple model-visible user text blocks cannot be losslessly represented by one V2 prompt",
          messageId: message.id,
          path: "message.parts",
        });
        continue;
      }
      if (text.length === 0 && files.length === 0 && agents.length === 0) {
        diagnostic({
          severity: "warning",
          code: "UNSUPPORTED_SOURCE_FIELD",
          message:
            "user message has no model-visible content after applying V1 context filters",
          messageId: message.id,
        });
        continue;
      }
      emit({
        type: "session.next.prompted",
        source: message.id,
        kind: "prompted",
        data: {
          timestamp,
          sessionID: snapshot.session.id,
          messageID: message.id,
          prompt: {
            text: text.join("\n"),
            ...(files.length > 0 ? { files } : {}),
            ...(agents.length > 0 ? { agents } : {}),
          },
          delivery: "steer",
        },
      });
      continue;
    }

    if (role !== "assistant") {
      diagnostic({
        code: "UNKNOWN_MESSAGE_ROLE",
        message: "unsupported message role",
        messageId: message.id,
        rawDigest: sha256(role),
      });
      continue;
    }

    if (value.summary === true) {
      diagnostic({
        code: "ASSISTANT_SUMMARY_UNPAIRED",
        message: "summary assistant requires a paired compaction recipe",
        messageId: message.id,
      });
      continue;
    }
    if (value.structured !== undefined) {
      diagnostic({
        code: "UNSUPPORTED_ASSISTANT_STATE",
        message: "structured assistant output has no lossless V2 history mapping",
        messageId: message.id,
        path: "message.structured",
      });
    }
    const assistantError = asObject(value.error);
    const abortedAssistant =
      asString(assistantError?.name) === "MessageAbortedError";
    if (value.error !== undefined) {
      const meaningful = messageParts.some(
        (partRow) =>
          partRow.data.type !== "step-start" &&
          partRow.data.type !== "reasoning",
      );
      if (!abortedAssistant || !meaningful) {
        diagnostic({
          severity: "warning",
          code: "UNSUPPORTED_ASSISTANT_STATE",
          message:
            "assistant error turn is retained in legacy events but excluded from V2 continuation context",
          messageId: message.id,
          path: "message.error",
        });
        continue;
      }
    }

    const agent = requiredString(value.agent, {
      diagnostic,
      message,
      path: "message.agent",
    });
    const modelID = requiredString(value.modelID, {
      diagnostic,
      message,
      path: "message.modelID",
    });
    const providerID = requiredString(value.providerID, {
      diagnostic,
      message,
      path: "message.providerID",
    });
    const time = asObject(value.time);
    const created = requiredNumber(time?.created, {
      diagnostic,
      message,
      path: "message.time.created",
    });
    const completed = asFiniteNumber(time?.completed);
    const messageTokens = tokens(value.tokens, {
      diagnostic,
      message,
      path: "message.tokens",
    });
    const cost = requiredNumber(value.cost, {
      diagnostic,
      message,
      path: "message.cost",
    });
    if (
      !agent ||
      !modelID ||
      !providerID ||
      created === undefined ||
      !messageTokens ||
      cost === undefined
    ) {
      continue;
    }

    const segments = splitAssistantSegments(messageParts);
    const hasSignedReasoning = messageParts.some((partRow) => {
      if (partRow.data.type !== "reasoning") return false;
      const metadata = asObject(partRow.data.metadata);
      const anthropic = metadata && asObject(metadata.anthropic);
      return anthropic?.signature !== undefined;
    });
    let priorEmittedCost = 0;
    let priorStepFinishCount = 0;
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex]!;
      const assistantMessageID =
        segmentIndex === 0
          ? message.id
          : deterministicId(
              "msg_",
              MIGRATION_RECIPE_ID,
              digest,
              message.id,
              "step",
              segmentIndex,
            );
      const startSnapshot = asString(segment.start?.data.snapshot);
      emit({
        type: "session.next.step.started",
        source: segment.start?.id ?? message.id,
        kind: `step-started-${segmentIndex}`,
        data: {
          timestamp:
            segmentIndex === 0
              ? created
              : segment.start?.timeCreated ?? created,
          sessionID: snapshot.session.id,
          assistantMessageID,
          agent,
          model: {
            id: modelID,
            providerID,
            variant: asString(value.variant) ?? "default",
          },
          ...(startSnapshot ? { snapshot: startSnapshot } : {}),
        },
      });

      const stepFinishes = segment.parts.filter(
        (partRow) => partRow.data.type === "step-finish",
      );
      if (stepFinishes.length > 1) {
        diagnostic({
          code: "ASSISTANT_MULTIPLE_STEPS",
          message:
            "multiple step-finish markers occur inside one Vercel AI SDK assistant block",
          messageId: message.id,
        });
      }
      const stepFinish = stepFinishes.at(-1);
      const stepTokens = stepFinish
        ? tokens(stepFinish.data.tokens, {
            diagnostic,
            message,
            path: `part(${stepFinish.id}).tokens`,
          })
        : undefined;
      const stepCost = stepFinish
        ? requiredNumber(stepFinish.data.cost, {
            diagnostic,
            message,
            path: `part(${stepFinish.id}).cost`,
          })
        : undefined;
      let endSnapshot = asString(stepFinish?.data.snapshot);
      const files = new Set<string>();
      for (const partRow of segment.parts) {
      const partValue = part(partRow);
      const type = asString(partValue.type);
      if (type === "step-finish") continue;
      if (type === "snapshot") {
        endSnapshot = asString(partValue.snapshot) ?? endSnapshot;
        continue;
      }
      if (type === "patch") {
        for (const file of Array.isArray(partValue.files)
          ? partValue.files
          : []) {
          if (typeof file === "string") files.add(file);
        }
        continue;
      }
      if (type === "retry") {
        const retryTime = asObject(partValue.time);
        const retryError = asObject(partValue.error);
        const retryData = retryError && asObject(retryError.data);
        emit({
          type: "session.next.retried",
          source: partRow.id,
          kind: "retried",
          data: {
            timestamp:
              asFiniteNumber(retryTime?.created) ?? partRow.timeCreated,
            sessionID: snapshot.session.id,
            attempt: asFiniteNumber(partValue.attempt) ?? 0,
            error: {
              message:
                (retryData && asString(retryData.message)) ??
                "Legacy provider request was retried",
              ...(retryData &&
              asFiniteNumber(retryData.statusCode) !== undefined
                ? { statusCode: asFiniteNumber(retryData.statusCode)! }
                : {}),
              isRetryable:
                retryData?.isRetryable === undefined
                  ? true
                  : retryData.isRetryable === true,
              ...(retryData && asObject(retryData.responseHeaders)
                ? {
                    responseHeaders: structuredClone(
                      retryData.responseHeaders,
                    ),
                  }
                : {}),
              ...(retryData && asString(retryData.responseBody)
                ? { responseBody: asString(retryData.responseBody)! }
                : {}),
            },
          },
        });
        continue;
      }
      if (type === "text") {
        const rawText = asString(partValue.text);
        const text =
          rawText === "" && hasSignedReasoning ? " " : rawText;
        if (text === undefined) {
          diagnostic({
            code: "UNSUPPORTED_SOURCE_FIELD",
            message: "assistant text part has no text",
            messageId: message.id,
            partId: partRow.id,
          });
          continue;
        }
        const textMetadata = asObject(partValue.metadata);
        if (textMetadata && Object.keys(textMetadata).length > 0) {
          diagnostic({
            severity: "warning",
            code: "UNSUPPORTED_SOURCE_FIELD",
            message:
              "assistant text provider metadata is retained in legacy events but excluded because V2 text events have no provider metadata field",
            messageId: message.id,
            partId: partRow.id,
            path: "part.metadata",
          });
        }
        const partTime = asObject(partValue.time);
        const started =
          asFiniteNumber(partTime?.start) ?? partRow.timeCreated ?? created;
        const ended = asFiniteNumber(partTime?.end) ?? completed ?? started;
        emit({
          type: "session.next.text.started",
          source: partRow.id,
          kind: "text-started",
          data: {
            timestamp: started,
            sessionID: snapshot.session.id,
            assistantMessageID,
            textID: partRow.id,
          },
        });
        emit({
          type: "session.next.text.ended",
          source: partRow.id,
          kind: "text-ended",
          data: {
            timestamp: ended,
            sessionID: snapshot.session.id,
            assistantMessageID,
            textID: partRow.id,
            text,
          },
        });
        continue;
      }
      if (type === "reasoning") {
        const reasoning = asString(partValue.text);
        const partTime = asObject(partValue.time);
        if (reasoning === undefined || !partTime) {
          diagnostic({
            code: "UNSUPPORTED_SOURCE_FIELD",
            message: "reasoning part has no text/time",
            messageId: message.id,
            partId: partRow.id,
          });
          continue;
        }
        const started =
          asFiniteNumber(partTime.start) ?? partRow.timeCreated ?? created;
        const ended = asFiniteNumber(partTime.end) ?? completed ?? started;
        const reasoningMetadata = providerMetadata(partValue.metadata, {
          diagnostic,
          message,
          part: partRow,
          path: "part.metadata",
        });
        emit({
          type: "session.next.reasoning.started",
          source: partRow.id,
          kind: "reasoning-started",
          data: {
            timestamp: started,
            sessionID: snapshot.session.id,
            assistantMessageID,
            reasoningID: partRow.id,
            ...(reasoningMetadata
              ? { providerMetadata: reasoningMetadata }
              : {}),
          },
        });
        emit({
          type: "session.next.reasoning.ended",
          source: partRow.id,
          kind: "reasoning-ended",
          data: {
            timestamp: ended,
            sessionID: snapshot.session.id,
            assistantMessageID,
            reasoningID: partRow.id,
            text: reasoning,
            ...(reasoningMetadata
              ? { providerMetadata: reasoningMetadata }
              : {}),
          },
        });
        continue;
      }
      if (type === "tool") {
        const callID = asString(partValue.callID);
        const tool = asString(partValue.tool);
        const state = asObject(partValue.state);
        const status = state && asString(state.status);
        if (!callID || !tool || !state) {
          diagnostic({
            code: "UNSUPPORTED_SOURCE_FIELD",
            message: "tool part requires callID/tool/state",
            messageId: message.id,
            partId: partRow.id,
          });
          continue;
        }
        if (
          status !== "pending" &&
          status !== "running" &&
          status !== "completed" &&
          status !== "error"
        ) {
          diagnostic({
            code: "UNKNOWN_TOOL_STATE",
            message: "unsupported tool state",
            messageId: message.id,
            partId: partRow.id,
            rawDigest: sha256(status),
          });
          continue;
        }
        const toolTime = asObject(state.time);
        const started =
          asFiniteNumber(toolTime?.start) ?? partRow.timeCreated ?? created;
        const ended =
          asFiniteNumber(toolTime?.end) ?? completed ?? partRow.timeUpdated;
        const input = asObject(state.input);
        if (!input) {
          diagnostic({
            code: "UNSUPPORTED_SOURCE_FIELD",
            message: "tool state input must be an object",
            messageId: message.id,
            partId: partRow.id,
            path: "part.state.input",
          });
          continue;
        }
        emit({
          type: "session.next.tool.input.started",
          source: partRow.id,
          kind: "tool-input-started",
          data: {
            timestamp: started,
            sessionID: snapshot.session.id,
            assistantMessageID,
            callID,
            name: tool,
          },
        });
        emit({
          type: "session.next.tool.input.ended",
          source: partRow.id,
          kind: "tool-input-ended",
          data: {
            timestamp: started,
            sessionID: snapshot.session.id,
            assistantMessageID,
            callID,
            text:
              status === "pending" && typeof state.raw === "string"
                ? state.raw
                : stableJson(input),
          },
        });
        const toolProviderMetadata = providerMetadata(partValue.metadata, {
          diagnostic,
          message,
          part: partRow,
          path: "part.metadata",
          exclude: ["providerExecuted", "interrupted", "output"],
        });
        const provider = {
          executed: asObject(partValue.metadata)?.providerExecuted === true,
          ...(toolProviderMetadata
            ? { metadata: toolProviderMetadata }
            : {}),
        };
        emit({
          type: "session.next.tool.called",
          source: partRow.id,
          kind: "tool-called",
          data: {
            timestamp: started,
            sessionID: snapshot.session.id,
            assistantMessageID,
            callID,
            tool,
            input,
            provider,
          },
        });
        if (status === "completed") {
          const compacted =
            asFiniteNumber(toolTime?.compacted) !== undefined;
          const attachments: JsonObject[] = [];
          for (const attachment of compacted
            ? []
            : Array.isArray(state.attachments)
              ? state.attachments
              : []) {
            const file = asObject(attachment);
            const uri = file && asString(file.url);
            const mime = file && asString(file.mime);
            if (!uri || !mime || !uri.startsWith("data:")) {
              diagnostic({
                code: "UNSUPPORTED_SOURCE_FIELD",
                message:
                  "completed tool attachments must be materialized data URIs",
                messageId: message.id,
                partId: partRow.id,
                path: "part.state.attachments",
              });
              continue;
            }
            attachments.push({
              type: "file",
              uri,
              mime,
              ...(asString(file.filename)
                ? { name: asString(file.filename)! }
                : {}),
            });
          }
          emit({
            type: "session.next.tool.success",
            source: partRow.id,
            kind: "tool-success",
            data: {
              timestamp: ended,
              sessionID: snapshot.session.id,
              assistantMessageID,
              callID,
              structured: asObject(state.metadata) ?? {},
              content: [
                {
                  type: "text",
                  text: compacted
                    ? "[Old tool result content cleared]"
                    : asString(state.output) ?? "",
                },
                ...attachments,
              ],
              provider,
            },
          });
          continue;
        }
        if (status === "error") {
          const stateMetadata = asObject(state.metadata);
          const interruptedOutput =
            stateMetadata?.interrupted === true
              ? asString(stateMetadata.output)
              : undefined;
          emit({
            type:
              interruptedOutput === undefined
                ? "session.next.tool.failed"
                : "session.next.tool.success",
            source: partRow.id,
            kind:
              interruptedOutput === undefined
                ? "tool-failed"
                : "tool-interrupted-output",
            data: {
              timestamp: ended,
              sessionID: snapshot.session.id,
              assistantMessageID,
              callID,
              ...(interruptedOutput === undefined
                ? {
                    error: {
                      type: "unknown",
                      message:
                        asString(state.error) ?? "Legacy tool call failed",
                    },
                  }
                : {
                    structured: {},
                    content: [{ type: "text", text: interruptedOutput }],
                  }),
              provider,
            },
          });
          continue;
        }
        emit({
          type: "session.next.tool.failed",
          source: partRow.id,
          kind: "tool-interrupted",
          data: {
            timestamp: ended,
            sessionID: snapshot.session.id,
            assistantMessageID,
            callID,
            error: {
              type: "unknown",
              message: "[Tool execution was interrupted]",
            },
            provider,
          },
        });
        continue;
      }
      if (type === "compaction" || type === "subtask") {
        diagnostic({
          code:
            type === "compaction"
              ? "UNSUPPORTED_COMPACTION"
              : "UNKNOWN_PART_TYPE",
          message: `${type} is not valid inside an ordinary assistant turn`,
          messageId: message.id,
          partId: partRow.id,
        });
        continue;
      }
      diagnostic({
        code: "UNKNOWN_PART_TYPE",
        message: "unsupported assistant part type",
        messageId: message.id,
        partId: partRow.id,
        rawDigest: sha256(type),
      });
    }

      const isLastSegment = segmentIndex === segments.length - 1;
      if (!isLastSegment) {
        if (!stepFinish) {
          diagnostic({
            severity: "warning",
            code: "UNSUPPORTED_ASSISTANT_STATE",
            message:
              "legacy multi-step block has no step-finish; the next V2 step closes it without usage metadata",
            messageId: message.id,
          });
          continue;
        }
        if (!stepTokens || stepCost === undefined) continue;
        emit({
          type: "session.next.step.ended",
          source: stepFinish.id,
          kind: `step-ended-${segmentIndex}`,
          data: {
            timestamp: stepFinish.timeUpdated,
            sessionID: snapshot.session.id,
            assistantMessageID,
            finish: asString(stepFinish.data.reason) ?? "tool-calls",
            cost: stepCost,
            tokens: stepTokens,
            ...(endSnapshot ? { snapshot: endSnapshot } : {}),
            ...(files.size > 0 ? { files: [...files].sort() } : {}),
          },
        });
        priorEmittedCost += stepCost;
        priorStepFinishCount++;
        continue;
      }

      let terminalCost = cost;
      let terminalTokens = messageTokens;
      if (segments.length > 1) {
        terminalCost = cost - priorEmittedCost;
        if (terminalCost < -1e-9) {
          diagnostic({
            code: "UNSUPPORTED_SOURCE_FIELD",
            message:
              "assistant aggregate cost is lower than prior step-finish costs",
            messageId: message.id,
            path: "message.cost",
          });
          terminalCost = 0;
        } else if (terminalCost < 0) {
          terminalCost = 0;
        }

        if (stepFinish) {
          if (!stepTokens || stepCost === undefined) continue;
          terminalTokens = stepTokens;
          const hasMissingPriorFinish = segments
            .slice(0, segmentIndex)
            .some(
              (prior) =>
                !prior.parts.some(
                  (partRow) => partRow.data.type === "step-finish",
                ),
            );
          if (Math.abs(terminalCost - stepCost) > 1e-9) {
            diagnostic({
              ...(hasMissingPriorFinish
                ? { severity: "warning" as const }
                : {}),
              code: "UNSUPPORTED_ASSISTANT_STATE",
              message: hasMissingPriorFinish
                ? "missing intermediate step-finish costs are attributed to the final V2 assistant"
                : "assistant aggregate cost does not equal the sum of step-finish costs",
              messageId: message.id,
              path: "message.cost",
            });
          }
        } else {
          terminalTokens =
            priorStepFinishCount === 0 ? messageTokens : zeroTokens();
          diagnostic({
            severity: "warning",
            code: "UNSUPPORTED_ASSISTANT_STATE",
            message:
              "final multi-step block has no step-finish; residual aggregate cost is retained without duplicating prior usage",
            messageId: message.id,
          });
        }
      }

      if (abortedAssistant) {
        diagnostic({
          severity: "warning",
          code: "UNSUPPORTED_ASSISTANT_STATE",
          message:
            "aborted assistant turn is settled without an assistant error to preserve continuation metadata",
          messageId: message.id,
          path: "message.error",
        });
        emit({
          type: "session.next.step.ended",
          source: message.id,
          kind: "step-aborted",
          data: {
            timestamp: completed ?? message.timeUpdated,
            sessionID: snapshot.session.id,
            assistantMessageID,
            finish: "cancelled",
            cost: terminalCost,
            tokens: terminalTokens,
            ...(endSnapshot ? { snapshot: endSnapshot } : {}),
            ...(files.size > 0 ? { files: [...files].sort() } : {}),
          },
        });
        continue;
      }

      if (completed === undefined && stepFinishes.length === 0) {
        diagnostic({
          severity: "warning",
          code: "UNSUPPORTED_ASSISTANT_STATE",
          message:
            "incomplete assistant turn is settled as interrupted for V2 continuation",
          messageId: message.id,
        });
        emit({
          type: "session.next.step.ended",
          source: message.id,
          kind: "step-interrupted",
          data: {
            timestamp: message.timeUpdated,
            sessionID: snapshot.session.id,
            assistantMessageID,
            finish: "cancelled",
            cost: terminalCost,
            tokens: terminalTokens,
            ...(endSnapshot ? { snapshot: endSnapshot } : {}),
            ...(files.size > 0 ? { files: [...files].sort() } : {}),
          },
        });
        continue;
      }
      emit({
        type: "session.next.step.ended",
        source: message.id,
        kind: "step-ended",
        data: {
          timestamp:
            completed ?? stepFinish?.timeUpdated ?? message.timeUpdated,
          sessionID: snapshot.session.id,
          assistantMessageID,
          finish:
            asString(value.finish) ??
            asString(stepFinish?.data.reason) ??
            "stop",
          cost: terminalCost,
          tokens: terminalTokens,
          ...(endSnapshot ? { snapshot: endSnapshot } : {}),
          ...(files.size > 0 ? { files: [...files].sort() } : {}),
        },
      });
    }
  }

  if (targetSessionState) {
    let restored = false;
    if (targetSessionState.agent === undefined && currentAgent !== undefined) {
      diagnostic({
        code: "UNSUPPORTED_SOURCE_FIELD",
        message: "V2 durable events cannot clear the current session agent",
        path: "session.agent",
      });
    } else if (
      targetSessionState.agent !== undefined &&
      targetSessionState.agent !== currentAgent
    ) {
      emit({
        type: "session.next.agent.switched",
        source: snapshot.session.id,
        kind: "terminal-agent",
        data: {
          timestamp: targetSessionState.timeUpdated,
          sessionID: snapshot.session.id,
          messageID: deterministicId(
            "msg_",
            digest,
            snapshot.session.id,
            "terminal-agent",
          ),
          agent: targetSessionState.agent,
        },
      });
      currentAgent = targetSessionState.agent;
      restored = true;
    }
    if (
      targetSessionState.model === undefined &&
      currentModel !== undefined
    ) {
      diagnostic({
        code: "UNSUPPORTED_SOURCE_FIELD",
        message: "V2 durable events cannot clear the current session model",
        path: "session.model",
      });
    } else if (
      targetSessionState.model !== undefined &&
      stableJson(targetSessionState.model) !== stableJson(currentModel)
    ) {
      emit({
        type: "session.next.model.switched",
        source: snapshot.session.id,
        kind: "terminal-model",
        data: {
          timestamp: targetSessionState.timeUpdated,
          sessionID: snapshot.session.id,
          messageID: deterministicId(
            "msg_",
            digest,
            snapshot.session.id,
            "terminal-model",
          ),
          model: structuredClone(targetSessionState.model),
        },
      });
      currentModel = structuredClone(targetSessionState.model);
      restored = true;
    }
    if (!restored) {
      if (targetSessionState.agent !== undefined) {
        emit({
          type: "session.next.agent.switched",
          source: snapshot.session.id,
          kind: "terminal-agent-noop",
          data: {
            timestamp: targetSessionState.timeUpdated,
            sessionID: snapshot.session.id,
            messageID: deterministicId(
              "msg_",
              digest,
              snapshot.session.id,
              "terminal-agent-noop",
            ),
            agent: targetSessionState.agent,
          },
        });
      } else if (targetSessionState.model !== undefined) {
        emit({
          type: "session.next.model.switched",
          source: snapshot.session.id,
          kind: "terminal-model-noop",
          data: {
            timestamp: targetSessionState.timeUpdated,
            sessionID: snapshot.session.id,
            messageID: deterministicId(
              "msg_",
              digest,
              snapshot.session.id,
              "terminal-model-noop",
            ),
            model: structuredClone(targetSessionState.model),
          },
        });
      } else if (messages.length > 0) {
        diagnostic({
          code: "UNSUPPORTED_SOURCE_FIELD",
          message:
            "cannot preserve session update time without an agent or model",
          path: "session",
        });
      }
    }
  }

  return events;
}

function compareExistingReplayPrefix(
  generated: readonly ReplayEvent[],
  existing: readonly StoredEvent[],
  diagnostic: (input: DiagnosticInput) => void,
): number {
  if (existing.length === 0) return 0;
  if (existing.length > generated.length) {
    diagnostic({
      code: "MIXED_EVENT_DIVERGENCE",
      message: "existing V2 event suffix is longer than the migration plan",
    });
    return 0;
  }
  for (let index = 0; index < existing.length; index++) {
    const stored = existing[index]!;
    const expected = generated[index]!;
    if (
      stored.id !== expected.id ||
      stored.aggregateId !== expected.aggregateID ||
      stored.seq !== expected.seq ||
      stored.type !== versionedType(expected.type) ||
      stableJson(stored.data) !== stableJson(expected.data)
    ) {
      diagnostic({
        code: "MIXED_EVENT_DIVERGENCE",
        message: `existing V2 event diverges at aggregate seq ${stored.seq}`,
        rawDigest: sha256(stored),
      });
      return 0;
    }
  }
  return existing.length;
}

export function buildSessionMigrationPlan(
  snapshot: SessionSourceSnapshot,
): SessionMigrationPlan {
  const diagnostics: MigrationDiagnostic[] = [];
  const diagnostic = (input: DiagnosticInput) => {
    diagnostics.push({
      severity: input.severity ?? "blocking",
      sessionId: snapshot.session.id,
      ...input,
    });
  };

  const digest = sourceDigest(snapshot);
  const { legacyEvents, v2Events, baseSeq } = validateEventStream(
    snapshot,
    diagnostic,
  );

  if (snapshot.session.revert) {
    diagnostic({
      code: "ACTIVE_REVERT",
      message: "session has an active revert boundary",
    });
  }
  if (snapshot.session.timeCompacting !== undefined) {
    diagnostic({
      code: "UNSUPPORTED_COMPACTION",
      message: "session has an active compaction timestamp",
      path: "session.time.compacting",
    });
  }
  if (snapshot.pendingV2InputCount > 0) {
    diagnostic({
      code: "PENDING_V2_INPUT",
      message: "session has pending V2 input",
    });
  }

  if (snapshot.messages.length === 0 && snapshot.parts.length === 0) {
    const state =
      v2Events.length > 0 || snapshot.v2MessageCount > 0
        ? "already-v2"
        : "empty";
    return {
      sessionId: snapshot.session.id,
      state,
      sourceVersion: snapshot.session.version,
      sourceDigest: digest,
      sourceSessionImmutableDigest: snapshot.sessionImmutableDigest,
      baseSeq,
      currentSeq: snapshot.sequence?.seq ?? -1,
      targetLastSeq: snapshot.sequence?.seq ?? -1,
      existingReplayPrefix: 0,
      sourceMessageCount: 0,
      sourcePartCount: 0,
      events: [],
      expectedMessages: [],
      expectedInputs: [],
      expectedSessionStateDigest: sha256({}),
      targetSemanticDigest: sha256({
        messages: [],
        inputs: [],
        session: {},
      }),
      diagnostics,
    };
  }

  const targetSessionState = validateLegacyProjection(
    snapshot,
    legacyEvents,
    v2Events,
    diagnostic,
  );
  const events = buildEvents(
    snapshot,
    digest,
    baseSeq,
    targetSessionState,
    diagnostic,
  );
  const projection = projectReplayEvents(events);
  const projectedMessageIds = new Set<string>();
  for (const message of projection.messages) {
    if (projectedMessageIds.has(message.id)) {
      diagnostic({
        code: "MESSAGE_ID_COLLISION",
        message: "generated V2 message IDs are not unique within the session",
        messageId: message.id,
      });
    }
    projectedMessageIds.add(message.id);
  }
  const expectedSessionAgent = asString(
    [...events]
      .reverse()
      .find((event) => event.type === "session.next.agent.switched")
      ?.data.agent,
  );
  const expectedSessionModel = asObject(
    [...events]
      .reverse()
      .find((event) => event.type === "session.next.model.switched")
      ?.data.model,
  );
  const expectedSessionState = targetSessionState
    ? structuredClone(targetSessionState)
    : {
        ...(expectedSessionAgent ? { agent: expectedSessionAgent } : {}),
        ...(expectedSessionModel
          ? { model: structuredClone(expectedSessionModel) }
          : {}),
      };
  const existingReplayPrefix = compareExistingReplayPrefix(
    events,
    v2Events,
    diagnostic,
  );

  if (snapshot.contextEpochCount > 0) {
    diagnostic({
      code: "MIXED_EVENT_DIVERGENCE",
      message:
        "V2 context epoch state exists and cannot be overwritten by a V1 migration",
    });
  }

  if (
    v2Events.length === 0 &&
    (snapshot.v2MessageCount > 0 || snapshot.v2InputCount > 0)
  ) {
    diagnostic({
      code: "MIXED_EVENT_DIVERGENCE",
      message: "V2 projections exist without a V2 durable event suffix",
    });
  }

  const blocked = diagnostics.some(
    (entry) => entry.severity === "blocking",
  );
  return {
    sessionId: snapshot.session.id,
    state: blocked
      ? "blocked"
      : existingReplayPrefix > 0
        ? "resumable"
        : "eligible",
    sourceVersion: snapshot.session.version,
    sourceDigest: digest,
    sourceSessionImmutableDigest: snapshot.sessionImmutableDigest,
    baseSeq,
    currentSeq: snapshot.sequence?.seq ?? -1,
    targetLastSeq: events.at(-1)?.seq ?? baseSeq,
    existingReplayPrefix,
    sourceMessageCount: snapshot.messages.length,
    sourcePartCount: snapshot.parts.length,
    events,
    expectedMessages: projection.messages,
    expectedInputs: projection.inputs,
    ...(expectedSessionAgent ? { expectedSessionAgent } : {}),
    ...(expectedSessionModel
      ? { expectedSessionModel: structuredClone(expectedSessionModel) }
      : {}),
    expectedSessionStateDigest: sha256(expectedSessionState),
    targetSemanticDigest: sha256({
      messages: projection.messages,
      inputs: projection.inputs,
      session: expectedSessionState,
    }),
    diagnostics,
  };
}
