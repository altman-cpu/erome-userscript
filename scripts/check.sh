#!/usr/bin/env bash
#
# Verification entry point for the erome userscript.
#
#   ./scripts/check.sh              # everything, independent steps in parallel
#   ./scripts/check.sh syntax       # parse-only checks
#   ./scripts/check.sh meta         # userscript metadata vs package.json
#   ./scripts/check.sh lint         # shell footguns in scripts/
#   ./scripts/check.sh test         # unit + DOM-stub test suite
#   ./scripts/check.sh hygiene      # repo smells (leftovers, huge files, secrets)
#
# Properties this script keeps on purpose:
#   * read-only: it never writes to the working tree, so it is safe to run
#     twice at once, or in four terminals simultaneously
#   * every step runs in its own bash process, so steps cannot leak state
#   * independent steps run concurrently (RUN_JOBS=1 to serialise)
#   * non-zero exit if any step fails, after allowing all of them to finish
#
# Dependencies: bash >= 4, coreutils, node >= 18.

set -Eeuo pipefail

SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
ROOT="$(cd -- "$(dirname -- "$SELF")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib.sh
source "$ROOT/scripts/lib.sh"

require_node() {
  require_cmd node
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" =~ ^[0-9]+$ ]] || die "cannot read the node version"
  ((major >= 18)) || die "node $major is too old; need >= 18"
}

step_syntax() {
  local -a files=()
  mapfile -t files < <(printf '%s\n' erome.user.js && find test -maxdepth 1 -name '*.test.js' -type f | sort)
  ((${#files[@]} > 0)) || die "no JavaScript files found"
  local file
  for file in "${files[@]}"; do
    node --check "$file" || die "syntax error in $file"
  done
  ok "all JavaScript parses (${#files[@]} files)"
}

step_meta() {
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

step_lint() {
  bash "$ROOT/scripts/lint-shell.sh"
}

step_tests() {
  local -a files=()
  mapfile -t files < <(find test -maxdepth 1 -name '*.test.js' -type f | sort)
  ((${#files[@]} > 0)) || die "no test files found"
  node --test "${files[@]}"
}

step_hygiene() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files --error-unmatch erome.user.js >/dev/null 2>&1 \
      || warn "erome.user.js is not tracked yet"

    # Refuse to commit anything that looks like a credential.
    if git grep -nIE '(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'']{8,}' \
      -- '*.js' '*.json' '*.md' '*.sh' >/dev/null 2>&1; then
      die "possible credential committed"
    fi

    local tracked size
    while IFS= read -r tracked; do
      [[ -n "$tracked" ]] || continue
      [[ -f "$tracked" ]] || continue
      size="$(wc -c <"$tracked")"
      ((size < 1048576)) || die "$tracked is ${size} bytes; keep large files out of git"
    done < <(git ls-files)
  fi

  # The userscript must stay a single self-contained file.
  local lines
  lines="$(wc -l <erome.user.js)"
  ((lines < 2000)) || die "erome.user.js grew to ${lines} lines; split it up"
  ok "repository hygiene (erome.user.js: ${lines} lines)"
}

usage() {
  cat <<'USAGE'
Usage: scripts/check.sh [STEP]

  all       run every step (default), independent steps in parallel
  syntax    parse the userscript and every test file
  meta      userscript metadata against package.json
  lint      shell footguns in scripts/ (word splitting, rm, pipefail)
  test      unit and DOM-stub tests
  hygiene   tracked-file smells

Environment:
  RUN_JOBS  parallel step limit for `all` (default 4, 1 = serial)
USAGE
}

run_one() {
  case "$1" in
    syntax) step_syntax ;;
    meta) step_meta ;;
    lint) step_lint ;;
    test) step_tests ;;
    hygiene) step_hygiene ;;
    *) usage; die "unknown step: $1" ;;
  esac
}

run_all() {
  local -a names=()
  local step_name command
  for step_name in syntax meta lint test; do
    names+=("$step_name")
    # Each step re-enters this script, so nothing is shared between them.
    command="$(printf 'CHECK_QUIET=1 %q %q %q' "$BASH" "$SELF" "$step_name")"
    names+=("$command")
  done

  # Independent and read-only: they can overlap without touching each other.
  if ! run_parallel "${names[@]}"; then
    die "one or more steps failed"
  fi

  # Hygiene inspects git state, which is cheap and quicker to read alone.
  step_hygiene
}

main() {
  case "${1:-all}" in
    -h|--help|help) usage; return 0 ;;
    --self) usage; return 0 ;;
  esac

  require_node

  case "${1:-all}" in
    all) run_all ;;
    syntax|meta|lint|test|hygiene) run_one "$1" ;;
    *) usage; die "unknown step: $1" ;;
  esac

  [[ "${CHECK_QUIET:-0}" == "1" ]] \
    || printf '%sall checks passed%s (%s)\n' "$GREEN$BOLD" "$OFF" "${1:-all}"
}

main "$@"
