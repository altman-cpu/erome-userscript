#!/usr/bin/env bash
#
# Verification entry point for the erome userscript.
#
#   ./scripts/check.sh            # everything (default)
#   ./scripts/check.sh syntax     # parse-only checks
#   ./scripts/check.sh meta       # userscript metadata vs package.json
#   ./scripts/check.sh test       # unit + DOM-stub test suite
#   ./scripts/check.sh hygiene    # repo smells (leftovers, huge files, secrets)
#
# Exits non-zero on the first failure so it can gate a commit or CI run.
# No dependencies beyond bash, coreutils and node >= 18.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; OFF=''
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$1"; }
ok()   { printf '%s ok %s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s warn %s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '%s fail %s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

require_node() {
  command -v node >/dev/null 2>&1 || die "node is not on PATH (need >= 18)"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 18 )) || die "node $major is too old; need >= 18"
}

syntax() {
  step "syntax"
  local file
  for file in erome.user.js test/*.test.js; do
    node --check "$file"
  done
  ok "all JavaScript parses"
}

meta() {
  step "userscript metadata"
  node - <<'NODE'
const fs = require('node:fs');
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const script = fs.readFileSync('erome.user.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const block = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/.exec(script);
if (!block) fail('metadata block missing');

const field = (name) => {
  const match = new RegExp(`^// @${name}\\s+(.+)$`, 'm').exec(block[1]);
  return match ? match[1].trim() : null;
};

const version = field('version');
const required = ['name', 'namespace', 'version', 'description', 'match', 'grant'];
const missing = required.filter((name) => !field(name));
if (missing.length) fail(`missing metadata fields: ${missing.join(', ')}`);
if (version !== pkg.version) fail(`@version ${version} != package.json ${pkg.version}`);

const grants = [...block[1].matchAll(/^\/\/ @grant\s+(\S+)/gm)].map((m) => m[1]);
if (!grants.includes('GM.xmlHttpRequest')) fail('GM.xmlHttpRequest must be granted');

if (/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\()/.test(script)) {
  fail('script uses an HTML-injection or eval primitive');
}
if (!/'use strict';/.test(script)) fail("missing 'use strict'");

console.log(`version ${version}, grants: ${grants.join(', ')}`);
NODE
  ok "metadata consistent"
}

tests() {
  step "test suite"
  # shellcheck disable=SC2046
  node --test test/*.test.js
  ok "test suite"
}

hygiene() {
  step "hygiene"
  local status
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files --error-unmatch erome.user.js >/dev/null 2>&1 \
      || warn "erome.user.js is not tracked yet"

    # Refuse to commit anything that looks like a credential.
    if git grep -nIE '(api[_-]?key|secret|token|password)\s*[:=]\s*["'\''][^"'\'']{8,}' \
        -- '*.js' '*.json' '*.md' '*.sh' >/dev/null 2>&1; then
      die "possible credential committed"
    fi

    while IFS= read -r tracked; do
      [[ -n "$tracked" ]] || continue
      local size
      size=$(wc -c <"$tracked")
      (( size < 1048576 )) || die "$tracked is ${size} bytes; keep large files out of git"
    done < <(git ls-files)
  fi

  # The script must stay a single self-contained file.
  local lines
  lines=$(wc -l <erome.user.js)
  (( lines < 2000 )) || die "erome.user.js grew to ${lines} lines; split it up"
  ok "repository hygiene (erome.user.js: ${lines} lines)"
}

usage() {
  sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local target="${1:-all}"
  case "$target" in
    -h|--help|help) usage; return 0 ;;
  esac

  require_node

  case "$target" in
    all)     syntax; meta; tests; hygiene ;;
    syntax)  syntax ;;
    meta)    meta ;;
    test|tests) tests ;;
    hygiene) hygiene ;;
    *)       usage; die "unknown step: $target" ;;
  esac

  printf '%sall checks passed%s (%s)\n' "$GREEN$BOLD" "$OFF" "$target"
}

main "$@"
