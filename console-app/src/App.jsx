import { useEffect, useRef, useState } from 'react';
import { AutomationAPI } from './automation/api.js';
import Terminal from './components/Terminal.jsx';
import ConsolePanel from './components/ConsolePanel.jsx';
import WorkerPanel from './components/WorkerPanel.jsx';
import { useTTS } from './hooks/useTTS.js';

const fmtUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export default function App() {
  const apiRef = useRef(null);
  if (!apiRef.current) apiRef.current = new AutomationAPI();
  const api = apiRef.current;

  const tts = useTTS();
  const ttsRef = useRef(tts);
  ttsRef.current = tts;

  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(22);
  const [stats, setStats] = useState(() => api.stats());

  useEffect(() => {
    // the `speak` task talks through whatever TTS state is current
    api.onSpeak = (message) => ttsRef.current.speak(message);
    window.automation = api; // scriptable from the browser console
    api.log('sys', 'automation API online — window.automation exposed');
    return () => api.shutdown();
  }, [api]);

  useEffect(() => {
    const timer = setInterval(() => setStats(api.stats()), 1000);
    return () => clearInterval(timer);
  }, [api]);

  const toggleTts = () => {
    if (tts.enabled) {
      tts.setEnabled(false);
      if (tts.supported) window.speechSynthesis.cancel();
      api.log('sys', 'TTS narration off');
    } else {
      tts.setEnabled(true);
      tts.speak('Voice online. Autonomous terminal narration enabled.', { force: true });
      api.log('sys', 'TTS narration on');
    }
  };

  const togglePause = () => {
    setPaused((current) => {
      const next = !current;
      api.log('user', next ? 'autonomous loop paused' : 'autonomous loop resumed');
      return next;
    });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`status-dot ${paused ? 'dot-paused' : 'dot-live'}`} />
          <h1>AUTONOMY CONSOLE</h1>
          <span className="brand-sub">non-stop terminal · automation API · worker pool · TTS</span>
        </div>

        <div className="topbar-stats">
          <span title="uptime">⏱ {fmtUptime(stats.uptimeMs)}</span>
          <span title="commands executed">⌨ {stats.commandsExecuted}</span>
          <span title="pool throughput">✔ {stats.pool.completed} ✖ {stats.pool.failed}</span>
          <span title="queued jobs">⧗ {stats.pool.queued}</span>
        </div>

        <div className="topbar-controls">
          <button className="btn" onClick={togglePause}>
            {paused ? '▶ RESUME' : '⏸ PAUSE'}
          </button>
          <label className="control">
            <span>type speed</span>
            <input
              type="range"
              min="4"
              max="80"
              value={cps}
              onChange={(event) => setCps(Number(event.target.value))}
            />
            <span className="control-value">{cps} cps</span>
          </label>

          <button className={`btn ${tts.enabled ? 'btn-active' : ''}`} onClick={toggleTts} disabled={!tts.supported}>
            {tts.supported ? (tts.enabled ? '🔊 VOICE ON' : '🔇 VOICE OFF') : 'TTS N/A'}
          </button>
          {tts.supported && (
            <>
              <select
                className="voice-select"
                value={tts.voiceURI}
                onChange={(event) => tts.setVoiceURI(event.target.value)}
              >
                {tts.voices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </option>
                ))}
              </select>
              <label className="control">
                <span>rate</span>
                <input
                  type="range"
                  min="0.6"
                  max="1.6"
                  step="0.05"
                  value={tts.rate}
                  onChange={(event) => tts.setRate(Number(event.target.value))}
                />
              </label>
            </>
          )}
        </div>
      </header>

      <main className="main-grid">
        <Terminal api={api} cps={cps} paused={paused} speak={(text) => tts.speak(text)} />
        <ConsolePanel api={api} />
      </main>

      <WorkerPanel api={api} />
    </div>
  );
}
