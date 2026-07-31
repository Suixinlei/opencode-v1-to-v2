import { basename, dirname } from "node:path";
import type { MigrationPlan, ReplayEvent } from "./contracts";
import { runCommand } from "./process";
import { versionedType } from "./recipe-v1-to-v2";
import { sha256 } from "./stable";

export const REQUIRED_OPENCODE_VERSION = "1.18.9";
export const REQUIRED_OPENCODE_BINARY_SHA256_BY_MACHINE = {
  x86_64: "fcd56e4ea76e80b08b936cd2fb3dff18a1eaf8c871180e66e2e7424c3634c188",
  aarch64: "6f08a8a1e91dfe0720d2b6eae8767c10d236c808b7147c5c1944da2862b0b0ce",
} as const;

const DIGEST_PINNED_IMAGE = /^[^\s]+@sha256:[a-f0-9]{64}$/;

export function requiredOpenCodeBinarySha256(machine: string): string {
  const expected =
    REQUIRED_OPENCODE_BINARY_SHA256_BY_MACHINE[
      machine as keyof typeof REQUIRED_OPENCODE_BINARY_SHA256_BY_MACHINE
    ];
  if (!expected) {
    throw new Error(
      `TARGET_PROFILE_MISMATCH: unsupported OpenCode image architecture ${machine}`,
    );
  }
  return expected;
}

export function resolvePinnedOpenCodeImage(image?: string): string {
  const resolved = image ?? process.env.OPENCODE_MIGRATION_IMAGE;
  if (!resolved) {
    throw new Error(
      "MISSING_OPENCODE_IMAGE: pass --image <repository@sha256:digest> or set OPENCODE_MIGRATION_IMAGE",
    );
  }
  if (!DIGEST_PINNED_IMAGE.test(resolved)) {
    throw new Error(
      "TARGET_PROFILE_MISMATCH: OpenCode image must be pinned by sha256 digest",
    );
  }
  return resolved;
}

export async function assertCompatibleOpenCodeImage(
  image: string,
): Promise<void> {
  const identity = (
    await runCommand([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "/bin/sh",
      image,
      "-lc",
      'opencode --version && uname -m && sha256sum "$(command -v opencode)"',
    ])
  ).stdout.trim().split(/\s+/);
  const version = identity[0];
  const machine = identity[1] ?? "";
  const binarySha256 = identity[2];
  if (version !== REQUIRED_OPENCODE_VERSION) {
    throw new Error(
      `TARGET_PROFILE_MISMATCH: expected ${REQUIRED_OPENCODE_VERSION}, got ${version}`,
    );
  }
  const expectedBinarySha256 = requiredOpenCodeBinarySha256(machine);
  if (binarySha256 !== expectedBinarySha256) {
    throw new Error(
      `TARGET_PROFILE_MISMATCH: OpenCode binary digest changed for ${machine}`,
    );
  }
}

export interface ReplaySmokeResult {
  sessionId: string;
  messages: number;
  historyEvents: number;
  contextMessages: number;
  messagesDigest: string;
  historyDigest: string;
  contextDigest: string;
}

function dockerName(runId: string): string {
  const safe = runId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  return `opencode-migration-${safe}`.slice(0, 63);
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<unknown> {
  const marker = "\n__OPENCODE_HTTP_STATUS__:";
  const command = [
    "curl",
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "--write-out",
    `${marker}%{http_code}`,
    ...(init?.method ? ["--request", init.method] : []),
    ...Object.entries(init?.headers ?? {}).flatMap(([name, value]) => [
      "--header",
      `${name}: ${value}`,
    ]),
    ...(init?.body === undefined ? [] : ["--data-binary", "@-"]),
    `${baseUrl}${path}`,
  ];
  const result = await runCommand(command, {
    ...(init?.body === undefined ? {} : { stdin: String(init.body) }),
  });
  const split = result.stdout.lastIndexOf(marker);
  if (split < 0) {
    throw new Error(`OpenCode ${path} returned no HTTP status`);
  }
  const text = result.stdout.slice(0, split);
  const status = Number.parseInt(
    result.stdout.slice(split + marker.length),
    10,
  );
  if (status < 200 || status >= 300) {
    throw new Error(
      `OpenCode ${path} failed with HTTP ${status}`,
    );
  }
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function dataArray(value: unknown, path: string): unknown[] {
  if (!value || typeof value !== "object") {
    throw new Error(`${path} returned an invalid response`);
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error(`${path} returned no data array`);
  }
  return data;
}

async function readMessages(
  baseUrl: string,
  encodedSessionId: string,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const value = (await jsonRequest(
      baseUrl,
      cursor
        ? `/api/session/${encodedSessionId}/message?limit=200&cursor=${encodeURIComponent(cursor)}`
        : `/api/session/${encodedSessionId}/message?limit=200&order=asc`,
    )) as {
      data?: unknown[];
      cursor?: { next?: string };
    };
    messages.push(...dataArray(value, "messages"));
    const next =
      typeof value.cursor?.next === "string"
        ? value.cursor.next
        : undefined;
    if (next && seen.has(next)) {
      throw new Error("messages pagination cursor repeated");
    }
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return messages;
}

async function readHistory(
  baseUrl: string,
  encodedSessionId: string,
): Promise<unknown[]> {
  const history: unknown[] = [];
  let after: number | undefined;
  while (true) {
    const value = (await jsonRequest(
      baseUrl,
      `/api/session/${encodedSessionId}/history?limit=100${
        after === undefined ? "" : `&after=${after}`
      }`,
    )) as { data?: unknown[]; hasMore?: boolean };
    const events = dataArray(value, "history");
    history.push(...events);
    if (value.hasMore !== true) return history;
    const last = events.at(-1);
    const durable =
      last && typeof last === "object"
        ? (last as { durable?: unknown }).durable
        : undefined;
    const seq =
      durable && typeof durable === "object"
        ? (durable as { seq?: unknown }).seq
        : undefined;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= (after ?? -1)) {
      throw new Error("history pagination did not advance");
    }
    after = seq;
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let latest = "not ready";
  while (Date.now() < deadline) {
    try {
      const value = await jsonRequest(baseUrl, "/global/health");
      const health = value as { healthy?: boolean; version?: string };
      if (
        health.healthy === true &&
        health.version === REQUIRED_OPENCODE_VERSION
      ) {
        return;
      }
      latest = JSON.stringify(health);
    } catch (error) {
      latest = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`OpenCode did not become healthy: ${latest}`);
}

async function assertNoActiveSessions(
  baseUrl: string,
  sessionIds: ReadonlySet<string>,
): Promise<void> {
  const value = (await jsonRequest(
    baseUrl,
    "/api/session/active",
  )) as { data?: Record<string, unknown> };
  const active = Object.keys(value.data ?? {}).filter((id) => sessionIds.has(id));
  if (active.length > 0) {
    throw new Error(`TARGET_BUSY: active sessions ${active.join(", ")}`);
  }
}

async function replay(
  baseUrl: string,
  events: readonly ReplayEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await jsonRequest(baseUrl, "/sync/replay?directory=%2Fworkspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directory: "/workspace",
      events: events.map((event) => ({
        ...event,
        type: versionedType(event.type),
      })),
    }),
  });
}

