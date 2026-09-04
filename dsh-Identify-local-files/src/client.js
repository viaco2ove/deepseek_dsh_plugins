// dsh-Identify-local-files — client half (browser).
// Core goal: intercept paste/drag events, upload files to the host, insert
// file-reference chips into the composer, WITHOUT letting the official attachment
// channel see the event (which would trigger "仅支持PNG、JPG、WebP、GIF").
//
// Three layers:
//   1. Paste interceptor  — capture-phase listener, ALL file types consumed.
//   2. Drag-drop overlay  — full-screen capture via dragenter/dragover/drop.
//   3. Composer chip      — input.insertReference() for proper chip rendering,
//                           plus inputTriggers source registration so chips
//                           serialise through the trigger pipeline.

window.__ModuleLoader__.load({ id: "dsh-Identify-local-files", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";

// ─── Module imports ────────────────────────────────────────────────────────────

const react = require("react")

// ─── Constants ─────────────────────────────────────────────────────────────────

const SOURCE = 'identify-local-files'
const PLUGIN_ID = 'dsh-Identify-local-files'

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS_TEXT = `
.dsh-ilf-overlay {
  position: fixed; inset: 0; z-index: 99998;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.45); color: #fff;
  font-size: 18px; font-weight: 600;
  pointer-events: none; user-select: none;
  backdrop-filter: blur(2px);
  border-radius: 4px;
}
`

let cssInjected = false
function ensureCss() {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
}

// ─── Upload helper ─────────────────────────────────────────────────────────────

async function uploadFile(file) {
  const form = new FormData()
  form.append('file', file, file.name || 'pasted-file')
  const res = await fetch('/plugins/dsh-Identify-local-files/temp-upload', {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`upload failed (${res.status}): ${text || res.statusText}`)
  }
  return await res.json() // { path, originalName, bytes, ... }
}

// ─── Text file inline content ─────────────────────────────────────────────────

const INLINE_TEXT_LIMIT = 8192

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.json5', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.js', '.mjs', '.cjs', '.ts',
  '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.less', '.svg',
  '.xml', '.csv', '.tsv', '.log', '.diff', '.patch', '.properties',
])

