# syntax=docker/dockerfile:1.7

FROM scratch AS upstream
ADD --checksum=sha256:5238a504bb6fee4e9a1507e551e6f32894ce9d2e1afcbcec5672cff61d0ad270 \
  https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-linux-x64-musl.tar.gz \
  /opencode-amd64.tar.gz
ADD --checksum=sha256:8fe9da991068f9e1524c6cb34dad52806bf5927baaa4d583b6fd4ea7987210f4 \
  https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-linux-arm64-musl.tar.gz \
  /opencode-arm64.tar.gz
ADD --checksum=sha256:04f3467bc967e705221a843fe4d3de5850db826e571686e0c0ed453d38cb5c59 \
  https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/libgcc-14.2.0-r6.apk \
  /libgcc-amd64.apk
ADD --checksum=sha256:939f7c99898f3e8154207a17f4acbe8bc40437e1bb1b43f5525620ca9e452a2e \
  https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/libstdc++-14.2.0-r6.apk \
  /libstdcxx-amd64.apk
ADD --checksum=sha256:ba1835eec3ad8a120efd3d5020e561d53553a0513763a08f509e3ce6d4baa9ca \
  https://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64/libgcc-14.2.0-r6.apk \
  /libgcc-arm64.apk
ADD --checksum=sha256:0d2f054057a4f932e985a129eccb79908b40964185139a0a609aed3032aba064 \
  https://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64/libstdc++-14.2.0-r6.apk \
  /libstdcxx-arm64.apk

FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1

ARG TARGETARCH
ARG OPENCODE_VERSION=1.18.9

COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md \
  /usr/share/licenses/opencode-v1-to-v2-target/
COPY docker/opencode-target/profile.json \
  /usr/share/opencode-v1-to-v2-target/profile.json

RUN --mount=type=bind,from=upstream,source=/,target=/upstream,ro \
  set -eux; \
  tar -xzf "/upstream/libgcc-${TARGETARCH}.apk" -C / \
    usr/lib/libgcc_s.so.1; \
  tar -xzf "/upstream/libstdcxx-${TARGETARCH}.apk" -C / \
    usr/lib/libstdc++.so.6 \
    usr/lib/libstdc++.so.6.0.33; \
  tar -xzf "/upstream/opencode-${TARGETARCH}.tar.gz" -C /usr/local/bin; \
  chmod 0755 /usr/local/bin/opencode; \
  case "${TARGETARCH}" in \
    amd64) expected="fcd56e4ea76e80b08b936cd2fb3dff18a1eaf8c871180e66e2e7424c3634c188" ;; \
    arm64) expected="6f08a8a1e91dfe0720d2b6eae8767c10d236c808b7147c5c1944da2862b0b0ce" ;; \
    *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  echo "${expected}  /usr/local/bin/opencode" | sha256sum -c -; \
  test "$(opencode --version)" = "${OPENCODE_VERSION}"

LABEL org.opencontainers.image.title="OpenCode V1 to V2 migration target"
LABEL org.opencontainers.image.description="Pinned OpenCode runtime used only for official replay and continuation verification"
LABEL org.opencontainers.image.source="https://github.com/Suixinlei/opencode-v1-to-v2"
LABEL org.opencontainers.image.url="https://github.com/Suixinlei/opencode-v1-to-v2/tree/main/docker/opencode-target"
LABEL org.opencontainers.image.version="1.18.9-4da7bb44"
LABEL org.opencontainers.image.licenses="Apache-2.0 AND MIT"

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/opencode"]
