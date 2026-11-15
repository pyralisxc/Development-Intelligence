#!/bin/sh
# 0 = skip deploy; 1 = build. Missing Git history must build, not fail.
previous=${VERCEL_GIT_PREVIOUS_SHA:-}
current=${VERCEL_GIT_COMMIT_SHA:-}
if [ -z "$previous" ] || [ "$previous" = "$current" ]; then
  exit 1
fi
if ! git cat-file -e "$previous^{commit}" 2>/dev/null \
  || ! git cat-file -e "$current^{commit}" 2>/dev/null; then
  exit 1
fi
git diff --quiet "$previous" "$current" -- \
  src package.json package-lock.json tsconfig.json tsconfig.runtime.json \
  Dockerfile.vercel vercel.json .dockerignore scripts/vercel-ignore-command.sh
if [ "$?" -eq 0 ]; then exit 0; fi
exit 1
