import './vendor/foliate-js/view.js'
import { createTOCView } from './vendor/foliate-js/ui/tree.js'

const $ = s => document.querySelector(s)
const drop = $('#drop')
const readerEl = $('#reader')
const host = $('#view-host')
const toolbar = $('#toolbar')
const loc = $('#loc')
const zoomLabel = $('#zoom-label')
const file = $('#file')
const sidePanel = $('#side-panel')
const sideTitle = $('#side-title')
const sideBody = $('#side-body')

const THEME_CYCLE = ['light', 'sepia', 'dark']
const THEME_ICON = { light: '☀', sepia: '📜', dark: '🌙' }
const SPREAD_LABEL = { 1: '单页', 2: '双页' }
const FIT_LABEL = { width: '宽度', page: '整页' }
const ZOOM_STEPS = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2]
const ZOOM_BASE_PX = 720
const FONT_SIZES = { S: 15, M: 17, L: 19, XL: 22 }
const FONT_FAMILY_KEYS = ['sans', 'serif', 'mono']
const FONT_FAMILY_CSS = {
  sans:  '-apple-system, system-ui, "Helvetica Neue", "Segoe UI", sans-serif',
  serif: '"Iowan Old Style", "Charter", "Georgia", "Songti SC", serif',
  mono:  '"SF Mono", "Cascadia Code", "Menlo", "Consolas", monospace',
}
const FONT_FAMILY_LABEL = { sans: 'Sans', serif: 'Serif', mono: 'Mono' }

const state = (() => {
  try { return JSON.parse(localStorage.getItem('br') || '{}') } catch { return {} }
})()
state.zoom ??= 1
state.spread ??= 1
state.fitMode ??= 'width'
state.theme ??= 'light'
state.fontSize ??= 'M'
state.fontFamily ??= 'sans'
// Sanitize corrupt localStorage values — fall back if the persisted key isn't in the table
if (!FONT_SIZES[state.fontSize]) state.fontSize = 'M'
if (!FONT_FAMILY_CSS[state.fontFamily]) state.fontFamily = 'sans'
if (![1, 2].includes(state.spread)) state.spread = 1
if (!['width', 'page'].includes(state.fitMode)) state.fitMode = 'width'
if (!['light', 'sepia', 'dark'].includes(state.theme)) state.theme = 'light'
state.bookmarks ??= {}       // { [bookId]: [{ value, label, color, ts }] }
state.bmColor ??= 'yellow'    // current bookmark color
state.sideMode ??= null      // 'toc' | 'search' | 'bookmarks' | 'shelf' | null
state.searchOpts ??= { matchCase: false, wholeWords: false }
state.shelf ??= []           // [{ fingerprint, title, author, cfi, fraction, openedAt }]

let view = null
let bookId = null
let tocView = null            // foliate-js createTOCView handle
let searchAbort = null        // current search AbortController
let lastFingerprint = null    // fingerprint of currently-open File, for shelf updates

const save = () => localStorage.setItem('br', JSON.stringify({
  zoom: state.zoom, spread: state.spread, fitMode: state.fitMode, theme: state.theme,
  fontSize: state.fontSize, fontFamily: state.fontFamily,
  progress: state.progress, bookmarks: state.bookmarks, sideMode: state.sideMode,
  bmColor: state.bmColor, searchOpts: state.searchOpts, shelf: state.shelf,
}))

