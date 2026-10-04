/* Pool of automation workers.
 *
 * Owns N Web Workers, keeps a FIFO job queue, and assigns jobs to idle
 * workers. Emits events consumed by the UI and the automation API:
 *   onProgress({ taskId, workerId, pct, note })
 *   onResult({ taskId, workerId, ok, result, error, ms })
 *   onWorkerState(workerStates)
 */

let seq = 0;

export class WorkerPool {
  constructor({ size = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 6)) } = {}) {
    this.size = size;
    this.workers = [];
    this.pending = []; // queued {taskId, name, payload}
    this.byWorker = new Map(); // workerId -> current job taskId | null
    this.statsByWorker = new Array(size).fill(null).map((_, id) => ({
      id,
      busy: false,
      currentTask: null,
      completed: 0,
      failed: 0,
      pct: 0,
      note: '',
    }));
    this.pendingCallbacks = new Map(); // taskId -> {resolve}
    this.onProgress = null;
    this.onResult = null;
    this.onState = null;
    this.taskCounter = 0;
    this.completed = 0;
    this.failed = 0;
    this._shutdown = false;

    for (let id = 0; id < size; id++) {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event) => this._onMessage(id, event.data));
      this.workers.push(worker);
      this.byWorker.set(id, null);
    }
  }

  _emitState() {
    if (this.onState) this.onState(this.statsByWorker.map((s) => ({ ...s })));
  }

  _onMessage(workerId, msg) {
    if (!msg) return;
    const stats = this.statsByWorker[workerId];

    if (msg.type === 'progress') {
      stats.pct = msg.pct;
      stats.note = msg.note || '';
      if (this.onProgress) {
        this.onProgress({ taskId: msg.taskId, workerId, pct: msg.pct, note: msg.note });
      }
      this._emitState();
      return;
    }

    if (msg.type === 'result') {
      const done = this.byWorker.get(workerId);
      this.byWorker.set(workerId, null);
      stats.busy = false;
      stats.currentTask = null;
      stats.pct = 0;
      stats.note = '';
      if (msg.ok) stats.completed += 1;
      else stats.failed += 1;
      if (msg.ok) this.completed += 1;
      else this.failed += 1;
      this._emitState();

      if (this.onResult) {
        this.onResult({
          taskId: msg.taskId,
          workerId,
          ok: msg.ok,
          result: msg.result,
          error: msg.error,
          ms: msg.ms,
        });
      }
      const cb = this.pendingCallbacks.get(msg.taskId);
      if (cb) {
        this.pendingCallbacks.delete(msg.taskId);
        if (msg.ok) cb.resolve({ result: msg.result, ms: msg.ms, workerId });
        else cb.resolve(Promise.reject(new Error(msg.error)));
      }
      this._pump();
    }
  }

  _pump() {
    if (this._shutdown) return;
    while (this.pending.length > 0) {
      const idleId = [...this.byWorker.entries()].find(([, task]) => task === null)?.[0];
      if (idleId === undefined) return;
      const job = this.pending.shift();
      this.byWorker.set(idleId, job.taskId);
      const stats = this.statsByWorker[idleId];
      stats.busy = true;
      stats.currentTask = job.name;
      stats.pct = 0;
      stats.note = 'starting';
      this._emitState();
      this.workers[idleId].postMessage({
        type: 'run',
        taskId: job.taskId,
        name: job.name,
        payload: job.payload,
      });
    }
  }

  /** Install a task implementation into every worker. `source` is the body of
   *  (payload, ctx) => result. */
  register(name, source) {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'register', name, source });
    }
  }

  /** Queue a task run. Resolves with { result, ms, workerId } or rejects. */
  dispatch(name, payload = {}) {
    const taskId = `t${String(++this.taskCounter).padStart(4, '0')}`;
    return new Promise((resolve) => {
      this.pendingCallbacks.set(taskId, { resolve });
      this.pending.push({ taskId, name, payload });
      this._pump();
    });
  }

  snapshot() {
    return {
      size: this.size,
      queued: this.pending.length,
      completed: this.completed,
      failed: this.failed,
      workers: this.statsByWorker.map((s) => ({ ...s })),
    };
  }

  shutdown() {
    this._shutdown = true;
    this.pending = [];
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
