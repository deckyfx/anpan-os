# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Only the Linux targets. build.ts also cross-compiles the macOS binaries, which are of no
# use inside a Linux image and roughly double the build time.
RUN BUILD_TARGETS="bun-linux-x64,bun-linux-arm64" bun run build.ts

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        zip \
        unzip \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/binaries/anpan-os-linux-x64   ./anpan-os-x64
COPY --from=builder /build/binaries/anpan-os-linux-arm64  ./anpan-os-arm64
# No dist/ is copied: build.ts has never produced one, so this image has never built. The
# compiled binary embeds the frontend, which is why nothing noticed it was missing.

# Pick the binary by asking the architecture this stage is running on, rather than by
# reading TARGETARCH. The automatic build arg was declared with a default of `amd64` and
# resolved to that default here, so an arm64 image shipped the x86-64 binary and died at
# startup with "rosetta error: failed to open elf". This step already executes under the
# target platform, so uname is both simpler and answerable.
RUN ARCH="$(uname -m)"; \
    case "$ARCH" in \
      aarch64|arm64) mv anpan-os-arm64 anpan-os && rm -f anpan-os-x64   ;; \
      x86_64|amd64)  mv anpan-os-x64   anpan-os && rm -f anpan-os-arm64 ;; \
      *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac && chmod +x anpan-os

ENV RUNTIME_CONFIG_DIR=/config

EXPOSE 3000

CMD ["./anpan-os"]
