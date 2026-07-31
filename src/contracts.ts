/** One-off OpenCode history migration contracts. */
export const MIGRATION_RECIPE_ID =
  "opencode-v1-history-to-v2-events@6" as const;

export const MIGRATION_TARGET_PROFILE =
  "opencode-v2@1.18.9+4da7bb44.official-musl-v1" as const;

export type JsonObject = Record<string, unknown>;

export type MigrationDiagnosticCode =
  | "ACTIVE_REVERT"
  | "ASSISTANT_MULTIPLE_STEPS"
  | "ASSISTANT_SUMMARY_UNPAIRED"
  | "CORRUPT_LEGACY_EVENTS"
  | "EVENT_SEQUENCE_GAP"
  | "EVENT_SEQUENCE_MISMATCH"
  | "LEGACY_PROJECTION_DIVERGENCE"
  | "MESSAGE_ID_COLLISION"
  | "MISSING_EVENT_SEQUENCE"
  | "MIXED_EVENT_DIVERGENCE"
  | "NORMALIZED_EXECUTION_FIELD"
  | "NORMALIZED_SESSION_TOUCH"
  | "NORMALIZED_STALE_EVENT_TAIL"
  | "OWNER_CONFLICT"
  | "PENDING_V2_INPUT"
  | "UNKNOWN_MESSAGE_ROLE"
  | "UNKNOWN_PART_TYPE"
  | "UNKNOWN_TOOL_STATE"
  | "UNSUPPORTED_ASSISTANT_STATE"
  | "UNSUPPORTED_COMPACTION"
  | "UNSUPPORTED_SOURCE_FIELD";

export interface MigrationDiagnostic {
  severity: "blocking" | "warning";
  code: MigrationDiagnosticCode;
  message: string;
  sessionId: string;
  messageId?: string;
  partId?: string;
  path?: string;
  rawDigest?: string;
}

export interface StoredEvent {
  id: string;
  aggregateId: string;
  seq: number;
  type: string;
  data: JsonObject;
}

export interface ReplayEvent {
  id: string;
  aggregateID: string;
  seq: number;
  type: string;
  data: JsonObject;
}

export interface LegacySession {
  id: string;
  version: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  metadata?: JsonObject;
  revert?: JsonObject;
  timeCreated: number;
  timeUpdated: number;
  timeCompacting?: number;
}

export interface LegacyMessage {
  id: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  data: JsonObject;
}

export interface LegacyPart {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  data: JsonObject;
}

export interface SessionSourceSnapshot {
  session: LegacySession;
  messages: readonly LegacyMessage[];
  parts: readonly LegacyPart[];
  events: readonly StoredEvent[];
  sequence?: {
    seq: number;
    ownerId?: string;
  };
  v2MessageCount: number;
  v2InputCount: number;
  pendingV2InputCount: number;
  contextEpochCount: number;
  sessionImmutableDigest: string;
}

export type SessionMigrationState =
  | "eligible"
  | "resumable"
  | "already-v2"
  | "empty"
  | "blocked";

export interface ExpectedSessionMessage {
  id: string;
  sessionId: string;
  type:
    | "agent-switched"
    | "model-switched"
    | "user"
    | "system"
    | "synthetic"
    | "assistant";
  seq: number;
  timeCreated: number;
  data: JsonObject;
}

export interface ExpectedSessionInput {
  id: string;
  sessionId: string;
  prompt: JsonObject;
  delivery: "steer";
  admittedSeq: number;
  promotedSeq: number;
  timeCreated: number;
}

export interface SessionMigrationPlan {
  sessionId: string;
  state: SessionMigrationState;
  sourceVersion: string;
  sourceDigest: string;
  sourceSessionImmutableDigest: string;
  baseSeq: number;
  currentSeq: number;
  targetLastSeq: number;
  existingReplayPrefix: number;
  sourceMessageCount: number;
  sourcePartCount: number;
  events: readonly ReplayEvent[];
  expectedMessages: readonly ExpectedSessionMessage[];
  expectedInputs: readonly ExpectedSessionInput[];
  expectedSessionAgent?: string;
  expectedSessionModel?: JsonObject;
  expectedSessionStateDigest: string;
  targetSemanticDigest: string;
  diagnostics: readonly MigrationDiagnostic[];
}

export interface MigrationPlan {
  schemaVersion: 1;
  recipeId: typeof MIGRATION_RECIPE_ID;
  targetProfile: typeof MIGRATION_TARGET_PROFILE;
  sourceDatabase: string;
  sourceSchemaFingerprint: string;
  planDigest: string;
  createdAt: string;
  sessions: readonly SessionMigrationPlan[];
  protectedSessions: readonly {
    sessionId: string;
    kind: "legacy" | "v2";
    semanticDigest: string;
  }[];
}

export interface PersistedSessionPlan {
  sessionId: string;
  state: SessionMigrationState;
  sourceVersion: string;
  sourceDigest: string;
  sourceSessionImmutableDigest: string;
  baseSeq: number;
  currentSeq: number;
  targetLastSeq: number;
  existingReplayPrefix: number;
  sourceMessageCount: number;
  sourcePartCount: number;
  generatedEventCount: number;
  generatedEventDigest: string;
  targetMessageCount: number;
  targetInputCount: number;
  expectedSessionStateDigest: string;
  targetSemanticDigest: string;
  diagnostics: readonly MigrationDiagnostic[];
}

export interface PersistedMigrationPlan {
  schemaVersion: 1;
  recipeId: typeof MIGRATION_RECIPE_ID;
  targetProfile: typeof MIGRATION_TARGET_PROFILE;
  runId: string;
  sourceDatabase: string;
  sourceSchemaFingerprint: string;
  planDigest: string;
  createdAt: string;
  sessions: readonly PersistedSessionPlan[];
  protectedSessions: readonly {
    sessionId: string;
    kind: "legacy" | "v2";
    semanticDigest: string;
  }[];
}

export interface SessionVerification {
  sessionId: string;
  verified: boolean;
  eventCount: number;
  messageCount: number;
  inputCount: number;
  semanticDigest?: string;
  errors: readonly string[];
}

export interface MigrationVerification {
  planDigest: string;
  verified: boolean;
  sessions: readonly SessionVerification[];
}

export interface MigrationReceipt {
  schemaVersion: 1;
  recipeId: typeof MIGRATION_RECIPE_ID;
  targetProfile: typeof MIGRATION_TARGET_PROFILE;
  planDigest: string;
  sourceDatabase: string;
  backup: {
    path: string;
    sha256: string;
  };
  completedAt: string;
  sessions: readonly {
    sessionId: string;
    sourceDigest: string;
    targetSemanticDigest: string;
    startSeq: number;
    endSeq: number;
    appendedEvents: number;
    legacyRowsRemoved: boolean;
  }[];
}
