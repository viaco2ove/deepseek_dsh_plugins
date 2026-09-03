// dsh-Identify-local-files — client half (browser).
// Three surfaces:
//   1. Composer dock: a `+` button that opens a panel.
//   2. The panel accepts paste, file-drop, or clipboard images. Each accepted
//      file is uploaded to the host's /plugins/.../temp-upload route, the host
//      stores it under ~/.dsh/.temp/, and the client drops a
//      `[file: <name> | /absolute/path]` line into the Composer. The Agent can
//      then call `read_local_file` on that path to actually read the bytes.
//   3. A plain-text paste interceptor is kept as a fallback for users who copy
//      file bytes from a text editor instead of an OS file manager.

window.__ModuleLoader__.load({ id: "dsh-Identify-local-files", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";

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

function formatBaseName(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return slash >= 0 ? name.slice(slash + 1) : name
}

// ─── composer insertion ──────────────────────────────────────────────────────

function insertIntoComposer(actx, text) {
  const conversation = actx.get('conversation')
  if (conversation === undefined) {
    console.warn('[dsh-Identify-local-files] conversation service unavailable')
    return
  }
  const input = conversation.input.for(actx)
  const state = input.state.getSnapshot()
  actx.emit('slash/input-insert-text', {
    text,
    span: { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev },
  })
}

/** Pick the actx for the active conversation. The same scope the dock sees. */
function activeActx(ctx) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return null
  const list = typeof sessions.list === 'function' ? sessions.list() : []
  return sessions.scope(list[0]?.id ?? '')
}

// ─── file upload to host ────────────────────────────────────────────────────

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
  return await res.json()
}

function buildFileAnnotation(uploaded, kind) {
  // kind: "text" | "image" | "binary"
  const name = formatBaseName(uploaded.originalName || uploaded.name || 'file')
  const bytes = uploaded.bytes
  const path = uploaded.path
  if (kind === 'image') return `[image: ${name} (${formatBytes(bytes)}) — path: ${path}]`
  if (kind === 'text') return `[file: ${name} (${formatBytes(bytes)}) — path: ${path}]`
  return `[binary: ${name} (${formatBytes(bytes)}) — path: ${path}]`
}

function kindOf(file) {
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return 'image'
  if (isTextFile(file)) return 'text'
  return 'binary'
}

async function ingestFiles(ctx, files, announce) {
  const actx = activeActx(ctx)
  if (actx === null) {
    console.warn('[dsh-Identify-local-files] sessions service unavailable')
    return
  }
  const lines = []
  for (const file of files) {
    try {
      announce?.({ stage: 'uploading', name: file.name })
      const uploaded = await uploadFile(file)
      const kind = kindOf(file)
      lines.push(buildFileAnnotation(uploaded, kind))
      announce?.({ stage: 'done', name: file.name, path: uploaded.path })
    } catch (err) {
      announce?.({ stage: 'failed', name: file.name, error: String(err?.message ?? err) })
    }
  }
  if (lines.length === 0) return
  insertIntoComposer(actx, `\n${lines.join('\n')}\n`)
}

// ─── React UI: button + panel ────────────────────────────────────────────────

let react = null
let jsxRuntime = null
try { react = require('react') } catch (e) { /* React must be provided by the host runtime */ }
try { jsxRuntime = require('react/jsx-runtime') } catch (e) { /* same */ }

if (react === null || jsxRuntime === null) {
  // Without React we cannot render the button; log loudly so a developer notices.
  console.warn('[dsh-Identify-local-files] react not available; UI panel disabled (paste interceptor still active)')
}

