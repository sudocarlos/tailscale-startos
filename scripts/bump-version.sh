#!/usr/bin/env bash
# bump-version.sh — Upgrade the package to a new Tailscale release.
# Usage: scripts/bump-version.sh <X.Y.Z>
set -euo pipefail

MANIFEST="startos/manifest/index.ts"
VERSIONS_DIR="startos/versions"
VERSIONS_INDEX="${VERSIONS_DIR}/index.ts"
IMAGE="tailscale/tailscale"

# ── Argument validation ───────────────────────────────────────────────────────
NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <X.Y.Z>" >&2
  exit 1
fi
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: Version must match X.Y.Z format (got: '$NEW_VERSION')" >&2
  exit 1
fi

# ── Verify image exists on ghcr.io ───────────────────────────────────────────
TOKEN=$(curl -fsSL \
  "https://ghcr.io/token?scope=repository:${IMAGE}:pull&service=ghcr.io" \
  | jq -r '.token')

HTTP_STATUS=$(curl -o /dev/null -w "%{http_code}" -fsSI \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  "https://ghcr.io/v2/${IMAGE}/manifests/v${NEW_VERSION}" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "ERROR: ghcr.io/${IMAGE}:v${NEW_VERSION} not found (HTTP ${HTTP_STATUS})." >&2
  echo "       Check that the version tag exists on ghcr.io." >&2
  exit 1
fi

# ── Check current pinned version ─────────────────────────────────────────────
PINNED_TAG=$(grep -oP "(?<=dockerTag: ')[^']+" "$MANIFEST")
CURRENT_VERSION="${PINNED_TAG#ghcr.io/tailscale/tailscale:v}"

if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
  echo "Already at v${NEW_VERSION} — nothing to do."
  exit 0
fi

# ── Derive variable names ─────────────────────────────────────────────────────
var_name() {
  local v="$1"
  echo "v_$(echo "$v" | tr '.' '_')_0"
}

NEW_VAR=$(var_name "$NEW_VERSION")
OLD_VAR=$(var_name "$CURRENT_VERSION")

# ── Create new version file ───────────────────────────────────────────────────
NEW_FILE="${VERSIONS_DIR}/v${NEW_VERSION}.0.ts"
cat > "$NEW_FILE" <<TSEOF
import { VersionInfo } from '@start9labs/start-sdk'

export const ${NEW_VAR} = VersionInfo.of({
  version: '${NEW_VERSION}:0',
  releaseNotes: {
    en_US: 'Upstream release — update this before publishing.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: async ({ effects }) => {},
  },
})
TSEOF

# ── Update manifest: replace dockerTag ───────────────────────────────────────
sed -i "s|ghcr.io/tailscale/tailscale:v${CURRENT_VERSION}|ghcr.io/tailscale/tailscale:v${NEW_VERSION}|g" "$MANIFEST"

# ── Update versions/index.ts ─────────────────────────────────────────────────
# Build the new index file programmatically to avoid fragile multi-line sed
python3 - "$VERSIONS_INDEX" "$NEW_VERSION" "$NEW_VAR" "$CURRENT_VERSION" "$OLD_VAR" <<'PYEOF'
import sys, re

index_file, new_ver, new_var, old_ver, old_var = sys.argv[1:]

with open(index_file) as f:
    content = f.read()

# Collect existing imports (lines starting with "import")
lines = content.splitlines()
import_lines = [l for l in lines if l.startswith("import")]

# Parse existing `other` array entries (variable names inside brackets)
other_match = re.search(r'other:\s*\[([^\]]*)\]', content, re.DOTALL)
existing_others = []
if other_match:
    raw = other_match.group(1)
    existing_others = [t.strip() for t in raw.split(',') if t.strip()]

# Add the old current to others if not already present
if old_var not in existing_others:
    existing_others.append(old_var)

# Remove new_var from others if it crept in
existing_others = [o for o in existing_others if o != new_var]

# Gather all version files to derive all needed imports
import_map = {}
for line in import_lines:
    m = re.search(r"import \{ (\w+) \} from '([^']+)'", line)
    if m:
        import_map[m.group(1)] = m.group(2)

# Ensure new var import exists
if new_var not in import_map:
    import_map[new_var] = f'./{new_ver}.0'
# Ensure old var import exists
if old_var not in import_map:
    import_map[old_var] = f'./{old_ver}.0'

# Build output
out_lines = ["import { VersionGraph } from '@start9labs/start-sdk'"]
for var, path in sorted(import_map.items(), key=lambda x: x[1]):
    if var != 'VersionGraph':
        out_lines.append(f"import {{ {var} }} from '{path}'")

others_str = ', '.join(existing_others) if existing_others else ''
out_lines.append('')
out_lines.append('export const versionGraph = VersionGraph.of({')
out_lines.append(f'  current: {new_var},')
out_lines.append(f'  other: [{others_str}],')
out_lines.append('})')
out_lines.append('')

with open(index_file, 'w') as f:
    f.write('\n'.join(out_lines))

print("Updated", index_file)
PYEOF

# ── Print checklist ───────────────────────────────────────────────────────────
cat <<EOF

Bumped to v${NEW_VERSION}.

Next steps:
  1. Edit ${NEW_FILE}  — update release notes
  2. Edit README.md                     — update version references
  3. Run: make                          — to verify the build
  4. Commit: feat: bump tailscale to v${NEW_VERSION}
EOF
