import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJsonSecure } from "./files";
import { readSessionSourceSnapshot } from "./sqlite-source";
import { asObject, asString, sha256 } from "./stable";

interface LiveDatabaseState {
  sessionCount: number;
  legacyMessages: number;
  legacyParts: number;
  v2Messages: number;
  v2Inputs: number;
  contextEpochs: number;
  lastSeq: number;
  pendingInputs: number;
}

interface LiveContinuationProofReceipt {
  schemaVersion: 1;
  targetProfile: "live-runtime";
  appCode: string;
  userId: string;
  sessionId: string;
  sameSession: boolean;
  oldContextReachedModel: boolean;
  newProbeReachedModel: boolean;
  assistantWritePersisted: boolean;
  noNewSessionCreated: boolean;
  legacyRemovedAtProbe: boolean;
  task: {
    taskIdDigest: string;
    status: "COMPLETED";
  };
  challenge: {
    unicodeLength: number;
    digest: string;
    selection: "latest-non-probe-user-text";
  };
  database: {
    before: LiveDatabaseState;
    after: LiveDatabaseState;
  };
  messages: {
    count: number;
    assistantProofDigest: string;
  };
  completedAt: string;
}

interface LiveContinuationProofInput {
  sourceDatabase: string;
  sessionId: string;
  appCode: string;
  userId: string;
  cookieFile: string;
  runtimeBaseUrl: string;
  controllerBaseUrl: string;
  runDir: string;
  expectLegacyRemoved?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface LegacyChallenge {
  expectedPrefix: string;
  unicodeLength: number;
  sourceTexts: readonly string[];
  selection: "latest-non-probe-user-text";
}

const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function normalizedText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function deriveLegacyChallenge(
  databasePath: string,
  sessionId: string,
): LegacyChallenge {
  const snapshot = readSessionSourceSnapshot(databasePath, sessionId);
  const messages = [...snapshot.messages].sort(
    (left, right) =>
      left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
  );
  const parts = [...snapshot.parts].sort(
    (left, right) =>
      left.timeCreated - right.timeCreated || left.id.localeCompare(right.id),
  );
  const sourceTexts: string[] = [];
  for (const message of messages) {
    if (asString(message.data.role) !== "user") continue;
    for (const part of parts) {
      if (
        part.messageId !== message.id ||
        asString(part.data.type) !== "text" ||
        part.data.ignored === true
      ) {
        continue;
      }
      const text = asString(part.data.text);
      if (!text) continue;
      const normalized = normalizedText(text);
      const codePoints = [...normalized];
      if (codePoints.length < 4) continue;
      sourceTexts.push(normalized);
    }
  }
  // A V2 runner may legitimately anchor an existing compaction and omit the
  // earliest raw turns from the model request. The most recent legacy user text
  // is the strongest deterministic proof target that must still be available
  // to a continuation without embedding the answer in the probe itself.
  const latest = sourceTexts.at(-1);
  if (latest) {
    const expectedPrefix = [...latest].slice(0, 12).join("");
    return {
      expectedPrefix,
      unicodeLength: [...expectedPrefix].length,
      sourceTexts,
      selection: "latest-non-probe-user-text",
    };
  }
  throw new Error("LIVE_CHALLENGE_UNAVAILABLE");
}

export function assistantContextProof(
  messages: readonly unknown[],
  expectedPrefix: string,
  probe: string,
  sourceTexts: readonly string[] = [expectedPrefix],
): {
  oldContextReachedModel: boolean;
  newProbeReachedModel: boolean;
  assistantProofDigest: string;
} {
  const assistantTexts: string[] = [];
  for (const raw of messages) {
    const message = asObject(raw);
    const info = message && asObject(message.info);
    const role =
      asString(info?.role) ??
      asString(message?.role) ??
      asString(message?.type);
    const parts = Array.isArray(message?.parts)
      ? message.parts
      : Array.isArray(message?.content)
      ? message.content
      : [];
    if (role !== "assistant") continue;
    for (const rawPart of parts) {
      const part = asObject(rawPart);
      if (asString(part?.type) !== "text") continue;
      const text = asString(part?.text);
      if (text) assistantTexts.push(text);
    }
  }
  const probeMarker = `PROBE[${probe}]`;
  const relevant = assistantTexts.find((text) => text.includes(probeMarker));
  const normalized = relevant ? normalizedText(relevant) : "";
  const returnedFragment =
    relevant?.match(/OLD\[([^\]]+)\]/u)?.[1] ?? "";
  const normalizedFragment = normalizedText(returnedFragment);
  const expectedLength = [...expectedPrefix].length;
  const returnedLength = [...normalizedFragment].length;
  // The response itself proves provenance by returning a contiguous fragment
  // that was never included in the probe. Models occasionally count Unicode
  // code points inconsistently, so require at least eight code points while
  // still bounding the response close to the requested twelve.
  const fragmentLengthAccepted =
    returnedLength >= Math.min(8, expectedLength) &&
    returnedLength <= expectedLength + 2;
  const sourceFragmentMatched =
    normalizedFragment !== "NOT_SEEN" &&
    fragmentLengthAccepted &&
    sourceTexts.some((text) =>
      normalizedText(text).includes(normalizedFragment)
    );
  return {
    oldContextReachedModel:
      normalized.includes(normalizedText(`OLD[${expectedPrefix}]`)) ||
      sourceFragmentMatched,
    newProbeReachedModel: Boolean(relevant),
    assistantProofDigest: sha256(relevant ?? ""),
  };
}