const PLUGIN_TAG = 'dsh-Identify-local-files/Panel.module.css'
const CSS_TEXT = `
.dsh-ilf-button {
  width: 32px; height: 32px; border-radius: 16px;
  background: var(--dsw-specific-input-major, #f3f3f3);
  color: var(--dsw-alias-label-secondary, #555);
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, #d0d0d0);
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .15s ease, color .15s ease, transform .1s ease;
}
.dsh-ilf-button:hover { background: var(--dsw-alias-interactive-bg-hover, #e8e8e8); color: var(--dsw-alias-label-primary, #222); }
.dsh-ilf-button[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover-solid, #d8e8ff); color: var(--dsw-alias-label-primary, #222); }
.dsh-ilf-panel {
  width: 360px; max-width: 90vw;
  background: var(--dsw-specific-input-major, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, #d0d0d0);
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv2, 0 8px 32px rgba(0,0,0,0.12));
  padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
  font-size: 13px; line-height: 1.4;
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-ilf-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  font-weight: 500;
}
.dsh-ilf-panel-header button {
  background: transparent; border: none; cursor: pointer; color: inherit; font-size: 18px; line-height: 1;
}
.dsh-ilf-drop {
  border: 2px dashed var(--dsw-alias-border-l2, #c0c0c0);
  border-radius: 8px;
  padding: 18px; text-align: center;
  color: var(--dsw-alias-label-tertiary, #777);
  transition: background .15s ease, border-color .15s ease;
}
.dsh-ilf-drop[data-drag="true"] {
  background: var(--dsw-alias-interactive-bg-hover, #eef5ff);
  border-color: var(--dsw-alias-label-secondary, #88a);
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-ilf-row {
  display: flex; gap: 8px; align-items: center;
}
.dsh-ilf-row button {
  flex: 1; padding: 8px 10px;
  background: var(--dsw-alias-interactive-bg-hover, #f1f1f1);
  color: var(--dsw-alias-label-primary, #222);
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, #d0d0d0);
  border-radius: 8px; cursor: pointer; font: inherit;
}
.dsh-ilf-row button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid, #e3e3e3);
}
.dsh-ilf-row button:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-ilf-list {
  max-height: 160px; overflow: auto; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, #e0e0e0);
  border-radius: 6px;
  background: var(--dsw-alias-bg-module-platform, #fafafa);
}
.dsh-ilf-list-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; }
.dsh-ilf-list-item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ilf-list-item[data-stage="uploading"] .name { color: var(--dsw-alias-label-tertiary, #888); }
.dsh-ilf-list-item[data-stage="done"] .name { color: var(--dsw-alias-label-primary, #222); }
.dsh-ilf-list-item[data-stage="failed"] .name { color: var(--dsw-alias-state-error-primary, #c0392b); }
.dsh-ilf-icon { width: 16px; height: 16px; flex: none; display: inline-block; }
.dsh-ilf-hint { color: var(--dsw-alias-label-tertiary, #777); font-size: 12px; line-height: 1.5; }
`

function ensureCssInjected() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${PLUGIN_TAG}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-Identify-local-files'
  tag.dataset.pluginCss = PLUGIN_TAG
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
}

function PlusIcon() {
  // Inline SVG; keep it dependency-free so the build is portable.
  return jsxRuntime.jsx('svg', {
    className: 'dsh-ilf-icon',
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    children: [
      jsxRuntime.jsx('path', { d: 'M8 3v10' }),
      jsxRuntime.jsx('path', { d: 'M3 8h10' }),
    ],
  })
}