// === IndexedDB (for shelf blob persistence) ===
let _db
const dbOpen = () => new Promise((res, rej) => {
  if (_db) return res(_db)
  const r = indexedDB.open('bookreader', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('blobs', { keyPath: 'fingerprint' })
  r.onsuccess = () => { _db = r.result; res(_db) }
  r.onerror = () => rej(r.error)
})
const idbOp = (mode, ...args) => dbOpen().then(db => new Promise((res, rej) => {
  const req = db.transaction('blobs', mode).objectStore('blobs')[args[0]](...args.slice(1))
  req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
}))
const idbPut = (rec) => idbOp('readwrite', 'put', rec)
const idbGet = (key) => idbOp('readonly', 'get', key)
const idbDel = (key) => idbOp('readwrite', 'delete', key)

const fingerprint = file => `${file.name}|${file.size}|${file.lastModified || 0}`

// foliate-js metadata fields are sometimes a string, sometimes a { '': 'X', '#text': 'Y' } map
const metaText = m => {
  if (!m) return ''
  if (typeof m === 'string') return m.trim()
  const vals = Object.values(m).filter(v => typeof v === 'string' && v.trim())
  return vals.sort((a, b) => b.length - a.length)[0] || ''
}

function applyTheme() {
  document.documentElement.classList.remove('dark', 'sepia')
  if (state.theme === 'dark') document.documentElement.classList.add('dark')
  else if (state.theme === 'sepia') document.documentElement.classList.add('sepia')
}

function snapZoom(z) {
  let best = ZOOM_STEPS[0], bestD = Infinity
  for (const s of ZOOM_STEPS) {
    const d = Math.abs(s - z)
    if (d < bestD) { best = s; bestD = d }
  }
  return best
}

// Floating "Add bookmark" FAB — appears top-right of the page once a book is
// loaded. Click adds a bookmark at the current CFI. Visible only when a book
// is open. Mirrors the toolbar bookmark button but doesn't auto-add on click.
let bmFab = null
function showBmFab() {
  if (bmFab) { bmFab.hidden = false; return }
  bmFab = document.createElement('button')
  bmFab.id = 'bm-fab'
  bmFab.dataset.tip = 'Add bookmark'
  bmFab.textContent = '🔖'
  bmFab.onclick = () => {
    if (!view || !bookId) return
    addBookmark()
    // brief flash to confirm
    bmFab.classList.add('bm-fab-flash')
    setTimeout(() => bmFab.classList.remove('bm-fab-flash'), 350)
  }
  document.body.append(bmFab)
}
function hideBmFab() { if (bmFab) bmFab.hidden = true }

function applyRenderer() {
  if (!view?.renderer) return
  try {
    view.renderer.setAttribute('flow', 'paginated')
    view.renderer.setAttribute('max-column-count', String(state.spread))
    view.renderer.setAttribute('max-inline-size',
      state.fitMode === 'page' ? 'none' : `${Math.round(ZOOM_BASE_PX * state.zoom)}px`)
    view.renderer.setAttribute('gap', '20px')
    // Resolve CSS vars on the parent :root to literal values — foliate renders
    // into iframes whose own :root has no --fg, so `var(--fg)` falls back to
    // black. Read once per apply, pass literals.
    const rootCs = getComputedStyle(document.documentElement)
    const fg = rootCs.getPropertyValue('--fg').trim()
    view.renderer.setStyles?.(`
      html { background: transparent; color: ${fg};
             font-family: ${FONT_FAMILY_CSS[state.fontFamily] || FONT_FAMILY_CSS.sans};
             font-size: ${FONT_SIZES[state.fontSize] || FONT_SIZES.M}px; }
      body { color: ${fg}; }
      p, li, blockquote, dd { line-height: 1.6; }
    `)
  } catch (e) {
    console.warn('applyRenderer failed:', e)
  }
}

function updateToolbar() {
  toolbar.querySelector('[data-act="spread"]').textContent = SPREAD_LABEL[state.spread]
  toolbar.querySelector('[data-act="fit"]').textContent = FIT_LABEL[state.fitMode]
  toolbar.querySelector('[data-act="theme"]').textContent = THEME_ICON[state.theme]
  toolbar.querySelector('[data-act="font-family"]').textContent = FONT_FAMILY_LABEL[state.fontFamily]
  toolbar.querySelector('[data-act="font-size"]').textContent = state.fontSize
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`
}

function currentBookId(book) {
  const meta = book?.metadata
  const id = meta?.identifier && Object.values(meta.identifier)[0]
  if (id) return String(id)
  return (meta?.title && Object.values(meta.title)[0]) || 'unknown'
}

async function open(target, opts = {}) {
  if (view) { view.remove(); view = null }
  stopTts()
  // Only overwrite lastFingerprint when we have a real File. For auto-restore
  // (which passes a Blob fetched from IDB), the caller has already set
  // lastFingerprint so debouncedShelfSave can keep updating the right shelf
  // entry's cfi on every page turn — without this, the shelf entry's cfi stays
  // frozen at the initial position and refresh loses progress.
  if (opts.file) lastFingerprint = fingerprint(opts.file)
  view = document.createElement('foliate-view')
  let restored = false
  const tryRestore = () => {
    if (restored || !view?.book) return
    restored = true
    // Pick the best target: explicit cfi > shelf entry by fingerprint > global progress
    let cfi, fraction
    if (opts.restoreCfi) {
      cfi = opts.restoreCfi
      fraction = opts.restoreFraction
    } else if (opts.file) {
      const item = state.shelf.find(s => s.fingerprint === fingerprint(opts.file))
      if (item?.cfi) { cfi = item.cfi; fraction = item.fraction }
    }
    // state.progress.cfi is the freshest (saved on every relocate, no debounce)
    if (!cfi && state.progress?.cfi) {
      cfi = state.progress.cfi
      fraction = state.progress.fraction
    }
    if (!cfi && state.progress?.href) {
      cfi = state.progress.href
      fraction = state.progress.fraction
    }
    if (cfi) {
      view.goTo(cfi).catch(() =>
        Number.isFinite(fraction) ? view.goToFraction(fraction) : null
      ).catch(() => {})
    } else if (Number.isFinite(fraction)) {
      view.goToFraction(fraction)
    }
  }
  view.addEventListener('load', () => {
    applyRenderer()
    bookId = currentBookId(view.book)
    loadBookmarks()
    showBmFab()
    tryRestore()
    loadVoices()
    if (opts.file) addToShelf(opts.file).catch(console.error)
  })
  view.addEventListener('relocate', e => {
    const { cfi, fraction, pageItem, tocItem } = e.detail
    // Store cfi directly in state.progress so refresh restore works immediately
    // without depending on the 800ms-debounced shelf.cfi update.
    state.progress = { cfi, fraction, href: tocItem?.href }
    loc.dataset.tip = pageItem?.label ? `Page ${pageItem.label} · ${Math.round(fraction * 100)}%`
                                     : `${Math.round(fraction * 100)}%`
    loc.value = fraction
    if (tocView && tocItem?.href) {
      tocView.setCurrentHref?.(tocItem.href)
      // Scroll the current TOC item into view (if side panel is open as toc)
      if (state.sideMode === 'toc') {
        const el = tocView.element.querySelector('[aria-current="true"]')
        el?.scrollIntoView({ block: 'center' })
      }
    }
    save()
    debouncedShelfSave()
  })
  host.append(view)
  await view.open(target)
  // Backup restore in case 'load' fired before view.book was set or never fired.
  tryRestore()
  drop.hidden = true
  readerEl.hidden = false
  // Open last-used side panel mode (if any)
  if (state.sideMode) openSide(state.sideMode)
  // Auto-save last opened book for restoration
  save()
}

// === Side panel ===
function setSideMode(mode) {
  state.sideMode = mode
  sidePanel.hidden = !mode
  save()
}

function openSide(mode) {
  setSideMode(mode)
  sideBody.innerHTML = ''
  if (mode === 'toc') renderToc()
  else if (mode === 'search') renderSearch()
  else if (mode === 'bookmarks') renderBookmarks()
  else if (mode === 'shelf') renderShelf()
}

function closeSide() {
  setSideMode(null)
  if (searchAbort) { searchAbort.abort(); searchAbort = null }
  if (speechSynthesis.speaking) speechSynthesis.cancel()
  removeTtsPanel()
}

function renderToc() {
  if (!view?.book?.toc) {
    sideTitle.textContent = 'Contents'
    sideBody.textContent = 'No table of contents'
    return
  }
  sideTitle.textContent = 'Contents'
  tocView = createTOCView(view.book.toc, href => {
    view.goTo(href).catch(console.error)
  })
  sideBody.append(tocView.element)
}

// === Search ===
function renderSearch() {
  sideTitle.textContent = 'Search'
  sideBody.innerHTML = ''
  const box = document.createElement('div')
  box.id = 'search-box'
  const input = document.createElement('input')
  input.id = 'search-input'
  input.placeholder = 'Search…'
  input.autocomplete = 'off'
  // Match-case toggle (Aa)
  const caseBtn = document.createElement('button')
  caseBtn.className = 'search-opt' + (state.searchOpts.matchCase ? ' active' : '')
  caseBtn.textContent = 'Aa'
  caseBtn.title = 'Match case'
  caseBtn.onclick = () => {
    state.searchOpts.matchCase = !state.searchOpts.matchCase
    caseBtn.classList.toggle('active')
    save()
    triggerSearch()
  }
  // Whole-word toggle (\b)
  const wordBtn = document.createElement('button')
  wordBtn.className = 'search-opt' + (state.searchOpts.wholeWords ? ' active' : '')
  wordBtn.textContent = '\\b'
  wordBtn.title = 'Whole words'
  wordBtn.onclick = () => {
    state.searchOpts.wholeWords = !state.searchOpts.wholeWords
    wordBtn.classList.toggle('active')
    save()
    triggerSearch()
  }
  box.append(input, caseBtn, wordBtn)
  const status = document.createElement('div')
  status.id = 'search-status'
  const list = document.createElement('div')
  sideBody.append(box, status, list)
  input.focus()
  let timer
  const triggerSearch = () => doSearch(input.value, status, list)
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(triggerSearch, 250)
  })
}

async function doSearch(q, status, list) {
  if (!view) return
  if (!q.trim()) { status.textContent = ''; list.innerHTML = ''; return }
  if (searchAbort) searchAbort.abort()
  searchAbort = new AbortController()
  status.textContent = 'Searching…'
  list.innerHTML = ''
  const start = performance.now()
  let count = 0
  const renderResult = (cfi, excerpt) => {
    count++
    const item = document.createElement('div')
    item.className = 'search-result'
    const ex = document.createElement('div')
    ex.className = 'excerpt'
    ex.innerHTML = `${excerpt.pre}<mark>${excerpt.match}</mark>${excerpt.post}`
    const ch = document.createElement('div')
    ch.className = 'chapter'
    ch.textContent = `cfi ${cfi.slice(0, 16)}…`
    item.append(ex, ch)
    item.onclick = () => view.goTo(cfi).catch(console.error)
    list.append(item)
  }
  const opts = {
    query: q,
    signal: searchAbort.signal,
    matchCase: state.searchOpts.matchCase,
    matchWholeWords: state.searchOpts.wholeWords,
  }
  try {
    for await (const result of view.search(opts)) {
      if (result === 'done') break
      if (result.progress) {
        status.textContent = `Searching… ${Math.round(result.progress * 100)}%`
        continue
      }
      if (result.subitems) {
        for (const sub of result.subitems) {
          if (sub.cfi && sub.excerpt) renderResult(sub.cfi, sub.excerpt)
        }
        continue
      }
      if (result.cfi && result.excerpt) renderResult(result.cfi, result.excerpt)
    }
    const ms = Math.round(performance.now() - start)
    status.textContent = `${count} match${count === 1 ? '' : 'es'} · ${ms}ms`
  } catch (e) {
    if (e.name !== 'AbortError') status.textContent = 'Error: ' + e.message
  }
}

// === Bookmarks ===
function loadBookmarks() {
  if (!view || !bookId) return
  const list = state.bookmarks[bookId] || []
  for (const bm of list) {
    view.addAnnotation({ value: bm.value, color: bm.color || 'yellow' }).catch(() => {})
  }
}

function addBookmark() {
  if (!view || !bookId) return
  const cfi = view.lastLocation?.cfi
  if (!cfi) return
  const list = state.bookmarks[bookId] ||= []
  const label = `Bookmark ${list.length + 1}`
  const color = state.bmColor || 'yellow'
  const bm = { value: cfi, label, color, ts: Date.now() }
  list.push(bm)
  view.addAnnotation({ value: cfi, color }).catch(() => {})
  save()
  if (state.sideMode === 'bookmarks') renderBookmarks()
}

function removeBookmark(value) {
  if (!view || !bookId) return
  const list = state.bookmarks[bookId]
  if (!list) return
  const idx = list.findIndex(b => b.value === value)
  if (idx >= 0) list.splice(idx, 1)
  view.deleteAnnotation?.({ value })
  save()
  renderBookmarks()
}

const BM_COLORS = [
  { name: 'yellow', hex: '#fbbf24' },
  { name: 'red',    hex: '#ef4444' },
  { name: 'green',  hex: '#22c55e' },
  { name: 'blue',   hex: '#3b82f6' },
]

function renderBookmarks() {
  if (!view || !bookId) return
  sideTitle.textContent = 'Bookmarks'
  sideBody.innerHTML = ''

  // Add bar (color picker + add button)
  const addBar = document.createElement('div')
  addBar.id = 'bm-add-bar'
  const label = document.createElement('span')
  label.textContent = 'Color:'
  addBar.append(label)
  for (const c of BM_COLORS) {
    const sw = document.createElement('div')
    sw.className = 'swatch' + (state.bmColor === c.name ? ' active' : '')
    sw.style.background = c.hex
    sw.title = c.name
    sw.onclick = () => { state.bmColor = c.name; save(); renderBookmarks() }
    addBar.append(sw)
  }
  const addBtn = document.createElement('button')
  addBtn.textContent = '+ Add at current'
  addBtn.onclick = addBookmark
  addBar.append(addBtn)
  sideBody.append(addBar)

  const list = state.bookmarks[bookId] || []
  if (!list.length) {
    const empty = document.createElement('div')
    empty.id = 'bm-empty'
    empty.textContent = 'No bookmarks yet.\nPick a color and click + Add at current.'
    sideBody.append(empty)
    return
  }
  for (const bm of list) {
    const row = document.createElement('div')
    row.className = 'bm-item'
    const dot = document.createElement('div')
    dot.className = 'bm-color-dot'
    dot.style.background = BM_COLORS.find(c => c.name === bm.color)?.hex || '#fbbf24'
    const lbl = document.createElement('div')
    lbl.className = 'bm-label'
    lbl.textContent = bm.label
    const del = document.createElement('button')
    del.className = 'bm-del'
    del.textContent = '×'
    del.dataset.tip = 'Remove bookmark'
    del.onclick = e => { e.stopPropagation(); removeBookmark(bm.value) }
    row.append(dot, lbl, del)
    row.onclick = () => view.goTo(bm.value).catch(console.error)
    sideBody.append(row)
  }
}

// === Library (shelf) ===
async function addToShelf(file) {
  const fp = fingerprint(file)
  const meta = view?.book?.metadata
  const title = metaText(meta?.title) || file.name.replace(/\.[^.]+$/, '')
  const author = metaText(meta?.creator) || metaText(meta?.author)
  const entry = {
    fingerprint: fp, title, author,
    cfi: view?.lastLocation?.cfi || null,
    fraction: view?.lastLocation?.fraction ?? null,
    openedAt: Date.now(),
  }
  const idx = state.shelf.findIndex(s => s.fingerprint === fp)
  if (idx >= 0) state.shelf[idx] = { ...state.shelf[idx], ...entry }
  else state.shelf.unshift(entry)
  save()
  try { await idbPut({ fingerprint: fp, blob: file }) } catch (e) { console.warn('IDB put failed:', e) }
}

let shelfSaveTimer
function debouncedShelfSave() {
  if (!lastFingerprint || !view?.lastLocation) return
  clearTimeout(shelfSaveTimer)
  shelfSaveTimer = setTimeout(() => {
    const item = state.shelf.find(s => s.fingerprint === lastFingerprint)
    if (!item) return
    item.cfi = view.lastLocation.cfi
    item.fraction = view.lastLocation.fraction
    item.openedAt = Date.now()
    save()
    if (state.sideMode === 'shelf') renderShelf()
  }, 800)
}

async function reloadFromShelf(fp) {
  const rec = await idbGet(fp)
  if (!rec?.blob) {
    state.shelf = state.shelf.filter(s => s.fingerprint !== fp)
    save(); renderShelf()
    alert('This book is no longer in your library (file gone). Open it again to re-add.')
    return
  }
  const item = state.shelf.find(s => s.fingerprint === fp)
  await open(rec.blob, { restoreCfi: item?.cfi, restoreFraction: item?.fraction })
}

async function removeFromShelf(fp) {
  state.shelf = state.shelf.filter(s => s.fingerprint !== fp)
  if (lastFingerprint === fp) lastFingerprint = null
  save()
  try { await idbDel(fp) } catch {}
  renderShelf()
  renderDropShelf()
}

function populateShelfList(container, sorted) {
  container.innerHTML = ''
  for (const item of sorted) {
    const row = document.createElement('div')
    row.className = 'shelf-item'
    const title = document.createElement('div')
    title.className = 'shelf-title'
    title.textContent = item.title
    const meta = document.createElement('div')
    meta.className = 'shelf-meta'
    meta.textContent = `${item.author || 'Unknown'} · ${relativeTime(item.openedAt)}`
    const bar = document.createElement('div')
    bar.className = 'shelf-bar'
    const fill = document.createElement('div')
    fill.className = 'shelf-bar-fill'
    fill.style.width = `${Math.round((item.fraction || 0) * 100)}%`
    bar.append(fill)
    const del = document.createElement('button')
    del.className = 'shelf-del'
    del.textContent = '×'
    del.dataset.tip = 'Remove from library'
    del.onclick = e => { e.stopPropagation(); removeFromShelf(item.fingerprint) }
    row.append(title, meta, bar, del)
    row.onclick = () => reloadFromShelf(item.fingerprint).catch(err =>
      alert('Failed to reload: ' + err.message))
    container.append(row)
  }
}

function renderShelf() {
  sideTitle.textContent = 'Library'
  sideBody.innerHTML = ''
  if (!state.shelf.length) {
    const empty = document.createElement('div')
    empty.id = 'shelf-empty'
    empty.textContent = 'No books yet.\nOpen one to add it here.'
    sideBody.append(empty)
    return
  }
  populateShelfList(sideBody, [...state.shelf].sort((a, b) => b.openedAt - a.openedAt))
}

function relativeTime(ts) {
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)}m ago`
  if (d < 86400) return `${Math.round(d / 3600)}h ago`
  return `${Math.round(d / 86400)}d ago`
}

function renderDropShelf() {
  const host = $('#drop-shelf')
  const empty = $('#home-shelf-empty')
  if (!state.shelf.length) {
    if (host) host.innerHTML = ''
    if (empty) empty.hidden = false
    return
  }
  if (empty) empty.hidden = true
  populateShelfList(host, [...state.shelf].sort((a, b) => b.openedAt - a.openedAt))
  const header = document.createElement('div')
  header.className = 'drop-shelf-header'
  header.textContent = '📚 Library'
  host.insertBefore(header, host.firstChild)
}

// === TTS (backend edge-tts via /api/tts, plays as <audio> blob) ===
let ttsAudio = null
let ttsPanel = null
let ttsCurrentBlobUrl = null
let ttsAbort = null
let ttsVoice = 'zh-CN-XiaoxiaoNeural'
let ttsAvailableVoices = []

function ttsCurrentText() {
  if (!view?.renderer) return ''
  const contents = view.renderer.getContents()
  const primary = contents.find(c => c.index === view.renderer.primaryIndex) ?? contents[0]
  if (!primary?.doc) return ''
  // Use user selection if any, else the visible body text
  const sel = primary.doc.getSelection?.()
  const text = (sel?.toString() || primary.doc.body?.innerText || '').trim()
  return text.slice(0, 4000)  // cap at 4K chars per request
}

function rateFromSlider() {
  const r = parseFloat(document.querySelector('#tts-rate')?.value || 1)
  if (r === 1) return '+0%'
  return (r > 1 ? '+' : '') + Math.round((r - 1) * 100) + '%'
}

async function speak() {
  const text = ttsCurrentText()
  if (!text) return
  if (ttsAbort) ttsAbort.abort()
  ttsAbort = new AbortController()
  // Show "Loading…" state in play button
  const playBtn = document.querySelector('#tts-play')
  if (playBtn) playBtn.textContent = '⏳'
  try {
    const url = `/api/tts?${new URLSearchParams({
      text, voice: ttsVoice, rate: rateFromSlider(),
    })}`
    const res = await fetch(url, { signal: ttsAbort.signal })
    if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`)
    const blob = await res.blob()
    if (!blob.size) throw new Error('empty audio')
    if (ttsCurrentBlobUrl) URL.revokeObjectURL(ttsCurrentBlobUrl)
    ttsCurrentBlobUrl = URL.createObjectURL(blob)
    ttsAudio = new Audio(ttsCurrentBlobUrl)
    ttsAudio.onended = () => {
      if (playBtn) playBtn.textContent = '▶'
      if (state.ttsActive) view.next().then(() => speak())
    }
    ttsAudio.onerror = () => {
      if (playBtn) playBtn.textContent = '▶'
    }
    await ttsAudio.play()
    if (playBtn) playBtn.textContent = '⏸'
  } catch (e) {
    if (e.name === 'AbortError') return
    // Backend edge-tts unavailable or returned empty audio — fall back to
    // the browser's built-in Web Speech API so the reader is never silent.
    if (playBtn) playBtn.textContent = '⏸'
    const u = new SpeechSynthesisUtterance(text)
    const r = parseFloat(document.querySelector('#tts-rate')?.value || 1)
    u.rate = r
    u.onend = () => {
      if (playBtn) playBtn.textContent = '▶'
      if (state.ttsActive) view.next().then(() => speak())
    }
    u.onerror = () => { if (playBtn) playBtn.textContent = '▶' }
    ttsUtterance = u
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  }
}
let ttsUtterance = null

function toggleTts() {
  if (!view) return
  // Pause/resume the Web Speech fallback if that's what's playing.
  if (speechSynthesis.speaking && !speechSynthesis.paused) {
    speechSynthesis.pause()
    const pb = document.querySelector('#tts-play'); if (pb) pb.textContent = '▶'
    return
  }
  if (speechSynthesis.paused) {
    speechSynthesis.resume()
    const pb = document.querySelector('#tts-play'); if (pb) pb.textContent = '⏸'
    return
  }
  if (ttsAudio && !ttsAudio.paused && !ttsAudio.ended) {
    ttsAudio.pause()
    const playBtn = document.querySelector('#tts-play')
    if (playBtn) playBtn.textContent = '▶'
    return
  }
  if (ttsAudio && ttsAudio.paused) {
    ttsAudio.play()
    const playBtn = document.querySelector('#tts-play')
    if (playBtn) playBtn.textContent = '⏸'
    return
  }
  state.ttsActive = true
  speak()
}

function stopTts() {
  state.ttsActive = false
  if (ttsAbort) ttsAbort.abort()
  if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = '' }
  if (ttsCurrentBlobUrl) { URL.revokeObjectURL(ttsCurrentBlobUrl); ttsCurrentBlobUrl = null }
  if (speechSynthesis.speaking || speechSynthesis.paused) speechSynthesis.cancel()
  ttsAudio = null
  removeTtsPanel()
}

async function loadVoices() {
  try {
    const res = await fetch('/api/voices')
    if (!res.ok) return
    ttsAvailableVoices = await res.json()
    if (state.ttsVoice) ttsVoice = state.ttsVoice
  } catch (e) { /* backend not running — that's OK */ }
}

function showTtsPanel() {
  if (ttsPanel) return
  ttsPanel = document.createElement('div')
  ttsPanel.id = 'tts-panel'
  // Build voice selector + controls
  const voiceSelect = document.createElement('select')
  voiceSelect.id = 'tts-voice'
  voiceSelect.dataset.tip = 'Voice (Microsoft Edge)'
  voiceSelect.style.cssText = 'background: var(--hover); color: var(--fg); border: 1px solid var(--glass-border); border-radius: 999px; padding: 4px 8px; font: inherit; outline: none; max-width: 160px;'
  for (const v of ttsAvailableVoices.slice(0, 50)) {  // cap for sanity
    const opt = document.createElement('option')
    opt.value = v.short
    opt.textContent = `${v.friendly.replace(/^Microsoft\s+/, '').replace(/Online\s+\(Natural\)\s*$/, '').trim()} · ${v.locale}`
    if (v.short === ttsVoice) opt.selected = true
    voiceSelect.append(opt)
  }
  if (!ttsAvailableVoices.length) {
    const opt = document.createElement('option')
    opt.value = ttsVoice; opt.textContent = 'Loading…'
    voiceSelect.append(opt)
  }

  const mkBtn = (id, label, tip) => {
    const b = document.createElement('button')
    b.id = id; b.textContent = label; b.dataset.tip = tip
    return b
  }
  const prev = mkBtn('tts-prev', '⏮', 'Previous page')
  const play = mkBtn('tts-play', '⏸', 'Pause / Resume')
  const next = mkBtn('tts-next', '⏭', 'Next page')
  const stop = mkBtn('tts-stop', '⏹', 'Stop')
  const rate = document.createElement('input')
  rate.id = 'tts-rate'; rate.type = 'range'; rate.min = '0.5'; rate.max = '2'
  rate.step = '0.1'; rate.value = '1'; rate.dataset.tip = 'Playback rate'
  if (state.ttsRate) rate.value = state.ttsRate

  ttsPanel.append(voiceSelect, prev, play, next, stop, rate)
  document.body.append(ttsPanel)

  voiceSelect.onchange = () => {
    ttsVoice = voiceSelect.value
    state.ttsVoice = ttsVoice; save()
    if (ttsAudio && !ttsAudio.paused) { ttsAudio.pause(); speak() }
  }
  play.onclick = toggleTts
  prev.onclick = () => { if (ttsAudio) ttsAudio.pause(); view.prev().then(() => speak()) }
  next.onclick = () => { if (ttsAudio) ttsAudio.pause(); view.next().then(() => speak()) }
  stop.onclick = stopTts
  rate.oninput = () => { state.ttsRate = rate.value; save() }
}

function removeTtsPanel() {
  if (ttsPanel) { ttsPanel.remove(); ttsPanel = null }
}

// === Toolbar actions ===
const setZoom = z => { state.zoom = snapZoom(z); updateToolbar(); applyRenderer(); save() }
const zoomIn = () => setZoom(state.zoom * 1.2)
const zoomOut = () => setZoom(state.zoom / 1.2)
const toggleSpread = () => { state.spread = state.spread === 1 ? 2 : 1; updateToolbar(); applyRenderer(); save() }
const cycleFit = () => { state.fitMode = state.fitMode === 'width' ? 'page' : 'width'; updateToolbar(); applyRenderer(); save() }
const cycleTheme = () => { state.theme = THEME_CYCLE[(THEME_CYCLE.indexOf(state.theme) + 1) % 3]; applyTheme(); updateToolbar(); applyRenderer(); save() }
const cycleFontFamily = () => {
  const i = FONT_FAMILY_KEYS.indexOf(state.fontFamily)
  state.fontFamily = FONT_FAMILY_KEYS[(i + 1) % FONT_FAMILY_KEYS.length]
  updateToolbar(); applyRenderer(); save()
}
const cycleFontSize = () => {
  const order = Object.keys(FONT_SIZES)
  const i = order.indexOf(state.fontSize)
  state.fontSize = order[(i + 1) % order.length]
  updateToolbar(); applyRenderer(); save()
}

readerEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const a = b.dataset.act
  if (a === 'open') return file.click()
  if (a === 'side-close') return closeSide()
  if (!view) return
  switch (a) {
    case 'prev': view.goLeft(); break
    case 'next': view.goRight(); break
    case 'spread': toggleSpread(); break
    case 'fit': cycleFit(); break
    case 'zoom-in': zoomIn(); break
    case 'zoom-out': zoomOut(); break
    case 'theme': cycleTheme(); break
    case 'font-family': cycleFontFamily(); break
    case 'font-size': cycleFontSize(); break
    case 'toc': openSide(state.sideMode === 'toc' ? null : 'toc'); break
    case 'search': openSide(state.sideMode === 'search' ? null : 'search'); break
    case 'bookmark':
      // Only toggle the bookmarks side panel — actual bookmark creation
      // happens via the in-page "Add bookmark" indicator (see showBmFab).
      openSide(state.sideMode === 'bookmarks' ? null : 'bookmarks')
      break
    case 'tts': showTtsPanel(); toggleTts(); break
    case 'shelf': openSide(state.sideMode === 'shelf' ? null : 'shelf'); break
  }
})

document.addEventListener('keydown', e => {
  if (!view || readerEl.hidden) return
  if (e.target.matches('input, textarea')) return
  switch (e.key) {
    case 'ArrowLeft': case 'ArrowUp': case 'h': view.goLeft(); break
    case 'ArrowRight': case 'ArrowDown': case 'l': view.goRight(); break
    case '+': case '=': zoomIn(); break
    case '-': zoomOut(); break
    case 's': toggleSpread(); break
    case 'w': cycleFit(); break
    case 't': cycleTheme(); break
    case 'f': cycleFontFamily(); break
    case 'o': file.click(); break
    case 'c': openSide(state.sideMode === 'toc' ? null : 'toc'); break
    case '/': e.preventDefault(); openSide('search'); break
    case 'b': openSide('bookmarks'); break
    case 'r': toggleTts(); break
    case 'Escape': closeSide(); break
  }
  if (e.key === 'L' && e.shiftKey && view) openSide(state.sideMode === 'shelf' ? null : 'shelf')
})

file.addEventListener('change', e => {
  const f = e.target.files[0]
  if (f) open(f, { file: f }).catch(err => alert('打开失败: ' + err.message))
  e.target.value = ''
})

loc.addEventListener('input', e => {
  if (!view) return
  const v = parseFloat(e.target.value)
  if (Number.isFinite(v)) view.goToFraction(v)
})

$('#pick').addEventListener('click', () => file.click())

document.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover') })
document.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('dragover') })
document.addEventListener('drop', e => {
  e.preventDefault()
  drop.classList.remove('dragover')
  const f = e.dataTransfer?.files?.[0]
  if (f) open(f, { file: f }).catch(err => alert('打开失败: ' + err.message))
})

applyTheme()
updateToolbar()
renderDropShelf()

// Click zones (left/right edges turn pages, like Kindle)
$('#click-prev').addEventListener('click', () => view?.goLeft())
$('#click-next').addEventListener('click', () => view?.goRight())

// Optional: open a file from URL on load (e.g. ?url=/book.epub)
const _url = new URLSearchParams(location.search).get('url')
if (_url) open(_url).catch(err => alert('打开失败: ' + err.message))

// Auto-restore: if we have a most-recent shelf entry and its blob is still
// in IDB, re-open it so the reader picks up where the user left off.
if (!_url && state.shelf.length) {
  const last = [...state.shelf].sort((a, b) => b.openedAt - a.openedAt)[0]
  idbGet(last.fingerprint).then(rec => {
    if (rec?.blob) {
      lastFingerprint = last.fingerprint
      open(rec.blob, { restoreCfi: last.cfi, restoreFraction: last.fraction })
        .catch(err => console.warn('auto-restore failed:', err))
    }
  }).catch(() => { /* IDB unavailable — fine, user picks a book */ })
}
