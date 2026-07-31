import { chmod } from "node:fs/promises";
import { Database } from "bun:sqlite";

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  time_created: number;
  time_updated: number;
  data: unknown;
  parts: unknown[];
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(stable(value));
  return `sha256:${hash.digest("hex")}`;
}

function normalizeRow(value: unknown): MessageRow {
  if (!value || typeof value !== "object") throw new Error("invalid API row");
  const row = value as Record<string, unknown>;
  const parsedData =
    typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    role: String(row.role),
    time_created: Number(row.time_created),
    time_updated: Number(row.time_updated),
    data: parsedData,
    parts: Array.isArray(row.parts) ? row.parts : [],
  };
}

function expectedRows(database: Database, sessionId: string): MessageRow[] {
  return database
    .query<
      {
        id: string;
        session_id: string;
        role: string;
        time_created: number;
        time_updated: number;
        data: string;
      },
      [string]
    >(
      `SELECT
         id,
         session_id,
         type AS role,
         time_created,
         time_updated,
         data
       FROM session_message
       WHERE session_id = ?
       ORDER BY time_created, id`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      data: JSON.parse(row.data),
      parts: [],
    }));
}

function legacyCount(database: Database, sessionId: string): number {
  return database
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM message WHERE session_id = ?",
    )
    .get(sessionId)!.count;
}

function includesExpectedRows(
  actual: readonly MessageRow[],
  expected: readonly MessageRow[],
): boolean {
  const remaining = new Map<string, number>();
  for (const row of actual) {
    const key = stable(row);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const row of expected) {
    const key = stable(row);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
  }
  return true;
}

async function readRows(url: string): Promise<MessageRow[]> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    success?: boolean;
    data?: unknown;
  };
  if (payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error("messages API returned an invalid payload");
  }
  return payload.data.map(normalizeRow);
}

const [
  databasePath,
  controllerBase,
  appCode,
  userId,
  reportPath,
  ...sessionIds
] = Bun.argv.slice(2);

if (
  !databasePath ||
  !controllerBase ||
  !appCode ||
  !userId ||
  !reportPath ||
  sessionIds.length === 0
) {
  throw new Error(
    "usage: verify-controller-messages.ts db controller app user report session...",
  );
}

const database = new Database(databasePath, { readonly: true, strict: true });
database.exec("PRAGMA query_only = ON");
try {
  const results = [];
  for (const sessionId of sessionIds) {
    const expected = expectedRows(database, sessionId);
    const expectedLegacyRows = legacyCount(database, sessionId);
    const controllerUrl = new URL("/api/v1/sessions/messages", controllerBase);
    controllerUrl.searchParams.set("appCode", appCode);
    controllerUrl.searchParams.set("userId", userId);
    controllerUrl.searchParams.set("sessionId", sessionId);
    const controller = await readRows(controllerUrl.toString());
    const controllerExact = stable(controller) === stable(expected);
    const controllerLegacyUnion =
      expectedLegacyRows > 0 &&
      controller.length === expected.length + expectedLegacyRows &&
      includesExpectedRows(controller, expected);
    results.push({
      sessionId,
      expectedCount: expected.length,
      expectedLegacyRows,
      expectedDigest: digest(expected),
      controller: {
        exact: controllerExact,
        legacyUnion: controllerLegacyUnion,
        count: controller.length,
        digest: digest(controller),
      },
      verified: controllerExact || controllerLegacyUnion,
    });
  }
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    appCode,
    userId,
    verified: results.every((item) => item.verified),
    sessions: results,
  };
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    createPath: true,
  });
  await chmod(reportPath, 0o600);
  console.log(
    JSON.stringify({
      verified: report.verified,
      sessions: results.map((item) => ({
        sessionId: item.sessionId,
        count: item.expectedCount,
        controllerExact: item.controller.exact,
        controllerLegacyUnion: item.controller.legacyUnion,
      })),
    }),
  );
  if (!report.verified) process.exitCode = 1;
} finally {
  database.close();
}