function makePanel(ctx) {
  ensureCssInjected()
  const useState = react.useState
  const useEffect = react.useEffect
  const useRef = react.useRef

  function Panel({ onClose }) {
    const [items, setItems] = useState([])
    const [drag, setDrag] = useState(false)
    const fileInputRef = useRef(null)

    const announce = (entry) => {
      setItems((prev) => {
        const idx = prev.findIndex((p) => p.name === entry.name && p.stage !== 'done' && p.stage !== 'failed')
        if (idx < 0) return [...prev, { id: Math.random().toString(36).slice(2), ...entry }]
        const next = prev.slice()
        next[idx] = { ...next[idx], ...entry }
        return next
      })
    }

    const handleFiles = async (fileList) => {
      const files = Array.from(fileList ?? [])
      if (files.length === 0) return
      await ingestFiles(ctx, files, announce)
    }

    const onPickClick = () => fileInputRef.current?.click()

    const onPickChange = (e) => {
      handleFiles(e.target.files).then(() => { e.target.value = '' })
    }

    const onPasteClick = async () => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
        announce({ stage: 'failed', name: 'clipboard', error: 'clipboard read unavailable' })
        return
      }
      try {
        const items = await navigator.clipboard.read()
        const files = []
        for (const item of items) {
          for (const type of item.types) {
            if (type === 'text/plain' || type === 'text/html') continue
            const blob = await item.getType(type).catch(() => null)
            if (blob === null) continue
            const ext = type.split('/')[1]?.split(';')[0] ?? 'bin'
            files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }))
            break
          }
        }
        if (files.length === 0) {
          announce({ stage: 'failed', name: 'clipboard', error: 'no image on clipboard' })
          return
        }
        await handleFiles(files)
      } catch (err) {
        announce({ stage: 'failed', name: 'clipboard', error: String(err?.message ?? err) })
      }
    }

    const onDragOver = (e) => {
      e.preventDefault()
      setDrag(true)
    }
    const onDragLeave = () => setDrag(false)
    const onDrop = (e) => {
      e.preventDefault()
      setDrag(false)
      handleFiles(e.dataTransfer?.files)
    }

    return jsxRuntime.jsx('div', {
      className: 'dsh-ilf-panel',
      role: 'dialog',
      'aria-label': 'Identify local files',
      onDragOver,
      onDragLeave,
      onDrop,
      children: [
        jsxRuntime.jsxs('div', {
          className: 'dsh-ilf-panel-header',
          children: [
            jsxRuntime.jsx('span', { children: 'Identify local files' }),
            jsxRuntime.jsx('button', {
              type: 'button',
              'aria-label': 'close',
              onClick: onClose,
              children: '\u00d7',
            }),
          ],
        }),
        jsxRuntime.jsx('div', {
          className: 'dsh-ilf-drop',
          'data-drag': drag ? 'true' : 'false',
          onClick: onPickClick,
          children: jsxRuntime.jsx('span', { children: 'Click here, or drop files to attach' }),
        }),
        jsxRuntime.jsx('div', {
          className: 'dsh-ilf-row',
          children: [
            jsxRuntime.jsx('button', {
              type: 'button',
              onClick: onPickClick,
              children: 'Choose files',
            }),
            jsxRuntime.jsx('button', {
              type: 'button',
              onClick: onPasteClick,
              children: 'From clipboard image',
            }),
          ],
        }),
        jsxRuntime.jsx('input', {
          ref: fileInputRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: onPickChange,
        }),
        jsxRuntime.jsx('div', {
          className: 'dsh-ilf-hint',
          children: 'Files are saved to ~/.dsh/.temp/ and inserted as read_local_file paths. The Agent reads them on demand.',
        }),
        items.length > 0 && jsxRuntime.jsx('div', {
          className: 'dsh-ilf-list',
          children: items.map((item) => jsxRuntime.jsx('div', {
            className: 'dsh-ilf-list-item',
            'data-stage': item.stage,
            children: [
              jsxRuntime.jsx('span', {
                className: 'name',
                children: item.stage === 'failed'
                  ? `${item.name} — ${item.error ?? 'failed'}`
                  : item.stage === 'uploading'
                    ? `${item.name} — uploading…`
                    : `${item.name} — ${item.path}`,
              }),
            ],
          }, item.id)),
        }),
      ],
    })
  }

  return Panel
}

// ─── plain-text paste interceptor (fallback) ─────────────────────────────────

