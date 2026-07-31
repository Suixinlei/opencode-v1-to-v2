import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCompatibleOpenCodeImage,
  REQUIRED_OPENCODE_VERSION,
  resolvePinnedOpenCodeImage,
} from "./open-code-replay";
import { MIGRATION_TARGET_PROFILE } from "./contracts";
import { ensurePrivateDirectory, sha256File, writeJsonSecure } from "./files";
import { runCommand } from "./process";
import { resolveDatabasePath } from "./sqlite-source";
import { asObject, asString, sha256 } from "./stable";

interface DatabaseState {
  sessionCount: number;
  legacyMessages: number;
  legacyParts: number;
  contextEpochs: number;
  v2Messages: number;
  v2Inputs: number;
  v2Events: number;
  lastSeq: number;
  agent?: string;
  model: {
    id: string;
    providerID: string;
    variant?: string;
  };
}

interface MockAssertion {
  sentinelSeen: boolean;
  probeSeen: boolean;
  probeIndex: number;
  messageCount: number;
  requestDigest: string;
}

interface ContinuationProofReceipt {
  schemaVersion: 1;
  targetProfile: string;
  sessionId: string;
  sameSession: boolean;
  oldContextReachedModel: boolean;
  newProbeReachedModel: boolean;
  assistantWritePersisted: boolean;
  restartReadbackPassed: boolean;
  noNewSessionCreated: boolean;
  database: {
    before: Omit<DatabaseState, "agent" | "model">;
    after: Omit<DatabaseState, "agent" | "model">;
    sha256: string;
  };
  api: {
    admittedSeq: number;
    terminalSeq: number;
    mockRequestCount: number;
    modelMessageCount: number;
    requestDigest: string;
    messagesDigest: string;
    contextDigest: string;
    historyDigest: string;
  };
  completedAt: string;
}

const HTTP_MARKER = "\n__OPENCODE_HTTP_STATUS__:";
const DIRECTORY_QUERY = "directory=%2Fworkspace";
const CONTINUATION_HELPER_IMAGE =
  "oven/bun:1.3.13-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349";

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 48);
}

