#!/usr/bin/env bash
# check-version.sh — Verify that the pinned Tailscale image matches ghcr.io stable.
# Exits 1 with a human-readable error if stable has moved ahead of the pinned tag.
# Set SKIP_VERSION_CHECK=1 to bypass.
set -euo pipefail

MANIFEST="startos/manifest/index.ts"
REGISTRY="ghcr.io"
IMAGE="tailscale/tailscale"

if [[ "${SKIP_VERSION_CHECK:-}" == "1" ]]; then
  echo "WARNING: SKIP_VERSION_CHECK=1 — skipping Tailscale version check." >&2
  exit 0
fi

# Parse pinned version from manifest (e.g. ghcr.io/tailscale/tailscale:v1.96.5 → 1.96.5)
PINNED_TAG=$(grep -oP "(?<=dockerTag: ')[^']+" "$MANIFEST")
PINNED_VERSION="${PINNED_TAG#ghcr.io/tailscale/tailscale:v}"

if [[ -z "$PINNED_VERSION" ]]; then
  echo "ERROR: Could not parse pinned version from $MANIFEST" >&2
  exit 1
fi

# Obtain an anonymous bearer token for ghcr.io
TOKEN=$(curl -fsSL \
  "https://ghcr.io/token?scope=repository:${IMAGE}:pull&service=ghcr.io" \
  | jq -r '.token')

fetch_digest() {
  local tag="$1"
  curl -fsSI \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    "https://ghcr.io/v2/${IMAGE}/manifests/${tag}" \
    | grep -i '^docker-content-digest:' \
    | tr -d '[:space:]' \
    | cut -d: -f2-
}

STABLE_DIGEST=$(fetch_digest "stable")
PINNED_DIGEST=$(fetch_digest "v${PINNED_VERSION}")

if [[ "$STABLE_DIGEST" == "$PINNED_DIGEST" ]]; then
  echo "OK: ghcr.io/${IMAGE}:v${PINNED_VERSION} matches stable"
  exit 0
fi

# Resolve the human-readable version for the stable digest by listing tags
STABLE_VERSION=$(curl -fsSL \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://ghcr.io/v2/${IMAGE}/tags/list" \
  | jq -r --arg digest "$STABLE_DIGEST" '
      .tags[]
      | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
    ' \
  | while read -r tag; do
      d=$(fetch_digest "$tag")
      if [[ "$d" == "$STABLE_DIGEST" ]]; then
        echo "${tag#v}"
        break
      fi
    done)

STABLE_VERSION="${STABLE_VERSION:-unknown}"

cat >&2 <<EOF
ERROR: ghcr.io/${IMAGE}:stable has moved to a newer version.

  Pinned : v${PINNED_VERSION}
  Stable : v${STABLE_VERSION}

To upgrade  : run  scripts/bump-version.sh ${STABLE_VERSION}
To stay put : run  SKIP_VERSION_CHECK=1 make
EOF
exit 1