function installPasteInterceptor(ctx) {
  const onPaste = (event) => {
    const clipboardData = event.clipboardData ?? null
    if (clipboardData === null) return
    const files = Array.from(clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file) => file !== null)
    if (files.length === 0) return

    const others = files.filter((file) => !(typeof file.type === 'string' && file.type.startsWith('image/')))
    if (others.length === 0) return // pure image paste: let the official channel run

    event.preventDefault()
    event.stopImmediatePropagation()

    void (async () => {
      const parts = []
      for (const file of others) {
        try {
          if (isTextFile(file)) {
            const text = await file.text()
            if (text.length <= INLINE_TEXT_LIMIT) {
              parts.push(`[file: ${file.name}]\n${text}`)
            } else {
              parts.push(`[file: ${file.name} — first ${INLINE_TEXT_LIMIT} chars of ${text.length}]\n${text.slice(0, INLINE_TEXT_LIMIT)}\n…[truncated]`)
            }
          } else {
            parts.push(`[file: ${file.name} (${formatBytes(file.size)}) — non-text]`)
          }
        } catch (err) {
          parts.push(`[file: ${file.name} — read failed: ${String(err?.message ?? err)}]`)
        }
      }
      const joined = parts.join('\n\n')
      if (joined === '') return
      const actx = activeActx(ctx)
      if (actx === null) return
      insertIntoComposer(actx, `\n${joined}\n`)
    })()
  }

  document.addEventListener('paste', onPaste, { capture: true })
  ctx.effect(() => () => document.removeEventListener('paste', onPaste, { capture: true }))
}

// ─── composer-dock entry ─────────────────────────────────────────────────────

function apply(ctx) {
  // Always keep the plain-text paste fallback on (works without React).
  installPasteInterceptor(ctx)

  if (react === null || jsxRuntime === null) return

  const Panel = makePanel(ctx)
  const useState = react.useState
  const useEffect = react.useEffect
  const createPortal = (() => {
    try { return require('react-dom')?.createPortal } catch (e) { return null }
  })()

  function DockEntry({ useSession, t }) {
    const [open, setOpen] = useState(false)
    const [panelPos, setPanelPos] = useState(null)
    const buttonRef = react.useRef(null)
    const panelRef = react.useRef(null)

    useEffect(() => {
      if (!open) return
      const onDocClick = (e) => {
        if (panelRef.current?.contains(e.target)) return
        if (buttonRef.current?.contains(e.target)) return
        setOpen(false)
      }
      const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDocClick)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDocClick)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    useEffect(() => {
      if (!open || buttonRef.current === null) return
      const rect = buttonRef.current.getBoundingClientRect()
      setPanelPos({ top: rect.bottom + 8, left: Math.max(8, rect.right - 360) })
    }, [open])

    const panel = open && panelPos !== null
      ? jsxRuntime.jsx('div', {
          ref: panelRef,
          className: 'dsh-ilf-panel-anchor',
          style: {
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            zIndex: 9999,
          },
          children: jsxRuntime.jsx(Panel, { onClose: () => setOpen(false) }),
        })
      : null

    return jsxRuntime.jsxs(react.Fragment, {
      children: [
        jsxRuntime.jsx('button', {
          ref: buttonRef,
          type: 'button',
          className: 'dsh-ilf-button',
          'data-active': open ? 'true' : 'false',
          'aria-label': 'Identify local files',
          title: 'Identify local files',
          onClick: () => setOpen((v) => !v),
          onMouseDown: (e) => e.preventDefault(),
          children: jsxRuntime.jsx(PlusIcon, {}),
        }),
        panel !== null && createPortal !== null
          ? createPortal(panel, document.body)
          : panel,
      ],
    })
  }

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'file-plus',
    order: 10,
    inject: (sessionId) => {
      const sessions = ctx.get('sessions')
      const actx = sessions?.scope?.(sessionId ?? '')
      return {
        activeSessionId: sessionId,
        activeActx: actx,
        addToComposer: (text) => actx !== undefined && insertIntoComposer(actx, text),
        ctx,
      }
    },
  }, DockEntry))
}

module.exports = {
  apply,
  inject: ["slots", "sessions"],
};
return module.exports;
}});