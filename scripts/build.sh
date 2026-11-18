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
echo "build: $(cd lib && ls | tr '\n' ' ')"
