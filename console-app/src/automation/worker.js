/* Autonomy worker — runs automation tasks off the main thread.
 *
 * Protocol (all messages are JSON):
 *   ->  { type: 'register', name, source }          install a task implementation
 *   ->  { type: 'run', taskId, name, payload }      execute a task
 *   <-  { type: 'progress', taskId, pct, note }     mid-run progress (ctx.report)
 *   <-  { type: 'result', taskId, ok, result, ms }  finished
 *   <-  { type: 'hello', id }                        worker ready
 *
 * Task implementations are registered as function bodies:
 *   (payload, ctx) => any | Promise<any>
 * ctx.report(pct, note) streams progress back to the pool.
 */

const registry = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Iterative fast doubling, mod 1e9+7. Returns F(n) % MOD.
function fib(n) {
  const MOD = 1000000007n;
  let a = 0n; // F(0)
  let b = 1n; // F(1)
  for (const bit of BigInt(n).toString(2)) {
    const twoB = (2n * b) % MOD;
    const c = (a * ((twoB - a + MOD) % MOD)) % MOD; // F(2k)
    const d = (a * a + b * b) % MOD;                // F(2k+1)
    if (bit === '0') {
      a = c;
      b = d;
    } else {
      a = d;
      b = (c + d) % MOD;
    }
  }
  return a;
}

// Built-in task implementations (registered at boot below).
const builtins = {
  ping: async () => {
    const latency = 30 + Math.random() * 170;
    await sleep(latency);
    return { pong: true, latencyMs: Math.round(latency) };
  },

  hash: async ({ text = 'autonomy' } = {}) => {
    const data = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { sha256: hex, bytes: data.length };
  },

  primes: ({ limit = 100000 } = {}) => {
    const n = Math.min(Math.max(10, limit | 0), 5_000_000);
    const sieve = new Uint8Array(n + 1);
    let count = 0;
    for (let i = 2; i <= n; i++) {
      if (!sieve[i]) {
        count++;
        if ((i * i) <= n) {
          for (let j = i * i; j <= n; j += i) sieve[j] = 1;
        }
      }
    }
    return { limit: n, primeCount: count };
  },

  fib: ({ n = 72 } = {}) => {
    const k = Math.min(Math.max(1, n | 0), 500_000);
    return { n: k, fibMod1e9plus7: fib(k).toString() };
  },

  matrix: ({ size = 96 } = {}) => {
    const s = Math.min(Math.max(8, size | 0), 512);
    const A = new Float64Array(s * s);
    const B = new Float64Array(s * s);
    const C = new Float64Array(s * s);
    for (let i = 0; i < s * s; i++) {
      A[i] = Math.random();
      B[i] = Math.random();
    }
    for (let i = 0; i < s; i++) {
      for (let k = 0; k < s; k++) {
        const aik = A[i * s + k];
        for (let j = 0; j < s; j++) {
          C[i * s + j] += aik * B[k * s + j];
        }
      }
    }
    let checksum = 0;
    for (let i = 0; i < s; i++) checksum += C[i * s + i];
    return { size: s, ops: 2 * s * s * s, traceChecksum: Number(checksum.toFixed(4)) };
  },

  uuid: ({ count = 32 } = {}) => {
    const n = Math.min(Math.max(1, count | 0), 10_000);
    const ids = new Array(n);
    for (let i = 0; i < n; i++) ids[i] = crypto.randomUUID();
    return { generated: n, sample: ids.slice(0, 3) };
  },

  scan: async ({ sectors = 12 } = {}, ctx) => {
    const total = Math.min(Math.max(2, sectors | 0), 64);
    let found = 0;
    for (let i = 1; i <= total; i++) {
      await sleep(40 + Math.random() * 90);
      if (Math.random() < 0.3) found++;
      ctx.report(Math.round((i / total) * 100), `sector ${i}/${total}`);
    }
    return { sectors: total, hits: found };
  },
};

for (const [name, fn] of Object.entries(builtins)) {
  registry.set(name, fn);
}

self.postMessage({ type: 'hello' });

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'register') {
    try {
      // source is the body of: (payload, ctx) => result
      const fn = new Function('payload', 'ctx', `"use strict";\n${msg.source}`);
      registry.set(msg.name, fn);
      self.postMessage({ type: 'registered', name: msg.name, ok: true });
    } catch (err) {
      self.postMessage({ type: 'registered', name: msg.name, ok: false, error: String(err) });
    }
    return;
  }

  if (msg.type === 'run') {
    const started = performance.now();
    const fn = registry.get(msg.name);
    if (!fn) {
      self.postMessage({
        type: 'result',
        taskId: msg.taskId,
        ok: false,
        error: `unknown task "${msg.name}"`,
        ms: 0,
      });
      return;
    }
    const ctx = {
      report: (pct, note) =>
        self.postMessage({ type: 'progress', taskId: msg.taskId, pct, note }),
    };
    try {
      const result = await fn(msg.payload || {}, ctx);
      self.postMessage({
        type: 'result',
        taskId: msg.taskId,
        ok: true,
        result,
        ms: Math.round(performance.now() - started),
      });
    } catch (err) {
      self.postMessage({
        type: 'result',
        taskId: msg.taskId,
        ok: false,
        error: err && err.message ? err.message : String(err),
        ms: Math.round(performance.now() - started),
      });
    }
  }
};
