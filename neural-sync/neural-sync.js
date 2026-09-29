/* =========================================================
   NEURAL SYNC — Core Engine
   Local-first associative memory for creators, coders, programmers.
   No blockchain. No servers. Just synapses in localStorage.
   ========================================================= */

(() => {
  'use strict';

  // ---------- CONSTANTS ----------
  const STORAGE_KEY = 'neural-sync-memories-v1';
  const STATE_KEY = 'neural-sync-state-v1';
  const STOPWORDS = new Set([
    'the','a','an','and','or','but','is','are','was','were','be','been','being',
    'of','in','on','at','to','for','with','by','from','as','it','its','this','that',
    'these','those','i','you','he','she','we','they','me','him','her','us','them',
    'my','your','his','their','our','what','which','who','when','where','why','how',
    'all','any','some','more','most','other','than','then','so','if','not','no','do',
    'does','did','will','would','can','could','should','may','might','must','shall',
    'have','has','had','up','down','out','over','under','about','into','through','also',
    'just','very','too','much','many','like','such','own','same','because','while',
    'function','return','const','let','var','class','new','import','export','from',
    'async','await','try','catch','throw','if','else','for','while','switch','case',
    'break','continue','default','true','false','null','undefined','this','self'
  ]);

  // ---------- STATE ----------
  let memories = {};  // id -> {id, title, content, type, tags, created, updated, links: Set, archived}
  let currentPersona = null;
  let currentStream = 'all';
  let currentTagFilter = null;
  let editingId = null;
  let editorLinks = new Set();
  let graphNodes = [], graphEdges = [];

  // ---------- UTILITIES ----------
  const $ = (s, p=document) => p.querySelector(s);
  const $$ = (s, p=document) => Array.from(p.querySelectorAll(s));
  const uid = () => 'm_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  const now = () => Date.now();

  function toast(msg, dur=2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), dur);
  }

  function timeAgo(ts) {
    const d = (now() - ts) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d/60) + 'm ago';
    if (d < 86400) return Math.floor(d/3600) + 'h ago';
    if (d < 604800) return Math.floor(d/86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function save() {
    const serial = {};
    for (const id in memories) {
      serial[id] = { ...memories[id], links: Array.from(memories[id].links || []) };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serial));
    localStorage.setItem(STATE_KEY, JSON.stringify({ persona: currentPersona }));
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const id in parsed) {
          memories[id] = { ...parsed[id], links: new Set(parsed[id].links || []) };
        }
      }
      const stateRaw = localStorage.getItem(STATE_KEY);
      if (stateRaw) {
        const s = JSON.parse(stateRaw);
        currentPersona = s.persona || null;
      }
    } catch(e) { console.error('Load failed', e); }
  }

  // ---------- TOKENIZATION (for semantic-ish matching) ----------
  function tokenize(text) {
    if (!text) return [];
    return (text.toLowerCase()
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[^a-z0-9\u00c0-\u017f\s]/g, ' ')
      .split(/\s+/))
      .filter(t => t.length > 2 && !STOPWORDS.has(t));
  }

  function tokensOf(m) {
    return tokenize((m.title||'') + ' ' + (m.content||'') + ' ' + (m.tags||[]).join(' '));
  }

  function tfidfVector(tokens, allMemories) {
    const vec = {};
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t]||0) + 1;
    const N = Math.max(1, Object.keys(allMemories).length);
    for (const t in tf) {
      let df = 0;
      for (const id in allMemories) {
        if (allMemories[id]._tokens && allMemories[id]._tokens.has(t)) df++;
      }
      const idf = Math.log((N+1)/(df+1)) + 1;
      vec[t] = tf[t] * idf;
    }
    return vec;
  }

  function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const k in a) { na += a[k]*a[k]; if (b[k]) dot += a[k]*b[k]; }
    for (const k in b) { nb += b[k]*b[k]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na)*Math.sqrt(nb));
  }

  function precomputeTokens() {
    for (const id in memories) {
      memories[id]._tokens = new Set(tokensOf(memories[id]));
    }
  }

  // ---------- AUTO LINKING ----------
  function computeSuggestedLinks(sourceMem, threshold=0.12) {
    const srcVec = tfidfVector(tokensOf(sourceMem), memories);
    const out = [];
    for (const id in memories) {
      if (id === sourceMem.id) continue;
      if (sourceMem.links && sourceMem.links.has(id)) continue;
      const other = memories[id];
      if (other.archived) continue;
      const otherVec = tfidfVector(tokensOf(other), memories);
      const sim = cosineSim(srcVec, otherVec);
      // tag match bonus
      let tagBonus = 0;
      if (sourceMem.tags && other.tags) {
        for (const t of sourceMem.tags) if (other.tags.includes(t)) tagBonus += 0.08;
      }
      // type match small bonus
      if (sourceMem.type === other.type) tagBonus += 0.02;
      const total = sim + tagBonus;
      if (total > threshold) {
        out.push({ id, sim: total });
      }
    }
    return out.sort((a,b) => b.sim - a.sim).slice(0, 6);
  }

  function autoLinkFor(m) {
    // Auto-add strong links (only if above high threshold, user can see/remove later)
    const sugg = computeSuggestedLinks(m, 0.22);
    let count = 0;
    for (const s of sugg) {
      if (count >= 2) break;
      m.links.add(s.id);
      if (memories[s.id]) memories[s.id].links.add(m.id);
      count++;
    }
    return count;
  }

  // ---------- COHERENCE / FOCUS ----------
  function computeStats() {
    const memList = Object.values(memories).filter(m => !m.archived);
    let linkCount = 0;
    const tagCounts = {};
    for (const m of memList) {
      linkCount += (m.links ? m.links.size : 0);
      for (const t of (m.tags||[])) tagCounts[t] = (tagCounts[t]||0) + 1;
    }
    const totalPossible = memList.length * Math.max(1, memList.length - 1);
    const coherence = memList.length < 2 ? 0 : Math.min(100, Math.round((linkCount / totalPossible) * 200));

    let focus = '—';
    const top = Object.entries(tagCounts).sort((a,b)=>b[1]-a[1])[0];
    if (top && memList.length > 0) focus = top[0];
    return { count: memList.length, links: linkCount, coherence, focus };
  }

  // ---------- RENDERING ----------
  function renderStats() {
    const s = computeStats();
    $('#statMemories').textContent = s.count;
    $('#statLinks').textContent = s.links;
    $('#statCoherence').textContent = s.coherence + '%';
    $('#statFocus').textContent = s.focus;
  }

  function renderTagCloud() {
    const counts = {};
    for (const id in memories) {
      const m = memories[id];
      if (m.archived) continue;
      for (const t of (m.tags||[])) counts[t] = (counts[t]||0) + 1;
    }
    const cloud = $('#tagCloud');
    cloud.innerHTML = '';
    const tags = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0, 20);
    if (tags.length === 0) {
      cloud.innerHTML = '<p class="muted">No tags yet.</p>';
      return;
    }
    for (const [tag, n] of tags) {
      const el = document.createElement('span');
      el.className = 'tag' + (currentTagFilter===tag ? ' active' : '');
      el.textContent = '# ' + tag + (n>1 ? ` · ${n}` : '');
      el.onclick = () => {
        currentTagFilter = currentTagFilter===tag ? null : tag;
        renderAll();
      };
      cloud.appendChild(el);
    }
  }

  function renderSuggestions() {
    const box = $('#suggestions');
    const memList = Object.values(memories).filter(m => !m.archived);
    if (memList.length < 2) {
      box.innerHTML = '<p class="muted">Create a memory to see associative links…</p>';
      return;
    }
    // Isolated (floating) nodes
    const floating = memList.filter(m => !m.links || m.links.size === 0);
    // Weak pair: newest memory, find possible missing links
    const newest = [...memList].sort((a,b)=>b.created-a.created)[0];
    const sugg = newest ? computeSuggestedLinks(newest, 0.10).slice(0,2) : [];
    box.innerHTML = '';
    if (floating.length > 0) {
      const el = document.createElement('div');
      el.className = 'suggestion-item';
      el.innerHTML = `<div class="sg-kind">Synapse gap</div><div>${floating.length} floating ${floating.length===1?'memory':'memories'} — link them to strengthen recall.</div>`;
      el.onclick = () => { switchStream('floating'); };
      box.appendChild(el);
    }
    if (newest && sugg.length > 0) {
      const el = document.createElement('div');
      el.className = 'suggestion-item';
      const other = memories[sugg[0].id];
      el.innerHTML = `<div class="sg-kind">Possible link</div><div>"${newest.title}" ↔ "${other.title}" (${Math.round(sugg[0].sim*100)}% match)</div>`;
      el.onclick = () => openEditor(newest.id);
      box.appendChild(el);
    }
    const stats = computeStats();
    if (stats.count >= 3 && stats.coherence < 20) {
      const el = document.createElement('div');
      el.className = 'suggestion-item';
      el.innerHTML = `<div class="sg-kind">Coherence low</div><div>Your memory graph is sparse. Try linking related ideas.</div>`;
      box.appendChild(el);
    }
    if (box.children.length === 0) {
      box.innerHTML = '<p class="muted">Memory is stable. Synapses healthy.</p>';
    }
  }

  function typeIcon(t) {
    return { note:'✎', code:'{ }', draft:'✑', idea:'💡', reference:'🔗' }[t] || '·';
  }

  function filterMemories() {
    let list = Object.values(memories);
    const oneDay = 86400 * 1000;
    if (currentStream === 'recent') list = list.filter(m => !m.archived && now() - m.updated < oneDay);
    else if (currentStream === 'floating') list = list.filter(m => !m.archived && (!m.links || m.links.size === 0));
    else if (currentStream === 'code') list = list.filter(m => !m.archived && m.type === 'code');
    else if (currentStream === 'notes') list = list.filter(m => !m.archived && m.type === 'note');
    else if (currentStream === 'drafts') list = list.filter(m => !m.archived && m.type === 'draft');
    else if (currentStream === 'archived') list = list.filter(m => m.archived);
    else list = list.filter(m => !m.archived);

    if (currentTagFilter) list = list.filter(m => (m.tags||[]).includes(currentTagFilter));
    return list.sort((a,b) => b.updated - a.updated);
  }

  function renderGrid() {
    const grid = $('#memoryGrid');
    const welcome = $('#welcome');
    const list = filterMemories();

    if (Object.keys(memories).length === 0) {
      grid.classList.add('hidden');
      welcome.classList.remove('hidden');
      renderWelcomeIdeas();
      return;
    }
    welcome.classList.add('hidden');
    grid.classList.remove('hidden');

    grid.innerHTML = '';
    if (list.length === 0) {
      grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;padding:40px">No memories in this stream.</p>';
      return;
    }
    for (const m of list) {
      const card = document.createElement('div');
      card.className = 'memory-card type-' + (m.type||'note');
      const snippet = m.content.length > 240 ? m.content.slice(0,240) + '…' : m.content;
      card.innerHTML = `
        <div class="mc-head">
          <div class="mc-title"></div>
          <div class="mc-type">${typeIcon(m.type)}</div>
        </div>
        <div class="mc-body"></div>
        <div class="mc-foot">
          <div class="mc-tags"></div>
          <div class="mc-meta">
            <span class="mc-links">◉ ${m.links ? m.links.size : 0}</span> · ${timeAgo(m.updated)}
          </div>
        </div>`;
      card.querySelector('.mc-title').textContent = m.title || '(untitled)';
      card.querySelector('.mc-body').textContent = snippet;
      const tagsBox = card.querySelector('.mc-tags');
      for (const t of (m.tags||[]).slice(0,3)) {
        const tg = document.createElement('span');
        tg.className = 'mc-tag';
        tg.textContent = '#' + t;
        tagsBox.appendChild(tg);
      }
      card.onclick = () => openDetail(m.id);
      grid.appendChild(card);
    }
  }

  function renderWelcomeIdeas() {
    const starter = {
      creator: [
        { t: '✨ Opening hook', d: 'A gripping first line for your next post.' },
        { t: '🎬 Video script', d: 'Outline scenes, beats, dialogue.' },
        { t: '📝 Blog draft', d: 'Write sections; let links build outline.' },
        { t: '🏷 Tag system', d: 'Build content categories over time.' }
      ],
      coder: [
        { t: '⚙ Function snippet', d: 'Store reusable code with tags.' },
        { t: '🐛 Bug log', d: 'Capture errors & solutions for recall.' },
        { t: '📦 Module idea', d: 'Design interface; link to deps.' },
        { t: '🔁 Refactor note', d: 'Track what to improve in codebase.' }
      ],
      programmer: [
        { t: '🏗 System design', d: 'Map architecture with linked nodes.' },
        { t: '🧮 Algorithm sketch', d: 'Pseudocode & complexity notes.' },
        { t: '📐 Data model', d: 'Schema sketches & invariants.' },
        { t: '🔬 Research note', d: 'Papers, patterns, references.' }
      ]
    };
    const box = $('#welcomeIdeas');
    box.innerHTML = '';
    const ideas = starter[currentPersona] || starter.creator;
    for (const it of ideas) {
      const d = document.createElement('div');
      d.className = 'wi';
      d.innerHTML = `<div class="wit">${it.t}</div><div class="wid">${it.d}</div>`;
      d.onclick = () => openEditor(null);
      box.appendChild(d);
    }
  }

  function renderAll() {
    precomputeTokens();
    renderStats();
    renderTagCloud();
    renderSuggestions();
    renderGrid();

    // Stream active states
    $$('#streamList li').forEach(li => {
      li.classList.toggle('active', li.dataset.stream === currentStream);
    });
  }

  // ---------- STREAMS ----------
  function switchStream(stream) {
    currentStream = stream;
    currentTagFilter = null;
    renderAll();
  }

  // ---------- SEARCH ----------
  function semanticSearch(q) {
    const qToks = tokenize(q);
    if (qToks.length === 0) return [];
    const qVec = tfidfVector(qToks, memories);
    const out = [];
    for (const id in memories) {
      if (memories[id].archived) continue;
      const m = memories[id];
      const mVec = tfidfVector(tokensOf(m), memories);
      let sim = cosineSim(qVec, mVec);
      // title/substring boost
      const haystack = (m.title + ' ' + m.content).toLowerCase();
      if (m.title.toLowerCase().includes(q.toLowerCase())) sim += 0.3;
      if (haystack.includes(q.toLowerCase())) sim += 0.15;
      if (sim > 0.03) out.push({ m, sim });
    }
    return out.sort((a,b)=>b.sim-a.sim).slice(0, 8);
  }

  function renderSearch(q) {
    const res = $('#searchResults');
    if (!q) { res.classList.add('hidden'); return; }
    const hits = semanticSearch(q);
    if (hits.length === 0) {
      res.innerHTML = '<div class="search-result-item"><span class="sr-snip">No memories match. Press + New Memory to capture it.</span></div>';
      res.classList.remove('hidden');
      return;
    }
    res.innerHTML = '';
    for (const {m, sim} of hits) {
      const d = document.createElement('div');
      d.className = 'search-result-item';
      const snip = (m.content||'').slice(0,100).replace(/\n/g,' ');
      d.innerHTML = `<span class="sr-score">${Math.round(sim*100)}%</span><div class="sr-title">${escapeHtml(m.title||'(untitled)')} ${typeIcon(m.type)}</div><div class="sr-snip">${escapeHtml(snip)}…</div>`;
      d.onclick = () => {
        $('#searchInput').value = '';
        res.classList.add('hidden');
        openDetail(m.id);
      };
      res.appendChild(d);
    }
    res.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- EDITOR ----------
  function openEditor(id) {
    editingId = id;
    editorLinks = new Set();
    const m = id ? memories[id] : null;
    $('#editorTitle').textContent = id ? 'Edit Memory' : 'New Memory';
    $('#mTitle').value = m ? m.title : '';
    $('#mContent').value = m ? m.content : '';
    $('#mTags').value = m ? (m.tags||[]).join(', ') : '';
    $$('.tbtn').forEach(b => b.classList.toggle('active', m ? b.dataset.type === m.type : b.dataset.type === 'note'));
    $('#deleteMem').classList.toggle('hidden', !id);
    $('#linkSearch').value = '';
    $('#linkResults').classList.add('hidden');
    if (m) {
      editorLinks = new Set(m.links || []);
    } else if (currentPersona === 'coder') {
      // small starter template for coders
      $$('.tbtn').forEach(b => b.classList.toggle('active', b.dataset.type === 'code'));
    }
    renderLinkedChips();
    $('#editorModal').classList.remove('hidden');
    setTimeout(() => $('#mTitle').focus(), 50);
  }

  function closeEditor() {
    $('#editorModal').classList.add('hidden');
    editingId = null;
    editorLinks = new Set();
  }

  function currentType() {
    const active = $('.tbtn.active');
    return active ? active.dataset.type : 'note';
  }

  function renderLinkedChips() {
    const box = $('#linkedChips');
    box.innerHTML = '';
    for (const lid of editorLinks) {
      const other = memories[lid];
      if (!other) continue;
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `${escapeHtml(other.title||'(untitled)')} <span class="x">✕</span>`;
      c.querySelector('.x').onclick = () => { editorLinks.delete(lid); renderLinkedChips(); };
      box.appendChild(c);
    }
  }

  function renderLinkResults(q) {
    const box = $('#linkResults');
    if (!q) { box.classList.add('hidden'); return; }
    const hits = semanticSearch(q).filter(r => r.m.id !== editingId && !editorLinks.has(r.m.id)).slice(0,5);
    if (hits.length === 0) {
      box.innerHTML = '<div class="link-result muted">No matches.</div>';
    } else {
      box.innerHTML = '';
      for (const {m} of hits) {
        const d = document.createElement('div');
        d.className = 'link-result';
        d.textContent = (m.title||'(untitled)') + '  ' + typeIcon(m.type);
        d.onclick = () => {
          editorLinks.add(m.id);
          $('#linkSearch').value = '';
          box.classList.add('hidden');
          renderLinkedChips();
        };
        box.appendChild(d);
      }
    }
    box.classList.remove('hidden');
  }

  function saveMemory() {
    const title = $('#mTitle').value.trim();
    const content = $('#mContent').value;
    const tags = $('#mTags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const type = currentType();
    if (!title && !content.trim()) { toast('Add a title or content.'); return; }

    let m;
    if (editingId) {
      m = memories[editingId];
      // Remove old reverse links
      if (m.links) for (const oldId of m.links) {
        if (memories[oldId]) memories[oldId].links.delete(m.id);
      }
      m.title = title || '(untitled)';
      m.content = content;
      m.tags = tags;
      m.type = type;
      m.links = new Set(editorLinks);
      m.updated = now();
    } else {
      const id = uid();
      m = {
        id, title: title || '(untitled)', content, tags, type,
        created: now(), updated: now(), links: new Set(editorLinks),
        archived: false
      };
      memories[id] = m;
    }
    // Add reverse links
    for (const lid of m.links) {
      if (memories[lid]) memories[lid].links.add(m.id);
    }
    // Auto-link (semantic)
    const auto = autoLinkFor(m);
    save();
    closeEditor();
    renderAll();
    toast(editingId ? 'Memory updated.' : `Memory etched${auto ? ` · ${auto} auto-link${auto>1?'s':''} found` : ''}.`);
  }

  function deleteMemory() {
    if (!editingId) return;
    if (!confirm('Erase this memory? Links will be removed too.')) return;
    const m = memories[editingId];
    for (const lid of (m.links||[])) {
      if (memories[lid]) memories[lid].links.delete(m.id);
    }
    delete memories[editingId];
    save();
    closeEditor();
    renderAll();
    toast('Memory dissolved.');
  }

  // ---------- DETAIL ----------
  function openDetail(id) {
    const m = memories[id];
    if (!m) return;
    $('#detailTitle').textContent = m.title;
    $('#detailType').textContent = m.type;
    $('#detailType').className = 'badge ' + m.type;
    $('#detailDate').textContent = '· created ' + new Date(m.created).toLocaleString();
    $('#detailContent').textContent = m.content;
    const tagsBox = $('#detailTags');
    tagsBox.innerHTML = '';
    for (const t of (m.tags||[])) {
      const el = document.createElement('span');
      el.className = 'mc-tag';
      el.textContent = '#' + t;
      tagsBox.appendChild(el);
    }
    const linksBox = $('#detailLinks');
    linksBox.innerHTML = '';
    const linkArr = [];
    for (const lid of (m.links||[])) {
      const other = memories[lid];
      if (!other) continue;
      // calculate strength
      const v1 = tfidfVector(tokensOf(m), memories);
      const v2 = tfidfVector(tokensOf(other), memories);
      const s = cosineSim(v1, v2);
      linkArr.push({ m: other, s });
    }
    // Add suggestions at bottom
    const sugg = computeSuggestedLinks(m, 0.08).filter(r => !m.links.has(r.id));
    for (const {m: other, s} of linkArr.sort((a,b)=>b.s-a.s)) {
      const d = document.createElement('div');
      d.className = 'dl-item';
      d.innerHTML = `<span class="dl-strength">◉ ${Math.round(s*100)}%</span><div class="dlt">${escapeHtml(other.title)} ${typeIcon(other.type)}</div><div class="dls">${escapeHtml((other.content||'').slice(0,80).replace(/\n/g,' '))}…</div>`;
      d.onclick = () => { closeDetail(); openDetail(other.id); };
      linksBox.appendChild(d);
    }
    if (sugg.length > 0) {
      const head = document.createElement('div');
      head.innerHTML = '<p class="muted" style="margin-top:12px;font-size:11px;letter-spacing:1px">Suggested links (not yet connected):</p>';
      linksBox.appendChild(head);
      for (const s of sugg.slice(0,3)) {
        const other = memories[s.id];
        const d = document.createElement('div');
        d.className = 'dl-item';
        d.style.borderLeftColor = 'var(--accent-3)';
        d.innerHTML = `<span class="dl-strength" style="color:var(--accent-3)">＋ ${Math.round(s.sim*100)}%</span><div class="dlt">${escapeHtml(other.title)} ${typeIcon(other.type)}</div><div class="dls">Click to open, then Edit to link.</div>`;
        d.onclick = () => { closeDetail(); openDetail(other.id); };
        linksBox.appendChild(d);
      }
    }
    if (linkArr.length === 0 && sugg.length === 0) {
      linksBox.innerHTML = '<p class="muted">No associations yet. Add links or create related memories.</p>';
    }
    $('#detailModal').classList.remove('hidden');
    $('#editFromDetail').onclick = () => { closeDetail(); openEditor(id); };
  }
  function closeDetail() { $('#detailModal').classList.add('hidden'); }

  // ---------- GRAPH (force-directed canvas) ----------
  function buildGraphData() {
    const ids = Object.keys(memories).filter(id => !memories[id].archived);
    graphNodes = ids.map((id,i) => {
      const m = memories[id];
      return {
        id,
        label: m.title || '(untitled)',
        type: m.type,
        x: Math.cos(i/ids.length * Math.PI*2) * 200 + (Math.random()*40-20),
        y: Math.sin(i/ids.length * Math.PI*2) * 200 + (Math.random()*40-20),
        vx:0, vy:0,
        links: m.links ? m.links.size : 0
      };
    });
    graphEdges = [];
    const seen = new Set();
    for (const n of graphNodes) {
      const m = memories[n.id];
      for (const lid of (m.links||[])) {
        const key = [n.id, lid].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const other = graphNodes.find(x => x.id === lid);
        if (other) graphEdges.push({ a:n, b:other });
      }
    }
  }

  let graphAnim = null;
  let graphDragging = null;
  let graphPan = { x:0, y:0 };
  let graphPanning = false;
  let graphScale = 1;

  function openGraph() {
    $('#graphOverlay').classList.remove('hidden');
    buildGraphData();
    runGraph();
  }
  function closeGraph() {
    $('#graphOverlay').classList.add('hidden');
    if (graphAnim) cancelAnimationFrame(graphAnim);
  }

  function runGraph() {
    const canvas = $('#graphCanvas');
    const ctx = canvas.getContext('2d');
    const resize = () => {
      canvas.width = canvas.clientWidth * window.devicePixelRatio;
      canvas.height = canvas.clientHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resize();
    window.addEventListener('resize', resize);

    const colorOfType = t => ({
      note: '#7ef0ff', code: '#9b7bff', draft: '#ffd27b', idea: '#ff7bc8', reference: '#7bff9e'
    }[t] || '#7ef0ff');

    function step() {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      ctx.clearRect(0,0,W,H);

      const cx = W/2 + graphPan.x, cy = H/2 + graphPan.y;
      // forces
      for (let i=0;i<graphNodes.length;i++) {
        const n = graphNodes[i];
        n.vx += (cx - n.x) * 0.0008;
        n.vy += (cy - n.y) * 0.0008;
        for (let j=0;j<graphNodes.length;j++) {
          if (i===j) continue;
          const o = graphNodes[j];
          const dx = n.x-o.x, dy = n.y-o.y;
          const d2 = dx*dx+dy*dy + 0.1;
          const f = 3000/d2;
          n.vx += dx/Math.sqrt(d2) * f * 0.02;
          n.vy += dy/Math.sqrt(d2) * f * 0.02;
        }
      }
      for (const e of graphEdges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx*dx+dy*dy) || 1;
        const target = 110;
        const f = (d - target) * 0.02;
        e.a.vx += dx/d * f;
        e.a.vy += dy/d * f;
        e.b.vx -= dx/d * f;
        e.b.vy -= dy/d * f;
      }
      for (const n of graphNodes) {
        if (n === graphDragging) { n.vx=0; n.vy=0; continue; }
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
      }

      // edges
      ctx.lineWidth = 1;
      for (const e of graphEdges) {
        const grad = ctx.createLinearGradient(e.a.x, e.a.y, e.b.x, e.b.y);
        grad.addColorStop(0, colorOfType(e.a.type) + '55');
        grad.addColorStop(1, colorOfType(e.b.type) + '55');
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
      }

      const showLabels = $('#showLabels').checked;
      for (const n of graphNodes) {
        const r = 5 + Math.min(8, n.links);
        // glow
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r*3);
        g.addColorStop(0, colorOfType(n.type) + '66');
        g.addColorStop(1, colorOfType(n.type) + '00');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r*3, 0, Math.PI*2);
        ctx.fill();
        // node
        ctx.fillStyle = colorOfType(n.type);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI*2);
        ctx.fill();
        if (showLabels) {
          ctx.fillStyle = '#e6ecff';
          ctx.font = '11px Inter, sans-serif';
          ctx.fillText(n.label, n.x + r + 4, n.y + 3);
        }
      }

      graphAnim = requestAnimationFrame(step);
    }
    step();

    const toLocal = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const hitNode = (p) => {
      for (const n of graphNodes) {
        const dx = n.x-p.x, dy = n.y-p.y;
        if (dx*dx+dy*dy < 256) return n;
      }
      return null;
    };
    canvas.onmousedown = (ev) => {
      const p = toLocal(ev);
      const n = hitNode(p);
      if (n) { graphDragging = n; }
      else { graphPanning = true; graphPan._start = { x: p.x - graphPan.x, y: p.y - graphPan.y }; }
    };
    canvas.onmousemove = (ev) => {
      const p = toLocal(ev);
      if (graphDragging) { graphDragging.x = p.x; graphDragging.y = p.y; }
      else if (graphPanning) { graphPan.x = p.x - graphPan._start.x; graphPan.y = p.y - graphPan._start.y; }
    };
    canvas.onmouseup = (ev) => {
      const p = toLocal(ev);
      const wasDragging = graphDragging;
      const moved = wasDragging && (Math.abs(wasDragging.x - (p.x)) + Math.abs(wasDragging.y - (p.y)) < 4);
      graphDragging = null;
      graphPanning = false;
      if (wasDragging) {
        const n = hitNode(p);
        if (n === wasDragging) { openDetail(n.id); closeGraph(); }
      }
    };
    canvas.onwheel = (ev) => {
      ev.preventDefault();
      graphScale *= (1 - ev.deltaY*0.001);
      graphScale = Math.max(0.4, Math.min(2, graphScale));
    };
  }

  // ---------- IMPORT / EXPORT ----------
  function exportMemories() {
    const serial = {};
    for (const id in memories) {
      serial[id] = { ...memories[id], links: Array.from(memories[id].links||[]) };
    }
    const blob = new Blob([JSON.stringify({ version:1, exportedAt: now(), persona: currentPersona, memories: serial }, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neural-sync-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Memories exported.');
  }

  function importMemories(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        let added = 0;
        const src = data.memories || data;
        for (const id in src) {
          const o = src[id];
          if (!o.title && !o.content) continue;
          const nid = memories[id] ? uid() : id;
          memories[nid] = {
            id: nid,
            title: o.title || '(untitled)',
            content: o.content || '',
            type: o.type || 'note',
            tags: o.tags || [],
            created: o.created || now(),
            updated: o.updated || now(),
            links: new Set(o.links || []),
            archived: !!o.archived
          };
          added++;
        }
        save();
        renderAll();
        toast(`Imported ${added} memories.`);
      } catch(e) { toast('Import failed — invalid file.'); }
    };
    reader.readAsText(file);
  }

  function resetAll() {
    if (!confirm('Dissolve ALL memories? This cannot be undone.')) return;
    memories = {};
    save();
    renderAll();
    toast('Memory wiped. Fresh start.');
  }

  // ---------- SPLASH ----------
  function initSplash() {
    $$('.persona-btn').forEach(b => {
      b.onclick = () => {
        $$('.persona-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        currentPersona = b.dataset.persona;
        $('#enterBtn').disabled = false;
      };
    });
    $('#enterBtn').onclick = () => {
      if (!currentPersona) return;
      save();
      $('#splash').classList.add('hidden');
      $('#app').classList.remove('hidden');
      updatePersonaBadge();
      renderAll();
      // If returning user has no memories, maybe seed one? no — let them create.
      if (Object.keys(memories).length === 0) {
        seedWelcome();
      }
    };
    if (currentPersona) {
      $$('.persona-btn').forEach(b => b.classList.toggle('selected', b.dataset.persona === currentPersona));
      $('#enterBtn').disabled = false;
    }
  }

  function updatePersonaBadge() {
    const label = { creator:'Content Creator', coder:'Coder', programmer:'Programmer' }[currentPersona];
    $('#personaBadge').textContent = label;
  }

  function seedWelcome() {
    // Nothing — blank slate. welcome-ideas gives starters.
  }

  // ---------- EVENT WIRING ----------
  function wire() {
    $('#newIdeaBtn').onclick = () => openEditor(null);
    $('#closeEditor').onclick = closeEditor;
    $('#saveMem').onclick = saveMemory;
    $('#deleteMem').onclick = deleteMemory;
    $('#closeDetail').onclick = closeDetail;
    $('#graphBtn').onclick = openGraph;
    $('#closeGraph').onclick = closeGraph;
    $('#exportBtn').onclick = exportMemories;
    $('#importBtn').onclick = () => $('#importFile').click();
    $('#importFile').onchange = (e) => {
      if (e.target.files[0]) importMemories(e.target.files[0]);
      e.target.value = '';
    };
    $('#resetBtn').onclick = resetAll;

    $$('#streamList li').forEach(li => {
      li.onclick = () => switchStream(li.dataset.stream);
    });

    // type picker
    $$('.tbtn').forEach(b => {
      b.onclick = () => {
        $$('.tbtn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
    });

    // search
    $('#searchInput').addEventListener('input', (e) => renderSearch(e.target.value));
    $('#searchInput').addEventListener('focus', (e) => { if (e.target.value) renderSearch(e.target.value); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#searchInput') && !e.target.closest('#searchResults')) {
        $('#searchResults').classList.add('hidden');
      }
      if (!e.target.closest('#linkSearch') && !e.target.closest('#linkResults')) {
        $('#linkResults').classList.add('hidden');
      }
    });

    $('#linkSearch').addEventListener('input', (e) => renderLinkResults(e.target.value));

    // modal backdrop close
    $$('.modal-backdrop').forEach(b => {
      b.onclick = () => { closeEditor(); closeDetail(); };
    });
    // ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeEditor(); closeDetail(); closeGraph(); $('#searchResults').classList.add('hidden'); }
      if ((e.metaKey||e.ctrlKey) && e.key === 'n') { e.preventDefault(); if (!$('#app').classList.contains('hidden')) openEditor(null); }
      if ((e.metaKey||e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#searchInput').focus(); }
    });
  }

  // ---------- BOOT ----------
  function boot() {
    load();
    initSplash();
    wire();
    if (currentPersona && Object.keys(memories).length > 0) {
      // Optional auto-enter if returning user; but let them re-see splash for persona choice.
    }
  }

  boot();

})();