function isTextFile(file) {
  if (typeof file.type === 'string' && file.type !== '') {
    if (file.type.startsWith('text/')) return true
    if (file.type === 'application/json') return true
    if (file.type.startsWith('application/javascript')) return true
    if (file.type.startsWith('image/') || file.type.startsWith('audio/') || file.type.startsWith('video/')) return false
  }
  const dot = file.name.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTENSIONS.has(file.name.slice(dot).toLowerCase())
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function baseName(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

// ─── insertReference — chip via official API ───────────────────────────────────

// Retry wrapper that polls until the composer is ready (phases: plain | claimed).
async function withInput(fn) {
  const MAX_WAIT = 4000
  const POLL = 200
  const deadline = Date.now() + MAX_WAIT
  while (Date.now() < deadline) {
    const actx = activeActx()
    if (actx === null) { await sleep(POLL); continue }
    const conversation = actx.get('conversation')
    if (conversation === undefined) { await sleep(POLL); continue }
    const input = conversation.input.for(actx)
    if (input === undefined) { await sleep(POLL); continue }
    const phase = (() => { try { return input.state.getSnapshot().phase } catch (_) { return null } })()
    if (phase !== 'plain' && phase !== 'claimed') { await sleep(POLL); continue }
    return fn(input)
  }
  return null
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function activeActx() {
  const sessions = globalCtx && globalCtx.get('sessions')
  if (sessions === undefined) return null
  const list = typeof sessions.list === 'function' ? sessions.list() : []
  return sessions.scope(list[0]?.id ?? '')
}

let globalCtx = null

function insertChipRef(input, file) {
  const label = baseName(file.path)
  const st = input.state.getSnapshot()
  const pos = st.draft.length
  const ok = input.insertReference(
    { source: SOURCE, ref: file.path, label, clipboardText: file.path },
    { start: pos, end: pos, draftRev: st.draftRev },
  )
  return ok
}

function insertPlainText(input, text) {
  try {
    const st = input.state.getSnapshot()
    input.insertText(text, { start: st.draft.length, end: st.draft.length, draftRev: st.draftRev })
    return true
  } catch (_) { return false }
}

// ─── Drag state (shared, no React) ───────────────────────────────────────────

const dragState = { active: false }

// ─── Drag overlay (imperative DOM, no React) ─────────────────────────────────

let overlayEl = null

function showOverlay() {
  if (overlayEl && overlayEl.isConnected) return
  ensureCss()
  overlayEl = document.createElement('div')
  overlayEl.className = 'dsh-ilf-overlay'
  overlayEl.textContent = '松开以接收文件'
  document.body.appendChild(overlayEl)
  dragState.active = true
}

function hideOverlay() {
  if (overlayEl && overlayEl.isConnected) { overlayEl.remove(); overlayEl = null }
  dragState.active = false
}

// ─── Process files from paste or drop ────────────────────────────────────────

async function processFiles(files) {
  for (const file of files) {
    try {
      const uploaded = await uploadFile(file)

      if (isTextFile(file)) {
        // Inline text: fetch content and insert as text chunk.
        await withInput(input => {
          let text
          try { text = `[file: ${baseName(uploaded.path)} — path: ${uploaded.path}]\n` } catch (_) { text = `[file: ${uploaded.path}]\n` }
          return insertPlainText(input, text)
        })
      } else {
        // Binary / image / any: insert chip reference.
        await withInput(input => insertChipRef(input, uploaded))
      }
    } catch (err) {
      console.error('[dsh-Identify-local-files] upload error:', err && err.message ? err.message : err)
    }
  }
}

// ─── Paste interceptor ────────────────────────────────────────────────────────

function attachPasteListener() {
  const onPaste = (event) => {
    const clipboardData = event.clipboardData
    if (clipboardData === null) return

    const items = Array.from(clipboardData.items)
    const fileItems = items.filter(item => item.kind === 'file')
    if (fileItems.length === 0) return

    const files = fileItems.map(item => item.getAsFile()).filter(Boolean)
    if (files.length === 0) return

    // CRITICAL: preventDefault + stopImmediatePropagation in capture phase.
    // This keeps the event from reaching the official attachment channel,
    // which would throw "仅支持PNG、JPG、WebP、GIF" for non-image files.
    event.preventDefault()
    event.stopImmediatePropagation()

    void processFiles(files)
  }

  document.addEventListener('paste', onPaste, true)
  return () => document.removeEventListener('paste', onPaste, true)
}

// ─── Drag-drop interceptor ─────────────────────────────────────────────────────

function attachDragListeners() {
  const hasFiles = e => {
    const types = e.dataTransfer && e.dataTransfer.types
    return !!(types && Array.from(types).some(t => t === 'Files'))
  }

  const onDragEnter = e => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); showOverlay() } }
  const onDragOver   = e => { if (hasFiles(e)) { e.preventDefault(); e.stopImmediatePropagation() } }
  const onDragLeave  = e => {
    if (!hasFiles(e)) return
    e.preventDefault(); e.stopPropagation()
    // Only hide if leaving the overlay itself (not child elements).
    if (overlayEl && !overlayEl.contains(e.relatedTarget)) hideOverlay()
  }
  const onDrop = e => {
    e.preventDefault(); e.stopImmediatePropagation()
    hideOverlay()
    if (!hasFiles(e)) return
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
    if (files.length === 0) return
    void processFiles(files)
  }

  document.addEventListener('dragenter', onDragEnter, true)
  document.addEventListener('dragover',  onDragOver,  true)
  document.addEventListener('dragleave', onDragLeave, true)
  document.addEventListener('drop',      onDrop,      true)

  return () => {
    document.removeEventListener('dragenter', onDragEnter, true)
    document.removeEventListener('dragover',  onDragOver,  true)
    document.removeEventListener('dragleave', onDragLeave, true)
    document.removeEventListener('drop',      onDrop,      true)
  }
}

// ─── Plugin apply ─────────────────────────────────────────────────────────────

function apply(ctx) {
  globalCtx = ctx

  // 1) Register the chip source so chips survive submit serialisation.
  const inputTriggers = ctx.get('inputTriggers')
  if (inputTriggers !== undefined) {
    ctx.effect(() => inputTriggers.registerSource({
      trigger: '@',
      name: SOURCE,
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      codec: {
        clipboardText: (ref) => ref,
        serialize: (ref) => Promise.resolve(ref),
      },
    }), `${PLUGIN_ID}: trigger source`)
  }

  // 2) Intercept paste events (capture phase, all file types).
  const unlistenPaste = attachPasteListener()

  // 3) Intercept drag-drop (full-screen overlay).
  const unlistenDrag = attachDragListeners()

  // 4) Cleanup on unload.
  ctx.effect(() => () => {
    unlistenPaste()
    unlistenDrag()
    hideOverlay()
  })
}

module.exports = {
  apply,
  inject: ["slots", "sessions", "inputTriggers"],
};
return module.exports;
}});
