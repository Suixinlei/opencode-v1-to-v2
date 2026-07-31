import { chmod } from "node:fs/promises";

function parseJsonColumn(value: unknown): void {
  if (typeof value === "string") JSON.parse(value);
}

function assertParseableMessage(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message row is not an object");
  }
  const row = value as Record<string, unknown>;
  parseJsonColumn(row.data);
  if (row.parts !== undefined) {
    if (!Array.isArray(row.parts)) {
      throw new Error("message parts is not an array");
    }
    for (const rawPart of row.parts) {
      if (
        !rawPart ||
        typeof rawPart !== "object" ||
        Array.isArray(rawPart)
      ) {
        throw new Error("message part is not an object");
      }
      parseJsonColumn((rawPart as Record<string, unknown>).data);
    }
  }
}

async function checkSession(
  controllerBase: string,
  appCode: string,
  userId: string,
  sessionId: string,
): Promise<{ sessionId: string; count: number; verified: true }> {
  const url = new URL("/api/v1/sessions/messages", controllerBase);
  url.searchParams.set("appCode", appCode);
  url.searchParams.set("userId", userId);
  url.searchParams.set("sessionId", sessionId);

  let lastTransientFailure = "unknown response";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status !== 200) {
        lastTransientFailure = `HTTP ${response.status}`;
      } else {
        const payload = (await response.json()) as {
          success?: unknown;
          data?: unknown;
        };
        if (payload.success !== true || !Array.isArray(payload.data)) {
          lastTransientFailure = "response was not success=true with a data array";
        } else if (payload.data.length === 0) {
          lastTransientFailure = "message array was empty";
        } else {
          for (const message of payload.data) assertParseableMessage(message);
          return {
            sessionId,
            count: payload.data.length,
            verified: true,
          };
        }
      }
    } catch (error) {
      lastTransientFailure =
        error instanceof Error ? error.message : String(error);
    }
    if (attempt < 20) await Bun.sleep(1_000);
  }
  throw new Error(
    `session ${sessionId} failed structural messages acceptance after 20 attempts: ${lastTransientFailure}`,
  );
}

const [controllerBase, appCode, userId, reportPath, ...sessionIds] =
  Bun.argv.slice(2);
if (
  !controllerBase ||
  !appCode ||
  !userId ||
  !reportPath ||
  sessionIds.length === 0
) {
  throw new Error(
    "usage: check-controller-messages.ts controller app user report session...",
  );
}

const results: Array<
  { sessionId: string; count: number; verified: true } | undefined
> = new Array(sessionIds.length);
let cursor = 0;
const workers = Array.from(
  { length: Math.min(8, sessionIds.length) },
  async () => {
    while (true) {
      const index = cursor++;
      if (index >= sessionIds.length) return;
      results[index] = await checkSession(
        controllerBase,
        appCode,
        userId,
        sessionIds[index]!,
      );
    }
  },
);
await Promise.all(workers);
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  acceptanceMode: "structural-messages",
  appCode,
  userId,
  verified: results.every((item) => item?.verified === true),
  sessions: results,
};
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  createPath: true,
});
await chmod(reportPath, 0o600);
console.log(
  JSON.stringify({
    verified: report.verified,
    sessions: results.length,
    nonEmpty: results.filter((item) => (item?.count ?? 0) > 0).length,
  }),
);
