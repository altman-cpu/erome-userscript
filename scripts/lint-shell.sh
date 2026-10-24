#!/usr/bin/env bash
#
# Static checks for the bash scripts in this repository.
#
# Catches, by line number, the classic shell footguns that `set -euo pipefail`
# does not cover on its own:
#
#   - unquoted expansions that split into extra words
#   - rm with a variable target that could be empty, or without `--`
#   - set -e without pipefail (a failing command in a pipeline goes unnoticed)
#   - backticks, eval, and other primitives that hide failures
#
# Heredoc bodies (embedded JS, awk, usage text) are blanked before analysis, so
# only real shell code is judged. A line carrying `# lint-shell: ignore` is
# skipped deliberately.
#
# Usage: scripts/lint-shell.sh [FILE...]   (default: scripts/*.sh)

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0
files=()

report() {
  printf '%s:%s: %s: %s\n' "$1" "$2" "$3" "$4" >&2
  failures=$((failures + 1))
}

if (($#)); then
  files=("$@")
else
  for candidate in scripts/*.sh; do
    [[ -e "$candidate" ]] && files+=("$candidate")
  done
fi

((${#files[@]} > 0)) || { echo "lint-shell: no files to check" >&2; exit 0; }

workdir="$(mktemp -d "${TMPDIR:-/tmp}/erome-lint.XXXXXX")"
trap 'rm -rf -- "$workdir"' EXIT

cat >"$workdir/blank-heredocs.awk" <<'AWK'
# Blank the inside of heredocs (and their delimiters) while keeping line
# numbering intact, so embedded JS/awk/usage text is never linted as shell.
{
  if (in_heredoc) {
    if ($0 ~ ("^" delimiter "$")) {
      in_heredoc = 0
    }
    print ""
    next
  }
  if (match($0, /<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*/)) {
    token = substr($0, RSTART, RLENGTH)
    sub(/<<-?[[:space:]]*/, "", token)
    gsub(/['"'"'"]/, "", token)
    delimiter = token
    heredoc_start = 1
  }
  print $0
}
AWK

# A heredoc is only "open" after the line that declares it; the next lines are
# body. Track that with a second pass so the declaring line itself is checked.
cat >"$workdir/clean.awk" <<'AWK'
BEGIN { pending = "" }
{
  if (pending != "") {
    if ($0 ~ ("^" pending "$")) {
      pending = ""
    }
    print ""
    next
  }
  if (match($0, /<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*/)) {
    token = substr($0, RSTART, RLENGTH)
    sub(/<<-?[[:space:]]*/, "", token)
    gsub(/['"'"'"]/, "", token)
    pending = token
    print $0
    next
  }
  print $0
}
AWK

check_file() {
  local file="$1"
  local clean="$workdir/cleaned.sh"
  local hit lineno

  awk -f "$workdir/clean.awk" -- "$file" >"$clean"

  # 1. Shebang and strict mode.
  head -n 1 -- "$file" | grep -qE '^#!.*\bbash\b' \
    || report "$file" 1 "shebang" "expected a bash shebang"
  if ! grep -qE '^[[:space:]]*set -[A-Za-z]*e[A-Za-z]*uo?[[:space:]]+pipefail' -- "$clean"; then
    report "$file" 1 "strict-mode" "missing 'set -Eeuo pipefail'"
  fi
  if grep -qE '^[[:space:]]*set -e[[:space:]]*$' -- "$clean"; then
    report "$file" "$(grep -nE '^[[:space:]]*set -e[[:space:]]*$' -- "$clean" | head -n1 | cut -d: -f1)" \
      "strict-mode" "'set -e' alone does not fail a pipeline; add pipefail"
  fi

  # 2. rm must be guarded: either safe_rm, or an explicit `rm -- <literal>`.
  while IFS= read -r hit; do
    lineno="${hit%%:*}"
    if ! grep -qE 'rm[[:space:]]+(-[A-Za-z]+[[:space:]]+)*--[[:space:]]' <<<"$hit"; then
      report "$file" "$lineno" "rm" "use safe_rm, or 'rm -- <checked path>'"
    fi
  done < <(grep -nE '(^|[;&|(]|[[:space:]])rm[[:space:]]' -- "$clean" \
    | grep -vE 'safe_rm|^[0-9]+:[[:space:]]*#|lint-shell: ignore' || true)

  while IFS= read -r hit; do
    report "$file" "${hit%%:*}" "rm-empty" "rm with a variable target can expand to nothing"
  done < <(grep -nE 'rm[[:space:]]+(-[A-Za-z]+[[:space:]]+)*("?\$)' -- "$clean" \
    | grep -vE 'safe_rm|--[[:space:]]' \
    | grep -vE '^[0-9]+:[[:space:]]*#|lint-shell: ignore' || true)

  # 3. Unquoted expansions in word lists.
  while IFS= read -r hit; do
    report "$file" "${hit%%:*}" "word-splitting" "unquoted variable in 'for ... in' splits into extra words"
  done < <(grep -nE '(^|[[:space:]])for[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+in[^"'"'"']*\$[A-Za-z_{(]' -- "$clean" \
    | grep -vE '^[0-9]+:[[:space:]]*#|lint-shell: ignore' || true)

  while IFS= read -r hit; do
    report "$file" "${hit%%:*}" "word-splitting" "unquoted \$@/\$* loses argument boundaries"
  done < <(grep -nE '(^|[^"'"'"'\\[:alnum:]_])\$[@*]([^"'"'"']|$)' -- "$clean" \
    | grep -vE '^[0-9]+:[[:space:]]*#|lint-shell: ignore' || true)

  # 4. Primitives that hide failures.
  while IFS= read -r hit; do
    report "$file" "${hit%%:*}" "backtick" "use \$(...) instead of backticks"
  done < <(grep -nE '`' -- "$clean" | grep -vE '^[0-9]+:[[:space:]]*#|lint-shell: ignore' || true)

  while IFS= read -r hit; do
    report "$file" "${hit%%:*}" "eval" "eval invents syntax at runtime; all checks are defeated"
  done < <(grep -nE '(^|[[:space:]])eval[[:space:]]' -- "$clean" \
    | grep -vE '^[0-9]+:[[:space:]]*#|lint-shell: ignore' || true)
}

for file in "${files[@]}"; do
  [[ -f "$file" ]] || { echo "lint-shell: not a file: $file" >&2; exit 1; }
  check_file "$file"
done

if ((failures > 0)); then
  printf 'lint-shell: %d problem(s)\n' "$failures" >&2
  exit 1
fi

printf 'lint-shell: %d file(s) clean\n' "${#files[@]}"
