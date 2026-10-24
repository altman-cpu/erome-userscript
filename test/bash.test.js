'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'scripts', 'lib.sh');
const LINT = path.join(ROOT, 'scripts', 'lint-shell.sh');
const CHECK = path.join(ROOT, 'scripts', 'check.sh');

function bash(script, options = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 60000,
    env: Object.assign({}, process.env, options.env || {}),
  });
}

/** Sources lib.sh, enables strict mode, then runs the snippet. */
function withLib(snippet, options = {}) {
  return bash(`source ${JSON.stringify(LIB)}\nstrict_mode\n${snippet}`, options);
}

function tempDir(prefix = 'erome-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ *
 * safe_rm: refuses everything ambiguous
 * ------------------------------------------------------------------ */

const REFUSALS = [
  ['no arguments', 'safe_rm', /no targets/],
  ['empty string', 'safe_rm ""', /empty path/],
  ['root', 'safe_rm /', /refusing to remove/],
  ['dot', 'safe_rm .', /refusing to remove/],
  ['dotdot', 'safe_rm ..', /refusing to remove/],
  ['tilde', 'safe_rm "~"', /refusing to remove/],
  ['home', 'safe_rm "$HOME"', /refusing to remove/],
  ['relative path', 'safe_rm build/output', /relative path/],
  ['glob', 'safe_rm "/tmp/erome-*"', /glob/],
  ['unexpanded variable', 'safe_rm \'/tmp/$NOT_SET\'', /unexpanded variable/],
  ['outside allowed root', 'safe_rm "/etc/hosts"', /outside allowed root/],
];

for (const [label, snippet, message] of REFUSALS) {
  test(`safe_rm refuses ${label}`, () => {
    const result = withLib(snippet);
    assert.equal(result.status, 1, `${snippet} should fail`);
    assert.match(result.stderr, message);
  });
}

test('safe_rm refuses the allowed root itself even when explicitly passed', () => {
  const dir = tempDir();
  try {
    const result = bash(`source ${JSON.stringify(LIB)}; strict_mode; safe_rm --root "${dir}" "${dir}"`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the allowed root itself/);
    assert.equal(fs.existsSync(dir), true, 'the root must survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safe_rm removes a directory inside the root and leaves siblings alone', () => {
  const root = tempDir();
  const target = path.join(root, 'work');
  const sibling = path.join(root, 'keep');
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(target, 'nested', 'file.txt'), 'x');
  fs.mkdirSync(sibling);

  const result = bash(`source ${JSON.stringify(LIB)}; strict_mode; safe_rm --root "${root}" "${target}"`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(sibling), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('safe_rm accepts an unset variable as an empty target, and refuses it', () => {
  const result = withLib('target="${SOME_UNSET_VAR:-}"; safe_rm "$target"');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty path/);
});

/* ------------------------------------------------------------------ *
 * run_parallel: really concurrent, always aggregates
 * ------------------------------------------------------------------ */

const SLEEP = 0.3;

test('run_parallel runs steps concurrently', () => {
  const started = process.hrtime.bigint();
  const result = withLib(
    `run_parallel a "sleep ${SLEEP}" b "sleep ${SLEEP}" c "sleep ${SLEEP}"`,
    { env: { RUN_JOBS: '3' } },
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.status, 0, result.stderr);
  // Three 0.3 s steps: ~0.3 s in parallel, ~0.9 s in series.
  assert.ok(elapsedMs < 750, `expected a concurrent run, took ${Math.round(elapsedMs)} ms`);
});

test('run_parallel honours RUN_JOBS=1', () => {
  const started = process.hrtime.bigint();
  const result = withLib(
    `run_parallel a "sleep ${SLEEP}" b "sleep ${SLEEP}" c "sleep ${SLEEP}"`,
    { env: { RUN_JOBS: '1' } },
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsedMs >= 750, `expected a serial run, took ${Math.round(elapsedMs)} ms`);
});

test('run_parallel reports failure but still finishes every step', () => {
  const result = withLib(
    'run_parallel ok1 "echo one" bad "echo boom; exit 3" ok2 "echo two"',
    { env: { RUN_JOBS: '2' } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fail .*bad \(exit 3\)/);
  assert.match(result.stdout, /one/);
  assert.match(result.stdout, /two/);
});

test('run_parallel keeps step output separated, not interleaved', () => {
  const result = withLib(
    'run_parallel a "printf \'a1\\na2\\n\'" b "printf \'b1\\nb2\\n\'"',
    { env: { RUN_JOBS: '2' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /a1\na2/);
  assert.match(result.stdout, /b1\nb2/);
});

test('run_parallel rejects an odd number of arguments', () => {
  const result = withLib('run_parallel only-a-name');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NAME COMMAND pairs/);
});

/* ------------------------------------------------------------------ *
 * lint-shell: the footguns are a build failure, not a promise
 * ------------------------------------------------------------------ */

test('lint-shell passes on this repository', () => {
  const result = bash(`bash ${JSON.stringify(LINT)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clean/);
});

const BAD_SCRIPTS = [
  ['missing strict mode', '#!/usr/bin/env bash\necho hi\n', /strict-mode/],
  ['set -e without pipefail', '#!/usr/bin/env bash\nset -e\nls | head\n', /does not fail a pipeline/],
  ['unquoted variable in for-in', '#!/usr/bin/env bash\nset -Eeuo pipefail\nfor f in $FILES; do echo "$f"; done\n', /word-splitting/],
  ['unquoted $@', '#!/usr/bin/env bash\nset -Eeuo pipefail\necho $@\n', /word-splitting/],
  ['rm -rf with a variable', '#!/usr/bin/env bash\nset -Eeuo pipefail\nrm -rf "$TARGET"\n', /exports to nothing|variable target/],
  ['rm on a variable without --', '#!/usr/bin/env bash\nset -Eeuo pipefail\nrm "$TARGET"\n', /use safe_rm|variable target/],
  ['backticks', '#!/usr/bin/env bash\nset -Eeuo pipefail\ndate=`date`\n', /backtick/],
  ['eval', '#!/usr/bin/env bash\nset -Eeuo pipefail\neval "$CMD"\n', /eval/],
];

for (const [label, content, message] of BAD_SCRIPTS) {
  test(`lint-shell flags ${label}`, () => {
    const dir = tempDir();
    const file = path.join(dir, 'bad.sh');
    fs.writeFileSync(file, content);
    try {
      const result = bash(`bash ${JSON.stringify(LINT)} ${JSON.stringify(file)}`);
      assert.equal(result.status, 1, `expected ${label} to fail the lint`);
      assert.match(result.stderr, message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('lint-shell allows a literal rm that passes --', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ok.sh');
  fs.writeFileSync(file, '#!/usr/bin/env bash\nset -Eeuo pipefail\nrm -- build/output.txt\n');
  try {
    const result = bash(`bash ${JSON.stringify(LINT)} ${JSON.stringify(file)}`);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-shell ignores heredoc bodies and marked lines', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ok.sh');
  fs.writeFileSync(file, [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    "node - <<'NODE'",
    'const s = `template ${x}`;',
    'eval(s);',
    '$@ and $* and rm -rf $TARGET inside a heredoc',
    'NODE',
    'echo "safe" # lint-shell: ignore $@',
    '',
  ].join('\n'));
  try {
    const result = bash(`bash ${JSON.stringify(LINT)} ${JSON.stringify(file)}`);
    assert.equal(result.status, 0, `heredoc body must not be linted:\n${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-shell reports line numbers', () => {
  const dir = tempDir();
  const file = path.join(dir, 'bad.sh');
  fs.writeFileSync(file, '#!/usr/bin/env bash\nset -Eeuo pipefail\n\neval "$X"\n');
  try {
    const result = bash(`bash ${JSON.stringify(LINT)} ${JSON.stringify(file)}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:4: eval`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * check.sh: idempotent, read-only, safe to run many times at once
 * ------------------------------------------------------------------ */

const STEPS = ['syntax', 'meta', 'lint'];

for (const step of STEPS) {
  test(`check.sh ${step} passes`, () => {
    const result = bash(`bash ${JSON.stringify(CHECK)} ${step}`);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('check.sh is idempotent', () => {
  const first = bash(`bash ${JSON.stringify(CHECK)} syntax`);
  const second = bash(`bash ${JSON.stringify(CHECK)} syntax`);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, 'repeat runs must produce identical output');
});

test('check.sh rejects an unknown step', () => {
  const result = bash(`bash ${JSON.stringify(CHECK)} nonsense`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown step/);
});

test('check.sh leaves the working tree untouched, even run four times at once', async () => {
  const before = bash('git status --porcelain').stdout;
  const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const child = spawn('bash', [CHECK, 'syntax'], { cwd: ROOT, stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
  })));
  assert.deepEqual(runs, [0, 0, 0, 0], 'concurrent gates must all succeed');
  const after = bash('git status --porcelain').stdout;
  assert.equal(before, after, 'the gate must not write to the tree');
});

test('check.sh fails when the metadata version drifts', () => {
  // Work on a copy so the real tree is never modified.
  const dir = tempDir();
  for (const entry of ['erome.user.js', 'package.json', 'scripts', 'test']) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = '9.9.9';
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const result = bash(`bash ${JSON.stringify(path.join(dir, 'scripts', 'check.sh'))} meta`, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /9\.9\.9/);
  fs.rmSync(dir, { recursive: true, force: true });
});