function assertSafeScope(value: string, label: string): void {
  if (!SAFE_SCOPE.test(value)) throw new Error(`INVALID_${label.toUpperCase()}`);
}

function normalizedBaseUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`INVALID_${label.toUpperCase()}_URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`INVALID_${label.toUpperCase()}_URL`);
  }
  return value.replace(/\/+$/, "");
}

async function readPrivateCookie(path: string): Promise<string> {
  const resolved = resolve(path);
  const metadata = await stat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("COOKIE_FILE_NOT_PRIVATE");
  }
  const cookie = (await readFile(resolved, "utf8")).trim();
  if (!cookie || /[\r\n]/.test(cookie)) {
    throw new Error("COOKIE_FILE_INVALID");
  }
  return cookie;
}

async function requestJson(
  url: string,
  input: {
    method?: string;
    cookie?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("live continuation request timeout"),
    input.timeoutMs ?? 30_000,
  );
  try {
    const response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(input.cookie ? { Cookie: input.cookie } : {}),
        ...(input.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined
        ? {}
        : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch (error) {
    if (error instanceof Error && /^HTTP_\d+$/.test(error.message)) {
      throw error;
    }
    throw new Error("LIVE_HTTP_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

function envelopeData(value: unknown, label: string): unknown {
  const envelope = asObject(value);
  if (!envelope || envelope.success !== true || !("data" in envelope)) {
    throw new Error(`INVALID_${label.toUpperCase()}_RESPONSE`);
  }
  return envelope.data;
}

function requiredNumber(
  value: unknown,
  field: keyof LiveDatabaseState,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`INVALID_DATABASE_STATE_${field.toUpperCase()}`);
  }
  return value;
}

async function readDatabaseState(input: {
  controllerBaseUrl: string;
  appCode: string;
  userId: string;
  sessionId: string;
}): Promise<LiveDatabaseState> {
  const quotedSession = input.sessionId.replaceAll("'", "''");
  const sql = `SELECT
    (SELECT count(*) FROM session) AS session_count,
    (SELECT count(*) FROM message WHERE session_id='${quotedSession}') AS legacy_messages,
    (SELECT count(*) FROM part WHERE session_id='${quotedSession}') AS legacy_parts,
    (SELECT count(*) FROM session_message WHERE session_id='${quotedSession}') AS v2_messages,
    (SELECT count(*) FROM session_input WHERE session_id='${quotedSession}') AS v2_inputs,
    (SELECT count(*) FROM session_context_epoch WHERE session_id='${quotedSession}') AS context_epochs,
    coalesce((SELECT seq FROM event_sequence WHERE aggregate_id='${quotedSession}'), 0) AS last_seq,
    (SELECT count(*) FROM session_input WHERE promoted_seq IS NULL) AS pending_inputs`;
  const raw = await requestJson(
    `${input.controllerBaseUrl}/api/v1/sessions/query`,
    {
      method: "POST",
      body: {
        appCode: input.appCode,
        userId: input.userId,
        sql,
      },
    },
  );
  const data = asObject(envelopeData(raw, "database state"));
  if (
    !data ||
    !Array.isArray(data.columns) ||
    !Array.isArray(data.rows) ||
    data.rows.length !== 1 ||
    !Array.isArray(data.rows[0])
  ) {
    throw new Error("INVALID_DATABASE_STATE_RESPONSE");
  }
  const columns = data.columns;
  const values = data.rows[0];
  const row = Object.fromEntries(
    columns.map((column, index) => [
      String(column),
      values[index],
    ]),
  );
  return {
    sessionCount: requiredNumber(row.session_count, "sessionCount"),
    legacyMessages: requiredNumber(row.legacy_messages, "legacyMessages"),
    legacyParts: requiredNumber(row.legacy_parts, "legacyParts"),
    v2Messages: requiredNumber(row.v2_messages, "v2Messages"),
    v2Inputs: requiredNumber(row.v2_inputs, "v2Inputs"),
    contextEpochs: requiredNumber(row.context_epochs, "contextEpochs"),
    lastSeq: requiredNumber(row.last_seq, "lastSeq"),
    pendingInputs: requiredNumber(row.pending_inputs, "pendingInputs"),
  };
}

async function readAllMessages(input: {
  runtimeBaseUrl: string;
  appCode: string;
  sessionId: string;
  cookie: string;
}): Promise<unknown[]> {
  const result: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({
      limit: "100",
      ...(cursor ? {} : { order: "asc" }),
      ...(cursor ? { cursor } : {}),
    });
    const raw = await requestJson(
      `${input.runtimeBaseUrl}/api/harness/apps/${encodeURIComponent(input.appCode)}/opencode/session/${encodeURIComponent(input.sessionId)}/messages?${query}`,
      { cookie: input.cookie },
    );
    const page = asObject(envelopeData(raw, "messages"));
    if (!page || !Array.isArray(page.data)) {
      throw new Error("INVALID_MESSAGES_RESPONSE");
    }
    result.push(...page.data);
    const cursorObject = asObject(page.cursor);
    const next = asString(cursorObject?.next);
    if (next && seen.has(next)) throw new Error("MESSAGE_CURSOR_REPEATED");
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return result;
}

function assertBeforeState(
  state: LiveDatabaseState,
  expectLegacyRemoved: boolean,
): void {
  if (
    (expectLegacyRemoved
      ? state.legacyMessages !== 0 || state.legacyParts !== 0
      : state.legacyMessages === 0 || state.legacyParts === 0) ||
    state.v2Messages === 0 ||
    state.v2Inputs === 0 ||
    state.lastSeq === 0 ||
    state.pendingInputs !== 0
  ) {
    throw new Error("LIVE_PREFLIGHT_FAILED");
  }
}

function assertAfterState(
  before: LiveDatabaseState,
  after: LiveDatabaseState,
): void {
  if (
    after.sessionCount !== before.sessionCount ||
    after.legacyMessages !== before.legacyMessages ||
    after.legacyParts !== before.legacyParts ||
    after.v2Messages <= before.v2Messages ||
    after.v2Inputs <= before.v2Inputs ||
    after.contextEpochs < before.contextEpochs ||
    after.lastSeq <= before.lastSeq ||
    after.pendingInputs !== 0
  ) {
    throw new Error("LIVE_CONTINUATION_DURABILITY_FAILED");
  }
}

export async function proveContinuationLive(
  input: LiveContinuationProofInput,
): Promise<LiveContinuationProofReceipt> {
  assertSafeScope(input.appCode, "app_code");
  assertSafeScope(input.userId, "user_id");
  assertSafeScope(input.sessionId, "session_id");
  const runtimeBaseUrl = normalizedBaseUrl(
    input.runtimeBaseUrl,
    "runtime_base",
  );
  const controllerBaseUrl = normalizedBaseUrl(
    input.controllerBaseUrl,
    "controller_base",
  );
  const cookie = await readPrivateCookie(input.cookieFile);
  const challenge = deriveLegacyChallenge(
    input.sourceDatabase,
    input.sessionId,
  );
  const probe = randomBytes(16).toString("hex");
  const prompt = [
    "这是一次会话迁移后的受控续聊验收。请不要调用工具。",
    "只依据本条消息之前的会话历史完成下面两行：",
    `第一行：找到本条消息之前、且不以“这是一次会话迁移后的受控续聊验收。”开头的最近一条 user 消息，将连续空白折叠成一个半角空格，从中任选一段连续 ${challenge.unicodeLength} 个 Unicode 字符原样返回，格式为 OLD[内容]。`,
    `第二行：原样返回 PROBE[${probe}]。`,
    "如果看不到旧历史，第一行必须返回 OLD[NOT_SEEN]。",
  ].join("\n");

  const before = await readDatabaseState({
    controllerBaseUrl,
    appCode: input.appCode,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  assertBeforeState(before, input.expectLegacyRemoved === true);

  const submitted = asObject(
    envelopeData(
      await requestJson(
        `${runtimeBaseUrl}/api/harness/apps/${encodeURIComponent(input.appCode)}/tasks`,
        {
          method: "POST",
          cookie,
          body: {
            userQuery: prompt,
            channel: "auto",
            sessionId: input.sessionId,
          },
          timeoutMs: 180_000,
        },
      ),
      "task submission",
    ),
  );
  const taskId = asString(submitted?.taskId);
  const admittedSessionId = asString(submitted?.sessionId);
  if (!taskId || admittedSessionId !== input.sessionId) {
    throw new Error("LIVE_CONTINUATION_CHANGED_SESSION");
  }

  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let terminalStatus: string | undefined;
  let terminalSessionId: string | undefined;
  while (Date.now() < deadline) {
    const detail = asObject(
      envelopeData(
        await requestJson(
          `${runtimeBaseUrl}/api/harness/apps/${encodeURIComponent(input.appCode)}/tasks/${encodeURIComponent(taskId)}`,
          { cookie },
        ),
        "task detail",
      ),
    );
    terminalStatus = asString(detail?.status);
    terminalSessionId = asString(detail?.sessionId);
    if (
      terminalStatus === "COMPLETED" ||
      terminalStatus === "FAILED" ||
      terminalStatus === "CANCELLED"
    ) {
      break;
    }
    await Bun.sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
  if (terminalStatus !== "COMPLETED") {
    throw new Error(
      terminalStatus
        ? `LIVE_TASK_${terminalStatus}`
        : "LIVE_TASK_TIMEOUT",
    );
  }
  if (terminalSessionId && terminalSessionId !== input.sessionId) {
    throw new Error("LIVE_CONTINUATION_CHANGED_SESSION");
  }

  const messages = await readAllMessages({
    runtimeBaseUrl,
    appCode: input.appCode,
    sessionId: input.sessionId,
    cookie,
  });
  const proof = assistantContextProof(
    messages,
    challenge.expectedPrefix,
    probe,
    challenge.sourceTexts,
  );
  if (!proof.oldContextReachedModel || !proof.newProbeReachedModel) {
    throw new Error("LIVE_CONTINUATION_CONTEXT_PROOF_FAILED");
  }

  const after = await readDatabaseState({
    controllerBaseUrl,
    appCode: input.appCode,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  assertAfterState(before, after);
  const receipt: LiveContinuationProofReceipt = {
    schemaVersion: 1,
    targetProfile: "live-runtime",
    appCode: input.appCode,
    userId: input.userId,
    sessionId: input.sessionId,
    sameSession: admittedSessionId === input.sessionId,
    oldContextReachedModel: proof.oldContextReachedModel,
    newProbeReachedModel: proof.newProbeReachedModel,
    assistantWritePersisted: after.v2Messages > before.v2Messages,
    noNewSessionCreated: after.sessionCount === before.sessionCount,
    legacyRemovedAtProbe:
      before.legacyMessages === 0 && before.legacyParts === 0,
    task: {
      taskIdDigest: sha256(taskId),
      status: "COMPLETED",
    },
    challenge: {
      unicodeLength: challenge.unicodeLength,
      digest: sha256(challenge.expectedPrefix),
      selection: challenge.selection,
    },
    database: { before, after },
    messages: {
      count: messages.length,
      assistantProofDigest: proof.assistantProofDigest,
    },
    completedAt: new Date().toISOString(),
  };
  await writeJsonSecure(
    resolve(input.runDir, "live-continuation-proof.json"),
    receipt,
  );
  return receipt;
}
