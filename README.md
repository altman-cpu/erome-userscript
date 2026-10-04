# erome-userscript

Display the duration of each video above the video in erome.com albums

This program is dual licensed under:
*  The Unlicense
*  GPL-3.0-or-later

## console-app — Autonomy Console (React 18)

A self-driving operator dashboard that runs non-stop on its own:

* **Non-stop autonomous typing terminal** — types and executes commands by
  itself in an endless loop (typewriter effect, adjustable characters/sec,
  pause/resume). Type into the input row to inject your own commands into
  the queue; the terminal types them out and runs them.
* **Live console** — every API and worker event is streamed to a system
  event panel.
* **Built-in automation API** — task registry, command parser, queue and
  dispatch. Also exposed as `window.automation` in the browser console:
  ```js
  automation.call('primes', { limit: 250000 }).then(r => console.log(r))
  automation.registerTask('greet', (p) => `hi ${p.name}`, { thread: 'main' })
  automation.runLine('greet name=world')
  ```
* **Worker pool** — tasks run in parallel Web Workers with live busy/idle
  state, progress bars and per-worker throughput.
* **TTS narration** — the terminal narrates itself via the Web Speech API
  (voice picker, rate control, backlog-capped).

Built-in tasks: `ping`, `hash`, `primes`, `fib`, `matrix`, `uuid`, `scan`
(with progress), `stats`, `help`, `speak`.

### Run it

```sh
cd console-app
npm install
npm run dev
```