async function smokeSession(
  baseUrl: string,
  sessionId: string,
): Promise<ReplaySmokeResult> {
  const encoded = encodeURIComponent(sessionId);
  const contextResponse = await jsonRequest(
    baseUrl,
    `/api/session/${encoded}/context`,
  );
  const context = dataArray(contextResponse, "context");
  const [messages, history] = await Promise.all([
    readMessages(baseUrl, encoded),
    readHistory(baseUrl, encoded),
  ]);
  return {
    sessionId,
    messages: messages.length,
    historyEvents: history.length,
    contextMessages: context.length,
    messagesDigest: sha256(messages),
    historyDigest: sha256(history),
    contextDigest: sha256(context),
  };
}

export async function replayWithPinnedOpenCode(input: {
  candidateDatabase: string;
  plan: MigrationPlan;
  runId: string;
  image?: string;
  stopAfterEvents?: number;
}): Promise<{
  image: string;
  version: typeof REQUIRED_OPENCODE_VERSION;
  smoke: ReplaySmokeResult[];
  intentionallyInterrupted: boolean;
}> {
  const image = resolvePinnedOpenCodeImage(input.image);
  await assertCompatibleOpenCodeImage(image);

  const name = dockerName(input.runId);
  await runCommand(["docker", "rm", "-f", name], { allowFailure: true });
  const databaseDir = dirname(input.candidateDatabase);
  const databaseFile = basename(input.candidateDatabase);
  await runCommand([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::4096",
    "--volume",
    `${databaseDir}:/migration`,
    "--env",
    `OPENCODE_DB=/migration/${databaseFile}`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-lc",
    "exec opencode serve --hostname 0.0.0.0 --port 4096",
  ]);

  try {
    let port = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await runCommand(
        ["docker", "port", name, "4096/tcp"],
        { allowFailure: true },
      );
      const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
      if (match?.[1]) {
        port = match[1];
        break;
      }
      await Bun.sleep(200);
    }
    if (!port) throw new Error("Docker did not publish OpenCode port");
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const migrating = new Set(
      input.plan.sessions
        .filter(
          (session) =>
            session.state === "eligible" || session.state === "resumable",
        )
        .map((session) => session.sessionId),
    );
    await assertNoActiveSessions(baseUrl, migrating);

    let remaining = input.stopAfterEvents;
    let intentionallyInterrupted = false;
    for (const session of input.plan.sessions) {
      if (
        session.state !== "eligible" &&
        session.state !== "resumable"
      ) {
        continue;
      }
      let events = session.events;
      if (remaining !== undefined) {
        events = events.slice(0, Math.max(0, remaining));
        remaining -= events.length;
        if (events.length < session.events.length) {
          intentionallyInterrupted = true;
        }
      }
      await replay(baseUrl, events);
      if (intentionallyInterrupted || remaining === 0) break;
    }

    const smoke = intentionallyInterrupted
      ? []
      : await Promise.all(
          [...migrating].map((sessionId) =>
            smokeSession(baseUrl, sessionId),
          ),
        );
    return {
      image,
      version: REQUIRED_OPENCODE_VERSION,
      smoke,
      intentionallyInterrupted,
    };
  } finally {
    await runCommand(["docker", "stop", "--time", "10", name], {
      allowFailure: true,
    });
  }
}
