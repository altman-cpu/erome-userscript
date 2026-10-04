import { useEffect, useState } from 'react';

export default function WorkerPanel({ api }) {
  const [workers, setWorkers] = useState(api.pool.snapshot().workers);

  useEffect(() => {
    const off = api.on('task', (event) => {
      if (event.kind === 'workers') setWorkers(event.workers);
    });
    return off;
  }, [api]);

  return (
    <section className="panel worker-panel">
      <header className="panel-head">
        <span className="panel-title">WORKER POOL — PARALLEL AUTOMATION THREADS</span>
        <span className="badge badge-dim">{workers.length} workers</span>
      </header>
      <div className="worker-grid">
        {workers.map((worker) => (
          <div key={worker.id} className={`worker-card ${worker.busy ? 'busy' : ''}`}>
            <div className="worker-card-head">
              <span className="worker-id">W{worker.id}</span>
              <span className={worker.busy ? 'worker-state busy-text' : 'worker-state'}>
                {worker.busy ? `▶ ${worker.currentTask}` : 'idle'}
              </span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${worker.busy ? Math.max(4, worker.pct) : 0}%` }}
              />
            </div>
            <div className="worker-meta">
              <span>{worker.pct > 0 && worker.busy ? `${worker.pct}% ${worker.note}` : '—'}</span>
              <span>
                ✔ {worker.completed} · ✖ {worker.failed}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
