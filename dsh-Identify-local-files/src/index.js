// dsh-Identify-local-files — host half.
// Registers read_local_file so agents can read any local file by path:
// images come back as base64 data URLs, text files inline.
// Also registers a tiny HTTP route that drops uploaded/pasted files into
// ~/.dsh/.temp so the client plugin can hand them to read_local_file as
// "local" paths.

import path from 'node:path'
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Cordis plugin name — must match the row name in cordis.patch.yml. */
export const name = 'dsh-Identify-local-files'
/** Services required by this plugin. */
export const inject = ['tools', 'webServer']

const MEBIBYTE = 1024 * 1024

export const Config = z.object({
  /** Byte cap for one file read. */
  maxFileBytes: z.number().default(20 * MEBIBYTE),
  /** Byte cap for inline text returned to the model. */
  maxTextBytes: z.number().default(2 * MEBIBYTE),
  /** Byte cap for one upload to the temp store. */
  maxUploadBytes: z.number().default(20 * MEBIBYTE),
})

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.json5', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.js', '.mjs', '.cjs', '.ts',
  '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.less', '.svg',
  '.xml', '.csv', '.tsv', '.log', '.diff', '.patch', '.properties',
])

/** True when the first bytes look like text (no NUL, few control bytes). */
function looksLikeText(head) {
  let suspicious = 0
  for (const byte of head) {
    if (byte === 0) return false
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1
    if (suspicious > 4) return false
  }
  return true
}

/** Absolute path of the temp folder this plugin owns. */
function tempDir() {
  return dshHomePath('.temp')
}

/** Sanitize a file name for use inside our temp folder. */
function safeName(name) {
  const base = path.basename(name ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  if (base === '' || base === '.' || base === '..') return 'file'
  return base.slice(0, 200)
}

/** Allocate a unique temp path under ~/.dsh/.temp/<timestamp>-<rand>-<name>. */
async function allocateTempPath(name) {
  const dir = tempDir()
  await fs.mkdir(dir, { recursive: true })
  const stamp = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  return path.join(dir, `${stamp}-${rand}-${safeName(name)}`)
}

/**
 * Bounded multipart parser: reads one multipart/form-data request body off the
 * webserver stream and yields (fieldName, filename, mediaType, bytes) per file
 * part. The body ceiling is shared with the configured maxUploadBytes so a
 * runaway sender cannot fill the disk.
 */
function parseMultipart(request, boundary, ceiling) {
  const crlf = Buffer.from('\r\n')
  const sep = Buffer.from(`--${boundary}`)
  const fileParts = []
  let buffer = Buffer.alloc(0)
  let consumed = 0
  let headerBuf = Buffer.alloc(0)
  let currentField = null
  let state = 'NEED_SEP'

  const fail = (status, message) => {
    const err = new Error(message)
    err.statusCode = status
    throw err
  }

  const absorb = (chunk) => {
    consumed += chunk.length
    if (consumed > ceiling) fail(413, `upload exceeds ${ceiling}-byte limit`)
    buffer = Buffer.concat([buffer, chunk])
  }

  const findAt = (needle, offset) => {
    outer: for (let i = offset; i <= buffer.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (buffer[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }

  const parseDisposition = (raw) => {
    const match = /Content-Disposition:\s*form-data;\s*([^;\r\n]+(?:;\s*[^;\r\n]+)*)/i.exec(raw)
    if (match === null) return null
    const params = match[1]
    const nameMatch = /\sname="([^"]*)"/i.exec(params)
    const filenameMatch = /\sfilename="([^"]*)"/i.exec(params)
    return { field: nameMatch?.[1] ?? '', filename: filenameMatch?.[1] ?? null }
  }

  const parseType = (raw) => {
    const match = /Content-Type:\s*([^\r\n]+)/i.exec(raw)
    if (match === null) return 'application/octet-stream'
    return match[1].trim().split(';')[0].trim().toLowerCase()
  }

  const process = () => {
    while (true) {
      if (state === 'NEED_SEP') {
        const at = findAt(sep, 0)
        if (at < 0) return false
        buffer = buffer.subarray(at + sep.length)
        if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
          buffer = buffer.subarray(2)
          return true
        }
        if (buffer[0] === 0x0d && buffer[1] === 0x0a) buffer = buffer.subarray(2)
        state = 'NEED_HEADERS'
        continue
      }
      if (state === 'NEED_HEADERS') {
        const at = findAt(crlf, 0)
        if (at < 0) return false
        headerBuf = buffer.subarray(0, at)
        buffer = buffer.subarray(at + 2)
        const raw = headerBuf.toString('utf8')
        const disposition = parseDisposition(raw)
        if (disposition === null) fail(400, 'part missing Content-Disposition')
        currentField = { field: disposition.field, filename: disposition.filename, mediaType: parseType(raw) }
        state = 'IN_PART'
        continue
      }
      if (state === 'IN_PART') {
        const end = findAt(sep, 0)
        if (end < 0) return false
        const body = buffer.subarray(0, end)
        buffer = buffer.subarray(end)
        // Drop the separator and the following CRLF or "--".
        if (buffer.length >= sep.length + 2 && buffer[sep.length] === 0x2d && buffer[sep.length + 1] === 0x2d) {
          buffer = buffer.subarray(sep.length + 2)
        } else if (buffer.length >= sep.length + 2) {
          buffer = buffer.subarray(sep.length + 2)
        } else {
          buffer = buffer.subarray(sep.length)
        }
        if (currentField === null || currentField === undefined) fail(500, 'part finished without headers')
        if (currentField.filename !== null) {
          fileParts.push({
            field: currentField.field,
            filename: currentField.filename,
            mediaType: currentField.mediaType,
            bytes: body,
          })
        }
        currentField = null
        // After dropping the separator trailer we are either at the message
        // close (no more bytes) or at the next part's CRLF/header bytes. If the
        // next byte is the next separator's start, we go straight back to
        // NEED_SEP; otherwise the trailer we skipped already consumed the CRLF.
        state = 'NEED_SEP'
        if (buffer.length === 0) return true
        continue
      }
      return true
    }
  }

  const close = async () => {
    if (state === 'IN_PART' && currentField !== null && currentField.filename !== null) {
      fileParts.push({
        field: currentField.field,
        filename: currentField.filename,
        mediaType: currentField.mediaType,
        bytes: buffer,
      })
      buffer = Buffer.alloc(0)
    }
  }

  return { push(chunk) { absorb(chunk); return process() }, close: async () => close(), files: fileParts }
}

