import { useEffect, useRef, useState } from 'react';

const PROMPT = 'operator@autonomy:~$';
const MAX_LINES = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatResult(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const lines = String(text).split('\n');
  if (lines.length > 14) {
    return lines.slice(0, 14).concat(`… (+${lines.length - 14} more lines)`);
  }
  return lines;
}

export default function Terminal({ api, cps, paused, speak }) {
  const [lines, setLines] = useState([
    { kind: 'sys', text: 'autonomy console booting…' },
  ]);
  const [typed, setTyped] = useState('');
  const [input, setInput] = useState('');

  const cpsRef = useRef(cps);
  const pausedRef = useRef(paused);
  const speakRef = useRef(speak);
  const queueRef = useRef([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const narratedRef = useRef(0);

  cpsRef.current = cps;
  pausedRef.current = paused;
  speakRef.current = speak;

  const pushLines = (items) => {
    setLines((prev) => {
      const next = prev.concat(items);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  };

  // The non-stop autonomous loop. Runs forever; pausing only suspends it.
  useEffect(() => {
    let alive = true;

    const waitWhilePaused = async () => {
      while (alive && pausedRef.current) await sleep(150);
    };

    const narrate = (text) => {
      // narrate every second command to keep the voice track readable
      narratedRef.current += 1;
      if (narratedRef.current % 2 === 0) speakRef.current?.(text);
    };

    (async () => {
      await sleep(350);
      if (!alive) return;
      pushLines([
        {
          kind: 'sys',
          text: `${api.pool.size} workers attached · ${api.listTasks().length} tasks registered · autonomous loop engaged`,
        },
        { kind: 'sys', text: 'type below to inject your own commands into the queue' },
      ]);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!alive) return;
        await waitWhilePaused();
        if (!alive) return;

        const line = queueRef.current.shift() || api.nextAutoCommand();

        // typewriter phase
        for (let i = 1; i <= line.length; i++) {
          if (!alive) return;
          if (pausedRef.current) await waitWhilePaused();
          setTyped(line.slice(0, i));
          await sleep(1000 / Math.max(2, cpsRef.current) + Math.random() * 28);
        }
        setTyped('');
        pushLines([{ kind: 'cmd', text: line }]);

        // execution phase
        try {
          const out = await api.runLine(line);
          const where = out.workerId >= 0 ? ` · worker ${out.workerId}` : ' · main';
          pushLines([
            { kind: 'out', text: `✔ ${out.name} · ${out.ms}ms${where}` },
            ...formatResult(out.result).map((text) => ({ kind: 'data', text })),
          ]);
          narrate(`ran ${out.name}, done in ${out.ms} milliseconds`);
        } catch (err) {
          pushLines([{ kind: 'err', text: `✖ ${err.message}` }]);
          speakRef.current?.(`task failed: ${err.message}`);
        }

        await sleep(300 + Math.random() * 500);
      }
    })();

    return () => {
      alive = false;
    };
  }, [api]);

  // keep the viewport pinned to the newest output
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, typed]);

  const submit = () => {
    const value = input.trim();
    if (!value) return;
    queueRef.current.push(value);
    api.log('user', `queued "${value}"`);
    setInput('');
  };

  return (
    <section className="panel terminal-panel">
      <header className="panel-head">
        <span className="panel-title">TERMINAL — NON-STOP AUTONOMOUS TYPING</span>
        <span className={`badge ${paused ? 'badge-paused' : 'badge-live'}`}>
          {paused ? '⏸ PAUSED' : '● AUTONOMOUS'}
        </span>
      </header>

      <div className="terminal-body" ref={scrollRef}>
        {lines.map((line, index) => (
          <div key={index} className={`tline tline-${line.kind}`}>
            {line.kind === 'cmd' ? (
              <>
                <span className="tprompt">{PROMPT}</span> {line.text}
              </>
            ) : (
              line.text
            )}
          </div>
        ))}
        <div className="tline tline-typing">
          <span className="tprompt">{PROMPT}</span> {typed}
          <span className="cursor">▊</span>
        </div>
      </div>

      <div className="terminal-input-row">
        <span className="tprompt">{PROMPT}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          placeholder="inject a command (e.g. scan sectors=20)…"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </section>
  );
}
