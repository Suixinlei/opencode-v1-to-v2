import { describe, expect, test } from "bun:test";
import { MIGRATION_TARGET_PROFILE } from "../src/contracts";
import {
  REQUIRED_OPENCODE_VERSION,
  requiredOpenCodeBinarySha256,
  resolvePinnedOpenCodeImage,
} from "../src/open-code-replay";

describe("OpenCode target image", () => {
  test("accepts an explicitly digest-pinned image", () => {
    const image = `ghcr.io/example/opencode@sha256:${"a".repeat(64)}`;
    expect(resolvePinnedOpenCodeImage(image)).toBe(image);
  });

  test("rejects missing and tag-only images before Docker starts", () => {
    expect(() => resolvePinnedOpenCodeImage("")).toThrow(
      "MISSING_OPENCODE_IMAGE",
    );
    expect(() => resolvePinnedOpenCodeImage("ghcr.io/example/opencode:1.18.9"))
      .toThrow("TARGET_PROFILE_MISMATCH");
  });

  test("binds each published architecture to an official binary digest", () => {
    expect(requiredOpenCodeBinarySha256("x86_64")).toBe(
      "fcd56e4ea76e80b08b936cd2fb3dff18a1eaf8c871180e66e2e7424c3634c188",
    );
    expect(requiredOpenCodeBinarySha256("aarch64")).toBe(
      "6f08a8a1e91dfe0720d2b6eae8767c10d236c808b7147c5c1944da2862b0b0ce",
    );
    expect(() => requiredOpenCodeBinarySha256("ppc64le")).toThrow(
      "unsupported OpenCode image architecture",
    );
  });

  test("keeps the image manifest, Dockerfile, and runtime profile in sync", async () => {
    const profile = (await Bun.file(
      new URL("../docker/opencode-target/profile.json", import.meta.url),
    ).json()) as {
      targetProfile: string;
      openCode: { version: string };
      baseImage: string;
      runtimePackages: Record<
        string,
        string | Record<string, { asset: string; sha256: string }>
      >;
      platforms: Record<
        string,
        { asset: string; archiveSha256: string; binarySha256: string }
      >;
    };
    const dockerfile = await Bun.file(
      new URL("../docker/opencode-target/Dockerfile", import.meta.url),
    ).text();

    expect(profile.targetProfile).toBe(MIGRATION_TARGET_PROFILE);
    expect(profile.openCode.version).toBe(REQUIRED_OPENCODE_VERSION);
    expect(profile.platforms["linux/amd64"]?.binarySha256).toBe(
      requiredOpenCodeBinarySha256("x86_64"),
    );
    expect(profile.platforms["linux/arm64"]?.binarySha256).toBe(
      requiredOpenCodeBinarySha256("aarch64"),
    );
    expect(dockerfile).toContain(profile.baseImage);
    for (const platform of Object.values(profile.platforms)) {
      expect(dockerfile).toContain(platform.asset);
      expect(dockerfile).toContain(platform.archiveSha256);
      expect(dockerfile).toContain(platform.binarySha256);
    }
    for (const packages of Object.values(profile.runtimePackages)) {
      if (typeof packages === "string") continue;
      for (const runtimePackage of Object.values(packages)) {
        expect(dockerfile).toContain(runtimePackage.asset);
        expect(dockerfile).toContain(runtimePackage.sha256);
      }
    }
  });
});