/**
 * Build the /plugins/<id>/temp-upload HTTP handler. Accepts
 * `multipart/form-data` with one `file` part, saves the bytes under
 * `~/.dsh/.temp/` and answers with `{ path, name, bytes }`.
 */
function createUploadHandler(ctx, ceiling) {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const contentType = request.headers['content-type'] ?? ''
      const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
      if (match === null) {
        response.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Content-Type must be multipart/form-data')
        return
      }
      const boundary = match[1] ?? match[2]
      const parser = parseMultipart(request, boundary, ceiling)
      let settled = false
      const writeJson = (status, payload) => {
        if (settled) return
        settled = true
        const body = JSON.stringify(payload)
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        response.end(body)
      }
      let streamDone = false
      request.on('data', (chunk) => {
        if (streamDone || settled) return
        try {
          if (parser.push(chunk)) streamDone = true
        } catch (err) {
          streamDone = true
          request.resume()
          writeJson(err.statusCode ?? 400, { error: err.message })
        }
      })
      request.on('end', async () => {
        if (settled) return
        try {
          await parser.close()
          if (parser.files.length === 0) {
            writeJson(400, { error: 'no file part in upload' })
            return
          }
          const file = parser.files[0]
          const target = await allocateTempPath(file.filename ?? 'pasted-file')
          await fs.writeFile(target, file.bytes)
          writeJson(200, {
            path: target,
            name: path.basename(target),
            originalName: file.filename,
            bytes: file.bytes.length,
            mediaType: file.mediaType,
          })
        } catch (err) {
          writeJson(500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
      request.on('error', (err) => {
        if (settled) return
        writeJson(500, { error: err.message })
      })
    } catch (err) {
      ctx.logger?.warn?.(`dsh-Identify-local-files: upload handler error: ${String(err?.message ?? err)}`)
    }
  }
}

export function apply(ctx, config) {
  const limits = {
    maxFileBytes: config.maxFileBytes,
    maxTextBytes: config.maxTextBytes,
    maxUploadBytes: config.maxUploadBytes,
  }

  ctx.tools.register(defineTool({
    name: 'read_local_file',
    description: 'Read one local file by absolute or workspace-relative path. Images (PNG/JPEG/WebP/GIF) return a base64 data URL for vision; text files return their content inline (truncated to the byte budget); other binaries report their path and size.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'File path (absolute, or relative to the workspace root).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        if (value.kind === 'image') {
          return [{ type: 'text', text: `[image ${value.path} ${value.bytes}B as data URL]` }]
        }
        if (value.kind === 'text' && value.text !== null) {
          return [{ type: 'text', text: value.text }]
        }
        return [{ type: 'text', text: `[binary ${value.path} (${value.bytes} bytes)]` }]
      },
    },
    async execute(args) {
      const resolved = path.resolve(args.path)
      const stat = await fs.stat(resolved)
      if (!stat.isFile()) throw new Error(`not a regular file: ${resolved}`)
      if (stat.size > limits.maxFileBytes) {
        throw new Error(`file is ${stat.size} bytes, over the ${limits.maxFileBytes}-byte limit`)
      }

      const ext = path.extname(resolved).toLowerCase()
      const mediaType = IMAGE_MEDIA_TYPES[ext]
      if (mediaType !== undefined) {
        const bytes = await fs.readFile(resolved)
        return {
          kind: 'image',
          path: resolved,
          mediaType,
          bytes: stat.size,
          truncated: false,
          dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
        }
      }

      const raw = await fs.readFile(resolved)
      if (TEXT_EXTENSIONS.has(ext) || looksLikeText(raw.subarray(0, 4096))) {
        let text = raw.toString('utf8')
        let truncated = false
        if (Buffer.byteLength(text, 'utf8') > limits.maxTextBytes) {
          text = Buffer.from(text, 'utf8').subarray(0, limits.maxTextBytes).toString('utf8')
          truncated = true
        }
        return { kind: 'text', path: resolved, bytes: stat.size, truncated, text }
      }

      return { kind: 'binary', path: resolved, bytes: stat.size, truncated: false, text: null }
    },
  }))

  // Ensure the temp folder exists at boot so the first upload does not race mkdir.
  ctx.effect(() => fs.mkdir(tempDir(), { recursive: true }), 'dsh-Identify-local-files: ensure temp dir')

  // Register the HTTP upload route. DSH routes plugins under /plugins/<id>/, so
  // the client side knows the URL even when the webserver bind host differs.
  const route = {
    kind: 'exact',
    path: `/plugins/${name}/temp-upload`,
    handler: createUploadHandler(ctx, limits.maxUploadBytes),
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsh-Identify-local-files: /temp-upload')

  ctx.logger?.info?.('dsh-Identify-local-files: read_local_file + /temp-upload registered')
}