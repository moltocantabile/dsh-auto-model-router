#!/bin/bash
# Copy the dependency-free runtime sources into lib/.
# There is no TypeScript step: the plugin runs as plain ESM inside the host and
# deliberately imports no peer package (nothing to resolve from the profile).
# src/ files import each other by relative ESM path, so they must stay siblings
# of lib/: copying only some of them breaks the host import graph.
# client.js is the browser half; it is copied verbatim too.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf lib
mkdir -p lib
# Copy every source, not a hand-maintained list: a module added to src/ and
# forgotten here used to break the host import graph at load time, which is a
# dead plugin rather than a visible error.
for file in src/*.js; do cp "$file" "lib/$(basename "$file")"; done
cp src/model-info-data.json lib/model-info-data.json

# Stamp the browser half with the build time. A stale tab and a bundle that
# failed to register look identical from the outside; the page now names the
# bundle it is running, so "did my change land" is answerable without guessing.
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if grep -q '__AMR_BUILD_STAMP__' lib/client.js; then
  sed -i.bak "s/__AMR_BUILD_STAMP__/${STAMP}/" lib/client.js && rm -f lib/client.js.bak
fi
echo "build: $(cd lib && ls | tr '\n' ' ') | client stamp ${STAMP}"
