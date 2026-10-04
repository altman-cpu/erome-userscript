import { useEffect, useRef, useState } from 'react';

const MAX_ENTRIES = 300;

const fmtTime = (ts) => new Date(ts).toTimeString().slice(0, 8);

export default function ConsolePanel({ api }) {
  const [entries, setEntries] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    const add = (level, text, ts = Date.now()) => {
      setEntries((prev) => {
        const next = prev.concat([{ level, text, ts }]);
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    };

    const offLog = api.on('log', (entry) => add(entry.level, entry.message, entry.ts));
    const offTask = api.on('task', (event) => {
      if (event.kind === 'result') {
        add(
          event.ok ? 'ok' : 'error',
          `${event.ok ? '✔' : '✖'} ${event.taskId} ${event.ok ? 'complete' : `failed: ${event.error}`} · ${event.ms}ms · worker ${event.workerId}`,
        );
      }
    });
    return () => {
      offLog();
      offTask();
    };
  }, [api]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <section className="panel console-panel">
      <header className="panel-head">
        <span className="panel-title">CONSOLE — SYSTEM EVENT STREAM</span>
        <span className="badge badge-dim">{entries.length}</span>
      </header>
      <div className="console-body" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="cline cline-dim">waiting for events…</div>
        )}
        {entries.map((entry, index) => (
          <div key={index} className={`cline cline-${entry.level}`}>
            <span className="ctime">{fmtTime(entry.ts)}</span> {entry.text}
          </div>
        ))}
      </div>
    </section>
  );
}
