# Neural Sync

> **Ideas held in memory — not on a blockchain.**

A local-first, controlled creative workspace for **content creators**, **coders**, and **programmers**. Every thought is stored in your browser as a node in a personal associative memory graph. Memories link themselves by semantic similarity. No crypto, no wallets, no network calls — just synapses.

## Why "not blockchain"

Blockchains are public, immutable ledgers. Creative thought is *private*, *malleable*, *connected* — the opposite of a chain. Neural Sync stores ideas as a weighted graph of memory nodes (like your brain does), entirely offline in `localStorage`. You export/import as JSON when you move devices.

## Features

- 🧠 **Three personas** — Content Creator / Coder / Programmer starter flows
- 🔗 **Auto-associative linking** — TF-IDF + cosine similarity wires related ideas together automatically
- 🕸 **Interactive neural graph** — force-directed canvas of your memory network
- 🔍 **Semantic search** — meaning-based recall, not just substring
- 📝 **Multiple memory types** — Notes, Code, Drafts, Ideas, References
- 🏷 **Tags, streams, filters** — organize without rigid folders
- 📊 **Pulse panel** — memory count, link density, coherence score, current focus tag
- 💡 **Neural suggestions** — flags floating memories, low coherence, possible missing links
- ⌨️ **Keyboard shortcuts** — `Ctrl/Cmd+N` new memory, `Ctrl/Cmd+K` search, `Esc` close
- 💾 **Import / Export JSON** — your data, your files
- 🌒 **Synaptic dark UI** — calm, focused, no ads

## Run it

Open `index.html` in any modern browser — no build step, no server required.

```
# Or serve locally:
cd neural-sync
python3 -m http.server 8080
# then open http://localhost:8080
```

## Architecture

```
neural-sync/
├── index.html         # shell, splash, modals, graph overlay
├── neural-sync.css    # synaptic dark theme
└── neural-sync.js     # core engine:
                         ├─ Tokenizer + TF-IDF vectorizer
                         ├─ Cosine-similarity linker
                         ├─ localStorage persistence
                         ├─ Force-directed graph renderer
                         └─ Semantic search
```

### Memory model

```js
{
  id:        "m_xxx",
  title:     "Recursive component memoization",
  content:   "…code or prose…",
  type:      "code" | "note" | "draft" | "idea" | "reference",
  tags:      ["react","performance"],
  created:   1698000000000,
  updated:   1698000000000,
  links:     Set<id>,   // bidirectional synapses
  archived:  false
}
```

Memories live in your browser. No telemetry. No keys. No chain.

## License

Same dual license as the repository: Unlicense / GPL-3.0-or-later.
