/** Stable hashing and deterministic identifiers for crash-safe reruns. */
import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : stableJson(value),
  ).digest("hex")}`;
}

export function deterministicId(
  prefix: "evt_" | "msg_",
  ...components: readonly unknown[]
): string {
  const digest = createHash("sha256")
    .update(stableJson(components))
    .digest("hex");
  return `${prefix}mig_${digest.slice(0, 48)}`;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
