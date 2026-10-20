#!/bin/sh
# Installs lefthook git hooks. No-op in CI or when there is no .git directory.
[ -n "$CI" ] && exit 0
[ -e .git ] || exit 0
exec bunx lefthook install
