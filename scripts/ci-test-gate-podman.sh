#!/usr/bin/env bash
set -euo pipefail

# Local fallback runner: execute the same CI gate inside a pinned Node image.
IMAGE="docker.io/library/node:22.17.1"

podman run --rm \
  -v "$(pwd)":/workspace \
  -w /tmp \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    rm -rf /tmp/swarmie-ci
    mkdir -p /tmp/swarmie-ci

    # Avoid NFS/rootless fs quirks by running install/build inside container fs.
    tar --exclude=.git --exclude=node_modules --exclude=dist -C /workspace -cf - . | tar --no-same-owner --no-same-permissions -C /tmp/swarmie-ci -xf -

    cd /tmp/swarmie-ci
    npm_config_nodedir=/usr/local npm ci

    set +e
    bash scripts/ci-test-gate.sh
    gate_ec=$?
    set -e

    mkdir -p /workspace/artifacts/test-gate
    cp -f artifacts/test-gate/*.log /workspace/artifacts/test-gate/ 2>/dev/null || true

    exit "$gate_ec"
  '
