# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build.ts

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ARG TARGETARCH=amd64

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        zip \
        unzip \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/binaries/anpan-os-linux-x64   ./anpan-os-x64
COPY --from=builder /build/binaries/anpan-os-linux-arm64  ./anpan-os-arm64
COPY --from=builder /build/dist                           ./dist

RUN if [ "$TARGETARCH" = "arm64" ]; then \
        mv anpan-os-arm64 anpan-os && rm -f anpan-os-x64; \
    else \
        mv anpan-os-x64 anpan-os && rm -f anpan-os-arm64; \
    fi && chmod +x anpan-os

ENV RUNTIME_CONFIG_DIR=/config

EXPOSE 3000

CMD ["./anpan-os"]
