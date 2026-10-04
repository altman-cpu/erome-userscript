/* AutomationAPI — the built-in automation surface.
 *
 *   api.registerTask(name, fn, { description, thread })  install a task
 *   api.call(name, payload)                              run it (Promise)
 *   api.parse(line) / api.runLine(line)                  CLI surface
 *   api.listTasks() / api.stats()                        introspection
 *   api.on('log' | 'task', handler)                      event stream
 *   api.nextAutoCommand()                                autonomous mission plan
 *
 * Tasks with thread:'worker' have their source shipped into the Web Worker
 * pool; tasks with thread:'main' execute on the UI thread (they can touch
 * speechSynthesis, the DOM, or pool stats).
 */

import { WorkerPool } from './workerPool.js';

const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

export class AutomationAPI {
  constructor({ workerCount } = {}) {
    this.pool = new WorkerPool({ size: workerCount });
    this.tasks = new Map(); // name -> { description, thread, mainFn? }
    this.listeners = { log: new Set(), task: new Set() };
    this.history = []; // every executed command line
    this.commandsExecuted = 0;
    this.startedAt = Date.now();

    this.pool.onProgress = (p) => this._emit('task', { kind: 'progress', ...p });
    this.pool.onResult = (r) => this._emit('task', { kind: 'result', ...r });
    this.pool.onState = (workers) => this._emit('task', { kind: 'workers', workers });

    this._registerBuiltins();
  }

  _emit(channel, event) {
    for (const handler of this.listeners[channel]) handler(event);
  }

  log(level, message) {
    const entry = { ts: Date.now(), level, message };
    this._emit('log', entry);
    return entry;
  }

  on(channel, handler) {
    if (!this.listeners[channel]) return () => {};
    this.listeners[channel].add(handler);
    return () => this.listeners[channel].delete(handler);
  }

  registerTask(name, fn, { description = '', thread = 'worker' } = {}) {
    this.tasks.set(name, { name, description, thread, mainFn: fn });
    if (thread === 'worker') this.pool.register(name, fn.toString());
    this.log('sys', `task "${name}" registered (${thread})`);
  }

  async call(name, payload = {}) {
    const meta = this.tasks.get(name);
    if (!meta) throw new Error(`unknown task "${name}" — try "help"`);
    if (meta.thread === 'main') {
      const started = performance.now();
      const result = await meta.mainFn(payload);
      return { result, ms: Math.round(performance.now() - started), workerId: -1 };
    }
    return this.pool.dispatch(name, payload);
  }

  /** Parse a command line: `name k=v k2=v2 positional...` */
  parse(line) {
    const tokens = String(line).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const name = tokens[0].toLowerCase();
    const payload = { _args: [] };
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        const key = token.slice(0, eq);
        const raw = token.slice(eq + 1);
        const num = Number(raw);
        payload[key] = Number.isFinite(num) && raw.trim() !== '' ? num : raw;
      } else {
        payload._args.push(token);
      }
    }
    return { name, payload, raw: line.trim() };
  }

  /** Execute one CLI line end-to-end. Resolves { name, result, ms, workerId }. */
  async runLine(line) {
    const parsed = this.parse(line);
    if (!parsed) throw new Error('empty command');
    this.history.push(parsed.raw);
    this.commandsExecuted += 1;
    const out = await this.call(parsed.name, parsed.payload);
    return { name: parsed.name, ...out };
  }

  listTasks() {
    return [...this.tasks.values()].map(({ name, description, thread }) => ({
      name,
      description,
      thread,
    }));
  }

  stats() {
    return {
      uptimeMs: Date.now() - this.startedAt,
      commandsExecuted: this.commandsExecuted,
      tasksRegistered: this.tasks.size,
      pool: this.pool.snapshot(),
    };
  }

  /** Endless mission plan: the autonomous brain. Returns the next command line. */
  nextAutoCommand() {
    const plans = [
      () => 'ping',
      () => `hash text=mission-${rnd(1000, 9999)}`,
      () => `primes limit=${rnd(4, 40) * 25000}`,
      () => `fib n=${rnd(50, 400)}`,
      () => `matrix size=${rnd(8, 20) * 8}`,
      () => `uuid count=${rnd(8, 64)}`,
      () => `scan sectors=${rnd(6, 18)}`,
      () => 'stats',
      () => `speak text=all tasks nominal, workers reporting green`,
    ];
    const plan = plans[Math.floor(Math.random() * plans.length)];
    return plan();
  }

  _registerBuiltins() {
    this.registerTask('stats', () => this.stats(), {
      description: 'pool + API statistics',
      thread: 'main',
    });

    this.registerTask('help', () => this.listTasks(), {
      description: 'list every registered task',
      thread: 'main',
    });

    this.registerTask('speak', ({ text = 'automation online', _args = [] } = {}) => {
      const message = String(text || _args.join(' ') || 'automation online');
      if (this.onSpeak) this.onSpeak(message);
      return { spoken: message };
    }, {
      description: 'narrate text through the TTS engine',
      thread: 'main',
    });
  }

  shutdown() {
    this.pool.shutdown();
  }
}
