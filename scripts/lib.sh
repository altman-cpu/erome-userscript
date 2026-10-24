#!/usr/bin/env bash
# shellcheck shell=bash
#
# Hardened helpers shared by the scripts in this directory.
#
# Sourced, never executed. The caller owns the shell options; `strict_mode`
# turns on the safe set. Everything here is read-only except `safe_rm`, which
# refuses to run unless the target is an absolute path inside an allowed root
# and free of globs or unexpanded variables.

strict_mode() {
  set -Eeuo pipefail
  IFS=$'\n\t'
}

if [[ -t 1 ]]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; OFF=''
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$1"; }
ok()   { printf '%s ok %s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s warn %s %s\n' "$YELLOW" "$OFF" "$1"; }
info() { printf '%s\n' "$1"; }
die()  { printf '%s fail %s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

require_cmd() {
  local name
  for name in "$@"; do
    command -v "$name" >/dev/null 2>&1 || die "$name is not on PATH"
  done
}

# Absolute path of the repository root, derived from this file.
repo_root() {
  local here
  here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "$(cd -- "$here/.." && pwd)"
}

# Removes a directory tree, but only one it is allowed to remove.
#
#   safe_rm [--root DIR] [-] PATH...
#
# Refuses: no arguments, empty string, /, ., .., ~, $HOME, relative paths,
# anything containing a glob character or an unexpanded variable, the allowed
# root itself, and anything outside the allowed root (default: $SAFE_RM_ROOT,
# else $TMPDIR, else /tmp). Always passes `--` to rm so a leading dash in a
# path can never be read as an option.
safe_rm() {
  local root="${SAFE_RM_ROOT:-${TMPDIR:-/tmp}}"
  local -a targets=()
  while (($#)); do
    case "$1" in
      --root)
        (($# >= 2)) || die "safe_rm: --root needs a value"
        root="$2"
        shift 2
        ;;
      --)
        shift
        while (($#)); do
          targets+=("$1")
          shift
        done
        ;;
      -*)
        die "safe_rm: unknown option: $1"
        ;;
      *)
        targets+=("$1")
        shift
        ;;
    esac
  done

  ((${#targets[@]} > 0)) || die "safe_rm: refusing to run with no targets"

  local resolved_root
  resolved_root="$(realpath -m -- "$root")" || die "safe_rm: invalid root: $root"
  [[ "$resolved_root" != "/" ]] || die "safe_rm: refusing to use / as an allowed root"

  local target resolved
  for target in "${targets[@]}"; do
    [[ -n "$target" ]] || die "safe_rm: refusing an empty path"
    [[ "$target" != *'*'* && "$target" != *'?'* && "$target" != *'['* ]] \
      || die "safe_rm: refusing a glob: $target"
    [[ "$target" != *'$'* ]] || die "safe_rm: refusing an unexpanded variable: $target"
    case "$target" in
      /|.|..|'~'|"$HOME") die "safe_rm: refusing to remove '$target'" ;;
    esac
    [[ "$target" == /* ]] || die "safe_rm: refusing a relative path: $target"

    resolved="$(realpath -m -- "$target")" || die "safe_rm: cannot resolve: $target"
    [[ "$resolved" != "$resolved_root" ]] \
      || die "safe_rm: refusing to remove the allowed root itself: $resolved"
    [[ "$resolved" == "$resolved_root"/* ]] \
      || die "safe_rm: outside allowed root ($resolved_root): $resolved"

    rm -rf -- "$resolved"
  done
}

# A temporary directory that is removed on exit, even after a failure.
mktemp_dir() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/erome-check.XXXXXX")"
  # Expand now: `dir` is local and gone by the time EXIT fires.
  trap "safe_rm $(printf '%q' "$dir")" EXIT
  printf '%s\n' "$dir"
}

# Runs independent steps concurrently and waits for every one of them.
#
#   run_parallel NAME COMMAND [NAME COMMAND]...
#
# Each COMMAND runs in its own bash process, so steps cannot leak variables or
# options into each other. Output is buffered per step and printed in argument
# order once everything has finished, which keeps logs readable and diff-able.
# Returns non-zero if any step failed; every step is always allowed to finish.
run_parallel() {
  (($#)) || return 0
  (($# % 2 == 0)) || die "run_parallel: expected NAME COMMAND pairs"

  local jobs="${RUN_JOBS:-4}"
  [[ "$jobs" =~ ^[0-9]+$ ]] && ((jobs > 0)) || die "run_parallel: bad RUN_JOBS: $jobs"

  local -a names=() commands=()
  while (($#)); do
    names+=("$1")
    commands+=("$2")
    shift 2
  done

  local workdir
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/erome-parallel.XXXXXX")"

  local next=0
  local completed=0
  local stalled=0

  # `jobs` is not usable inside $(...) (a subshell has no job table), so progress
  # is counted from the status files each child writes when it exits.
  count_completed() {
    local found=0 entry
    for entry in "$workdir"/*.status; do
      [[ -e "$entry" ]] && found=$((found + 1))
    done
    printf '%s' "$found"
  }

  while ((completed < ${#commands[@]})); do
    while (((next < ${#commands[@]})) && ((next - completed < jobs))); do
      (
        # The child runs with errexit off so its exit code can be recorded.
        set +e
        bash -c "${commands[next]}" >"$workdir/$next.out" 2>&1
        printf '%s' "$?" >"$workdir/$next.status"
      ) &
      next=$((next + 1))
    done

    wait -n 2>/dev/null || true
    local previous="$completed"
    completed="$(count_completed)"
    if ((completed == previous)); then
      stalled=$((stalled + 1))
      # A child that died without recording a status must not hang the gate.
      if ((stalled >= 3)); then
        warn "run_parallel: a step exited without a status; continuing"
        break
      fi
    else
      stalled=0
    fi
  done
  wait 2>/dev/null || true

  local failed=0
  local index status
  for index in "${!names[@]}"; do
    step "${names[index]}"
    if [[ -f "$workdir/$index.out" ]]; then
      cat -- "$workdir/$index.out"
    fi
    status="$(cat -- "$workdir/$index.status" 2>/dev/null || printf '1')"
    status="${status//[^0-9]/}"
    [[ -n "$status" ]] || status=1
    if ((status == 0)); then
      ok "${names[index]}"
    else
      failed=1
      printf '%s fail %s %s (exit %s)\n' "$RED" "$OFF" "${names[index]}" "$status" >&2
    fi
  done

  safe_rm "$workdir"
  return "$failed"
}