async function writeTextPrivate(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  init?: { method?: string; body?: string },
): Promise<unknown> {
  const command = [
    "curl",
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "--write-out",
    `${HTTP_MARKER}%{http_code}`,
    ...(init?.method ? ["--request", init.method] : []),
    ...(init?.body === undefined
      ? []
      : [
          "--header",
          "Content-Type: application/json",
          "--data-binary",
          "@-",
        ]),
    `${baseUrl}${path}`,
  ];
  const result = await runCommand(command, {
    ...(init?.body === undefined ? {} : { stdin: init.body }),
  });
  const split = result.stdout.lastIndexOf(HTTP_MARKER);
  if (split < 0) throw new Error(`HTTP_NO_STATUS: ${path}`);
  const status = Number.parseInt(
    result.stdout.slice(split + HTTP_MARKER.length),
    10,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP_${status}: ${path}`);
  }
  const text = result.stdout.slice(0, split);
  return text ? (JSON.parse(text) as unknown) : undefined;
}

function dataArray(value: unknown, label: string): unknown[] {
  const object = asObject(value);
  if (!object || !Array.isArray(object.data)) {
    throw new Error(`INVALID_${label.toUpperCase()}_RESPONSE`);
  }
  return object.data;
}

async function dockerPort(name: string, port: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await runCommand(
      ["docker", "port", name, `${port}/tcp`],
      { allowFailure: true },
    );
    const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
    if (match?.[1]) return match[1];
    await Bun.sleep(200);
  }
  throw new Error(`DOCKER_PORT_TIMEOUT: ${name}`);
}

async function waitFor(
  label: string,
  assertion: () => Promise<boolean>,
  timeout = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await assertion()) return;
    } catch {
      // Readiness endpoints may fail until the process has bound its port.
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `${label.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_TIMEOUT`,
  );
}

async function readMessages(
  baseUrl: string,
  sessionId: string,
): Promise<unknown[]> {
  const result: unknown[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const response = asObject(
      await jsonRequest(
        baseUrl,
        cursor
          ? `/api/session/${encodeURIComponent(sessionId)}/message?${DIRECTORY_QUERY}&limit=200&cursor=${encodeURIComponent(cursor)}`
          : `/api/session/${encodeURIComponent(sessionId)}/message?${DIRECTORY_QUERY}&limit=200&order=asc`,
      ),
    );
    result.push(...dataArray(response, "messages"));
    const cursorObject = response && asObject(response.cursor);
    const next = cursorObject && asString(cursorObject.next);
    if (next && seen.has(next)) {
      throw new Error("MESSAGE_CURSOR_REPEATED");
    }
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return result;
}

async function readHistoryAfter(
  baseUrl: string,
  sessionId: string,
  after: number,
): Promise<unknown[]> {
  const response = await jsonRequest(
    baseUrl,
    `/api/session/${encodeURIComponent(sessionId)}/history?${DIRECTORY_QUERY}&after=${after}&limit=100`,
  );
  return dataArray(response, "history");
}

function readDatabaseState(
  databasePath: string,
  sessionId: string,
): DatabaseState {
  const walPath = `${databasePath}-wal`;
  const hasNonEmptyWal =
    existsSync(walPath) && statSync(walPath).size > 0;
  const location = hasNonEmptyWal
    ? databasePath
    : (() => {
        const uri = pathToFileURL(databasePath);
        uri.searchParams.set("immutable", "1");
        return uri.href;
      })();
  const database = new Database(location, {
    readonly: true,
    strict: true,
  });
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    const row = database
      .query<
        {
          session_count: number;
          legacy_messages: number;
          legacy_parts: number;
          context_epochs: number;
          v2_messages: number;
          v2_inputs: number;
          v2_events: number;
          last_seq: number;
          agent: string | null;
          model: string | null;
        },
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      >(
        `SELECT
           (SELECT COUNT(*) FROM session) AS session_count,
           (SELECT COUNT(*) FROM message WHERE session_id = ?) AS legacy_messages,
           (SELECT COUNT(*) FROM part WHERE session_id = ?) AS legacy_parts,
           (SELECT COUNT(*) FROM session_context_epoch
            WHERE session_id = ?) AS context_epochs,
           (SELECT COUNT(*) FROM session_message
            WHERE session_id = ?) AS v2_messages,
           (SELECT COUNT(*) FROM session_input
            WHERE session_id = ?) AS v2_inputs,
           (SELECT COUNT(*) FROM event
            WHERE aggregate_id = ? AND type LIKE 'session.next.%') AS v2_events,
           COALESCE((
             SELECT seq FROM event_sequence WHERE aggregate_id = ?
           ), -1) AS last_seq,
           s.agent,
           s.model
         FROM session s
         WHERE s.id = ?`,
      )
      .get(
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
      );
    if (!row) throw new Error("SESSION_NOT_FOUND");
    const model = row.model && asObject(JSON.parse(row.model) as unknown);
    const id = model && asString(model.id);
    const providerID = model && asString(model.providerID);
    if (!id || !providerID) {
      throw new Error("SESSION_MODEL_UNAVAILABLE");
    }
    return {
      sessionCount: row.session_count,
      legacyMessages: row.legacy_messages,
      legacyParts: row.legacy_parts,
      contextEpochs: row.context_epochs,
      v2Messages: row.v2_messages,
      v2Inputs: row.v2_inputs,
      v2Events: row.v2_events,
      lastSeq: row.last_seq,
      ...(row.agent === null ? {} : { agent: row.agent }),
      model: {
        id,
        providerID,
        ...(asString(model.variant)
          ? { variant: asString(model.variant)! }
          : {}),
      },
    };
  } finally {
    database.close();
  }
}

function withoutSelection(
  state: DatabaseState,
): Omit<DatabaseState, "agent" | "model"> {
  const { agent: _, model: __, ...counts } = state;
  return counts;
}

export async function proveContinuationLocal(input: {
  candidateDatabase: string;
  sessionId: string;
  legacySentinelFile: string;
  runDir: string;
  runId: string;
  image?: string;
}): Promise<ContinuationProofReceipt> {
  const image = resolvePinnedOpenCodeImage(input.image);
  const databasePath = resolveDatabasePath(input.candidateDatabase);
  const sentinelPath = resolve(input.legacySentinelFile);
  const sentinelMode = (await stat(sentinelPath)).mode & 0o777;
  if ((sentinelMode & 0o077) !== 0) {
    throw new Error("SENTINEL_FILE_NOT_PRIVATE");
  }
  const sentinel = (await readFile(sentinelPath, "utf8")).trim();
  if (sentinel.length < 8) throw new Error("SENTINEL_TOO_SHORT");

  const runDir = await ensurePrivateDirectory(input.runDir);
  const workDir = await mkdtemp(join(runDir, ".continuation-work-"));
  await chmod(workDir, 0o700);
  const suffix = safeName(
    `${input.runId}-${randomBytes(4).toString("hex")}`,
  );
  const network = `opencode-proof-${suffix}`.slice(0, 63);
  const mockName = `opencode-proof-mock-${suffix}`.slice(0, 63);
  const openCodeName = `opencode-proof-app-${suffix}`.slice(0, 63);
  const probe = `MIGRATION_PROBE_${randomBytes(16).toString("hex")}`;
  const unusedProbe = `MIGRATION_PROBE_${randomBytes(16).toString("hex")}`;
  const proof = `MIGRATION_CONTEXT_OK_${randomBytes(16).toString("hex")}`;
  const before = readDatabaseState(databasePath, input.sessionId);
  if (
    before.legacyMessages !== 0 ||
    before.legacyParts !== 0 ||
    before.contextEpochs !== 0
  ) {
    throw new Error("CONTINUATION_REQUIRES_VERIFIED_CLEANUP");
  }
  const model = before.model;
  const configPath = join(workDir, "opencode.json");
  const envPath = join(workDir, "mock.env");
  const mockSource = resolve(
    import.meta.dir,
    "continuation-mock-server.ts",
  );
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${model.providerID}/${model.id}`,
    providers: {
      [model.providerID]: {
        name: "Migration continuation proof",
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: `http://${mockName}:8787/v1`,
        },
        request: { body: { apiKey: "local-proof-key" } },
        models: {
          [model.id]: {
            api: { id: model.id },
            name: "Migration proof model",
            capabilities: {
              tools: true,
              input: ["text"],
              output: ["text"],
            },
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  };
  await writeJsonSecure(configPath, config);
  await writeTextPrivate(
    envPath,
    [
      `E2E_LEGACY_SENTINEL_B64=${Buffer.from(sentinel).toString("base64")}`,
      `E2E_PROBE_1=${probe}`,
      `E2E_PROBE_2=${unusedProbe}`,
      `E2E_PROOF=${proof}`,
      `E2E_MODEL_ID=${model.id}`,
      "",
    ].join("\n"),
  );

  let mockBaseUrl = "";
  let appBaseUrl = "";
  const startOpenCode = async (): Promise<void> => {
    await runCommand([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--name",
      openCodeName,
      "--network",
      network,
      "--publish",
      "127.0.0.1::4096",
      "--volume",
      `${dirname(databasePath)}:/migration`,
      "--volume",
      `${workDir}:/workspace`,
      "--workdir",
      "/workspace",
      "--env",
      `OPENCODE_DB=/migration/${basename(databasePath)}`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-lc",
      "exec opencode serve --hostname 0.0.0.0 --port 4096",
    ]);
    appBaseUrl = `http://127.0.0.1:${await dockerPort(
      openCodeName,
      4096,
    )}`;
    await waitFor("opencode health", async () => {
      const health = asObject(
        await jsonRequest(appBaseUrl, "/global/health"),
      );
      return (
        health?.healthy === true &&
        health.version === REQUIRED_OPENCODE_VERSION
      );
    });
    await waitFor("opencode model", async () => {
      const response = await jsonRequest(
        appBaseUrl,
        `/api/model?${DIRECTORY_QUERY}`,
      );
      const serialized = JSON.stringify(response);
      return (
        serialized.includes(model.providerID) &&
        serialized.includes(model.id)
      );
    });
  };

  try {
    await assertCompatibleOpenCodeImage(image);
    await runCommand(["docker", "network", "create", network]);
    await runCommand([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--name",
      mockName,
      "--network",
      network,
      "--publish",
      "127.0.0.1::8787",
      "--env-file",
      envPath,
      "--volume",
      `${mockSource}:/e2e/server.ts:ro`,
      "--entrypoint",
      "/bin/sh",
      CONTINUATION_HELPER_IMAGE,
      "-lc",
      "exec bun /e2e/server.ts",
    ]);
    mockBaseUrl = `http://127.0.0.1:${await dockerPort(mockName, 8787)}`;
    await waitFor("mock model", async () => {
      const health = asObject(await jsonRequest(mockBaseUrl, "/health"));
      return health?.healthy === true;
    });

    await startOpenCode();
    const promptId = `msg_${randomBytes(16).toString("base64url")}`;
    const admittedResponse = asObject(
      await jsonRequest(
        appBaseUrl,
        `/api/session/${encodeURIComponent(input.sessionId)}/prompt?${DIRECTORY_QUERY}`,
        {
          method: "POST",
          body: JSON.stringify({
            id: promptId,
            prompt: { text: probe },
            delivery: "steer",
          }),
        },
      ),
    );
    const admitted = admittedResponse && asObject(admittedResponse.data);
    const admittedSeq =
      admitted && typeof admitted.admittedSeq === "number"
        ? admitted.admittedSeq
        : undefined;
    if (
      admittedSeq === undefined ||
      admitted?.sessionID !== input.sessionId ||
      admitted.id !== promptId
    ) {
      throw new Error("CONTINUATION_CHANGED_SESSION");
    }

    let terminalSeq = -1;
    let terminalHistory: unknown[] = [];
    await waitFor("continuation terminal", async () => {
      terminalHistory = await readHistoryAfter(
        appBaseUrl,
        input.sessionId,
        admittedSeq,
      );
      for (const entry of terminalHistory) {
        const event = asObject(entry);
        if (
          event?.type !== "session.next.step.ended" &&
          event?.type !== "session.next.step.failed"
        ) {
          continue;
        }
        const durable = asObject(event.durable);
        if (typeof durable?.seq === "number") {
          terminalSeq = durable.seq;
          return true;
        }
      }
      return false;
    });

    const messages = await readMessages(appBaseUrl, input.sessionId);
    const context = dataArray(
      await jsonRequest(
        appBaseUrl,
        `/api/session/${encodeURIComponent(input.sessionId)}/context?${DIRECTORY_QUERY}`,
      ),
      "context",
    );
    const mockResponse = asObject(
      await jsonRequest(mockBaseUrl, "/assertions"),
    );
    const mockAssertions = Array.isArray(mockResponse?.assertions)
      ? (mockResponse.assertions as MockAssertion[])
      : [];
    const relevant = mockAssertions.findLast(
      (entry) => entry.probeSeen === true,
    );
    if (!relevant) throw new Error("MOCK_REQUEST_NOT_OBSERVED");
    const assistantWritePersisted = JSON.stringify(messages).includes(proof);
    if (
      !relevant.sentinelSeen ||
      !relevant.probeSeen ||
      !assistantWritePersisted
    ) {
      throw new Error("CONTINUATION_CONTEXT_PROOF_FAILED");
    }

    await runCommand([
      "docker",
      "stop",
      "--time",
      "10",
      openCodeName,
    ]);
    const after = readDatabaseState(databasePath, input.sessionId);
    if (
      after.sessionCount !== before.sessionCount ||
      after.v2Messages <= before.v2Messages ||
      after.v2Inputs <= before.v2Inputs ||
      after.lastSeq <= before.lastSeq
    ) {
      throw new Error("CONTINUATION_DURABILITY_FAILED");
    }
    if (
      after.legacyMessages !== before.legacyMessages ||
      after.legacyParts !== before.legacyParts
    ) {
      throw new Error("CONTINUATION_CHANGED_LEGACY_PROJECTION");
    }

    await startOpenCode();
    const restartedMessages = await readMessages(
      appBaseUrl,
      input.sessionId,
    );
    const restartReadbackPassed =
      JSON.stringify(restartedMessages).includes(proof);
    if (!restartReadbackPassed) {
      throw new Error("CONTINUATION_RESTART_READBACK_FAILED");
    }
    await runCommand([
      "docker",
      "stop",
      "--time",
      "10",
      openCodeName,
    ]);

    const receipt: ContinuationProofReceipt = {
      schemaVersion: 1,
      targetProfile: MIGRATION_TARGET_PROFILE,
      sessionId: input.sessionId,
      sameSession: true,
      oldContextReachedModel: relevant.sentinelSeen,
      newProbeReachedModel: relevant.probeSeen,
      assistantWritePersisted,
      restartReadbackPassed,
      noNewSessionCreated: after.sessionCount === before.sessionCount,
      database: {
        before: withoutSelection(before),
        after: withoutSelection(after),
        sha256: await sha256File(databasePath),
      },
      api: {
        admittedSeq,
        terminalSeq,
        mockRequestCount: mockAssertions.length,
        modelMessageCount: relevant.messageCount,
        requestDigest: relevant.requestDigest,
        messagesDigest: sha256(messages),
        contextDigest: sha256(context),
        historyDigest: sha256(terminalHistory),
      },
      completedAt: new Date().toISOString(),
    };
    await writeJsonSecure(
      resolve(runDir, "continuation-proof.json"),
      receipt,
      { overwrite: true },
    );
    return receipt;
  } finally {
    await runCommand(["docker", "rm", "-f", openCodeName], {
      allowFailure: true,
    });
    await runCommand(["docker", "rm", "-f", mockName], {
      allowFailure: true,
    });
    await runCommand(["docker", "network", "rm", network], {
      allowFailure: true,
    });
    await rm(workDir, { recursive: true, force: true });
  }
}
