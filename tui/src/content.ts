export type MessageRole = "user" | "assistant" | "tool" | "system" | "custom" | "unknown"

export type FusionTranscriptUsage = {
  input: number
  output: number
  cost: number | null
  costKnown: boolean
  turns: number
}

export type FusionTranscriptAgent = {
  role: "architect" | "builder" | "synthesizer"
  model: string
  effort: string
  status: "done" | "failed"
  durationMs: number | null
  text: string
  usage: FusionTranscriptUsage
  error?: string
}

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; source: "thinking" | "reasoning"; redacted: boolean }
  | { kind: "tool-call"; id?: string; name: string; input: unknown; summary: string }
  | {
      kind: "tool-result"
      id?: string
      name: string
      isError: boolean
      preview: string
      expanded: string
      truncated: boolean
    }
  | { kind: "image"; mimeType?: string; data?: string; url?: string; name?: string }
  | { kind: "file"; mimeType?: string; data?: string; url?: string; name?: string }
  | {
      kind: "fusion"
      status: string
      runId: string
      runDir: string
      objective: string
      proposals: FusionTranscriptAgent[]
      synthesis?: FusionTranscriptAgent
      error?: string
      summary?: string
    }
  | { kind: "custom"; name: string; text: string; value: unknown }
  | { kind: "unknown"; text: string; value: unknown }

export type MessageBlockOptions = {
  previewLines?: number
  previewChars?: number
}

type UnknownRecord = Record<string, unknown>

const REDACTED = "[REDACTED]"
const SECRET_KEY_PARTS = [
  "apikey",
  "token",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "secret",
  "privatekey",
  "credential",
]

function secretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part))
}

export function redactDisplayText(value: string): string {
  return value
    .replace(/((?:proxy[-_ ]?)?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|password|passwd|cookie|client[-_ ]?secret|private[-_ ]?key|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      `$1${REDACTED}`,
    )
}

function recordValue(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as UnknownRecord
}

function field(value: UnknownRecord | undefined, key: string): unknown {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}

function stringField(value: UnknownRecord | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const item = field(value, key)
    if (typeof item === "string") return item
  }
  return undefined
}

function numberField(value: UnknownRecord | undefined, key: string): number | undefined {
  const item = field(value, key)
  return typeof item === "number" && Number.isFinite(item) ? item : undefined
}

function safeText(value: unknown): string {
  if (typeof value === "string") return redactDisplayText(value)
  if (value === undefined) return "undefined"
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "symbol") return redactDisplayText(value.toString())
  if (typeof value === "function") return redactDisplayText(`[Function${value.name ? ` ${value.name}` : ""}]`)
  if (value instanceof Error) return redactDisplayText(value.message || value.name)

  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(value, (key, item: unknown) => {
      if (key && secretKey(key)) return REDACTED
      if (typeof item === "string") return redactDisplayText(item)
      if (typeof item === "bigint") return `${item}n`
      if (typeof item === "symbol") return redactDisplayText(item.toString())
      if (typeof item === "function") return redactDisplayText(`[Function${item.name ? ` ${item.name}` : ""}]`)
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })
    if (json !== undefined) return json
  } catch {
    // Fall through to an explicit type label rather than object coercion.
  }

  return value === null ? "null" : `[Unserializable ${typeof value}]`
}

function oneLine(value: string, max = 240): string {
  const compact = redactDisplayText(value).replace(/\s+/g, " ").trim()
  const chars = Array.from(compact)
  if (chars.length <= max) return compact
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
}

function quoted(value: string | undefined): string {
  return value === undefined ? "" : JSON.stringify(oneLine(value, 160))
}

function withDetail(label: string, detail: string | undefined): string {
  const compact = detail === undefined ? "" : oneLine(detail)
  return compact ? `${label} ${compact}` : label
}

function normalizedToolName(value: unknown): { key: string; label: string } {
  const raw = typeof value === "string" && value.trim() ? redactDisplayText(value.trim()) : "tool"
  const withoutNamespace = raw.replace(/^functions[.:/_-]+/i, "").replace(/^mcp[.:/_-]+/i, "")
  return {
    key: withoutNamespace.toLowerCase().replace(/[^a-z0-9]/g, ""),
    label: withoutNamespace.replace(/[.:/_-]+/g, " ").replace(/\s+/g, " ").trim() || "tool",
  }
}

function pathDetail(input: UnknownRecord | undefined): string | undefined {
  return stringField(input, "path", "filePath", "file_path", "filename")
}

export function messageRole(message: unknown): MessageRole {
  const role = stringField(recordValue(message), "role")
  if (role === "user" || role === "assistant" || role === "system") return role
  if (role === "toolResult" || role === "tool" || role === "tool_result") return "tool"
  if (
    role === "custom" ||
    role === "bashExecution" ||
    role === "branchSummary" ||
    role === "compactionSummary"
  ) {
    return "custom"
  }
  return "unknown"
}

export function toolSummary(name: unknown, inputValue: unknown = {}): string {
  const tool = normalizedToolName(name)
  const input = recordValue(inputValue)
  const path = pathDetail(input)

  if (tool.key === "bash" || tool.key === "shell") {
    const command = stringField(input, "command", "cmd")
    return command ? `$ ${oneLine(command)}` : "$"
  }

  if (tool.key === "read") {
    const offset = numberField(input, "offset")
    const limit = numberField(input, "limit")
    const range = offset === undefined ? "" : `:${offset}${limit === undefined ? "" : `+${limit}`}`
    return withDetail("Read", path ? `${path}${range}` : undefined)
  }

  if (tool.key === "write") return withDetail("Write", path)
  if (tool.key === "edit") return withDetail("Edit", path)

  if (tool.key === "grep") {
    const pattern = quoted(stringField(input, "pattern", "query"))
    const location = path || stringField(input, "glob", "include")
    return `Grep${pattern ? ` ${pattern}` : ""}${location ? ` in ${oneLine(location)}` : ""}`
  }

  if (tool.key === "find" || tool.key === "glob") {
    const pattern = quoted(stringField(input, "pattern", "glob", "query"))
    return `Find${pattern ? ` ${pattern}` : ""}${path ? ` in ${oneLine(path)}` : ""}`
  }

  if (tool.key === "ls" || tool.key === "list") return withDetail("List", path || ".")

  if (tool.key === "webfetch" || tool.key === "fetch") {
    return withDetail("WebFetch", stringField(input, "url"))
  }

  if (tool.key === "web" && stringField(input, "url")) {
    return withDetail("WebFetch", stringField(input, "url"))
  }

  if (tool.key === "websearch" || tool.key === "web") {
    const query = quoted(stringField(input, "query", "search", "q"))
    return query ? `Web Search ${query}` : "Web Search"
  }

  if (tool.key === "task") {
    const type = stringField(input, "subagent_type", "subagentType", "agent") || "general"
    const agent = type.charAt(0).toUpperCase() + type.slice(1)
    const description = stringField(input, "description", "prompt", "task")
    return description ? `${agent} Task — ${oneLine(description)}` : `${agent} Task`
  }

  if (tool.key === "skill") {
    const skill = quoted(stringField(input, "name", "skill"))
    return skill ? `Skill ${skill}` : "Skill"
  }

  if (tool.key === "todowrite" || tool.key === "todos") {
    const todos = field(input, "todos")
    return Array.isArray(todos) ? `Update todos (${todos.length})` : "Update todos"
  }

  if (tool.key === "applypatch" || tool.key === "patch") return "Patch"

  let primitives: string[] = []
  if (input) {
    try {
      primitives = Object.entries(input).flatMap(([key, value]) => {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return []
        return [`${key}=${secretKey(key) ? REDACTED : oneLine(String(value), 120)}`]
      })
    } catch {
      primitives = []
    }
  }
  if (primitives.length) return `${tool.label} ${oneLine(`[${primitives.join(", ")}]`)}`

  const args = inputValue === undefined ? "" : safeText(inputValue)
  const hasArgs = args && args !== "{}" && args !== "null" && args !== "undefined"
  return hasArgs ? `${tool.label} ${oneLine(args)}` : tool.label
}

function contentText(content: unknown): string {
  if (typeof content === "string") return redactDisplayText(content)
  if (!Array.isArray(content)) return content === undefined ? "" : safeText(content)

  return content
    .flatMap((item) => {
      const part = recordValue(item)
      const type = stringField(part, "type")
      if (type === "image" || type === "file") return []
      const text = stringField(part, "text")
      if (text !== undefined) return [redactDisplayText(text)]
      return [safeText(item)]
    })
    .join("\n")
}

export function resultText(result: unknown): string {
  if (typeof result === "string") return redactDisplayText(result)
  if (Array.isArray(result)) return contentText(result)

  const value = recordValue(result)
  if (!value) return ""

  const directText = stringField(value, "text")
  if (directText !== undefined) return redactDisplayText(directText)

  const content = field(value, "content")
  if (content !== undefined) {
    const text = contentText(content)
    if (text) return text
  }

  const output = field(value, "output")
  if (output !== undefined) return typeof output === "string" ? redactDisplayText(output) : safeText(output)

  const details = field(value, "details")
  if (details !== undefined) return typeof details === "string" ? redactDisplayText(details) : safeText(details)
  return ""
}

function mediaBlock(value: UnknownRecord, kind: "image" | "file"): TranscriptBlock {
  const block: Extract<TranscriptBlock, { kind: "image" | "file" }> = { kind }
  const mimeType = stringField(value, "mimeType", "mime", "mediaType")
  const data = stringField(value, "data")
  const url = stringField(value, "url")
  const name = stringField(value, "filename", "name", "path")
  if (mimeType !== undefined) block.mimeType = mimeType
  if (data !== undefined) block.data = data
  if (url !== undefined) block.url = url
  if (name !== undefined) block.name = name
  return block
}

function partBlock(value: unknown): TranscriptBlock {
  const part = recordValue(value)
  const type = stringField(part, "type")

  if (type === "text") {
    const text = stringField(part, "text")
    if (text !== undefined) return { kind: "text", text }
  }

  if (type === "thinking" || type === "reasoning") {
    const text = stringField(part, type === "thinking" ? "thinking" : "text", "thinking", "text")
    if (text !== undefined) {
      return {
        kind: "reasoning",
        text,
        source: type,
        redacted: field(part, "redacted") === true,
      }
    }
  }

  if (type === "toolCall" || type === "tool_call" || type === "tool") {
    const id = stringField(part, "id", "toolCallId", "callID")
    const name = stringField(part, "name", "toolName", "tool") || "tool"
    const rawInput = field(part, "arguments") ?? field(part, "input")
    const input = rawInput === undefined ? {} : rawInput
    const block: Extract<TranscriptBlock, { kind: "tool-call" }> = {
      kind: "tool-call",
      name,
      input,
      summary: toolSummary(name, input),
    }
    if (id !== undefined) block.id = id
    return block
  }

  if (type === "image" && part) return mediaBlock(part, "image")
  if (type === "file" && part) return mediaBlock(part, "file")

  if (type === "custom") {
    const name = redactDisplayText(stringField(part, "customType", "name") || "custom")
    const content = field(part, "content") ?? field(part, "value") ?? value
    return { kind: "custom", name, text: safeText(content), value: content }
  }

  return { kind: "unknown", text: safeText(value), value }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function previewText(text: string, options: MessageBlockOptions): { text: string; truncated: boolean } {
  const maxLines = positiveLimit(options.previewLines, 10)
  const maxChars = positiveLimit(options.previewChars, 4_000)
  const preview: string[] = []
  let lines = 1
  let lineLimited = false
  let charLimited = false

  for (const char of text) {
    if (preview.length >= maxChars) {
      charLimited = true
      break
    }
    if (char === "\n" && lines >= maxLines) {
      lineLimited = true
      break
    }
    preview.push(char)
    if (char === "\n") lines += 1
  }

  if (!lineLimited && !charLimited) return { text, truncated: false }
  if (charLimited) {
    return { text: `${preview.slice(0, Math.max(0, maxChars - 1)).join("")}…`, truncated: true }
  }
  return { text: `${preview.join("")}\n…`, truncated: true }
}

export function displayText(value: unknown): string {
  return resultText(value) || safeText(value)
}

export function displayPreview(value: unknown, options: MessageBlockOptions = {}): string {
  return previewText(displayText(value), options).text
}

function contentMedia(content: unknown): TranscriptBlock[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const part = recordValue(item)
    const type = stringField(part, "type")
    if (type === "image" && part) return [mediaBlock(part, "image")]
    if (type === "file" && part) return [mediaBlock(part, "file")]
    return []
  })
}

function customBlocks(message: UnknownRecord, role: string): TranscriptBlock[] {
  if (role === "bashExecution") {
    const command = redactDisplayText(stringField(message, "command") || "")
    const output = redactDisplayText(stringField(message, "output") || "")
    const exitCode = numberField(message, "exitCode")
    const value: UnknownRecord = { command, output }
    if (exitCode !== undefined) value.exitCode = exitCode
    const lines = [`$ ${command}`, output]
    if (exitCode !== undefined) lines.push(`exit ${exitCode}`)
    return [{ kind: "custom", name: role, text: lines.filter(Boolean).join("\n"), value }]
  }

  const name = redactDisplayText(stringField(message, "customType") || role || "custom")
  if (name === "alloy-fusion") {
    const details = recordValue(field(message, "details"))
    if (details && stringField(details, "kind") === "fusion") {
      const efforts = recordValue(field(details, "requestedEfforts"))
      const normalizeUsage = (value: unknown): FusionTranscriptUsage => {
        const usage = recordValue(value)
        const finiteNonNegative = (key: string): number | null => {
          const amount = numberField(usage, key)
          return amount !== undefined && amount >= 0 ? amount : null
        }
        const cost = finiteNonNegative("cost")
        return {
          input: finiteNonNegative("input") ?? 0,
          output: finiteNonNegative("output") ?? 0,
          cost,
          costKnown: field(usage, "costKnown") !== false && cost !== null,
          turns: finiteNonNegative("turns") ?? 0,
        }
      }
      const normalizeAgent = (
        value: unknown,
        agentRole: FusionTranscriptAgent["role"],
        textOverride?: string,
      ): FusionTranscriptAgent | undefined => {
        const agent = recordValue(value)
        if (!agent) return undefined
        const error = stringField(agent, "error")
        const normalized: FusionTranscriptAgent = {
          role: agentRole,
          model: redactDisplayText(stringField(agent, "model") || "unknown model"),
          effort: redactDisplayText(stringField(efforts, agentRole) || "default"),
          status: field(agent, "ok") === true ? "done" : "failed",
          durationMs: (() => {
            const duration = numberField(agent, "durationMs")
            return duration !== undefined && duration >= 0 ? duration : null
          })(),
          text: redactDisplayText(textOverride ?? stringField(agent, "text") ?? ""),
          usage: normalizeUsage(field(agent, "usage")),
        }
        if (error) normalized.error = redactDisplayText(error)
        return normalized
      }
      const rawProposals = Array.isArray(field(details, "proposals"))
        ? field(details, "proposals") as unknown[]
        : []
      const proposalRecords = rawProposals
        .map((proposal) => recordValue(proposal))
        .filter((proposal): proposal is UnknownRecord => proposal !== undefined)
      const proposalRoles = proposalRecords.map((proposal) => stringField(proposal, "role"))
      const provenanceErrors: string[] = []
      if (proposalRoles.some((roleName) => roleName !== "architect" && roleName !== "builder")) {
        provenanceErrors.push("unknown proposal role")
      }
      for (const roleName of ["architect", "builder"] as const) {
        if (proposalRoles.filter((role) => role === roleName).length > 1) {
          provenanceErrors.push(`duplicate ${roleName} role`)
        }
      }
      const proposals = (["architect", "builder"] as const)
        .map((roleName) => {
          const matches = proposalRecords.filter((candidate) => stringField(candidate, "role") === roleName)
          return matches.length === 1 ? normalizeAgent(matches[0], roleName) : undefined
        })
        .filter((proposal): proposal is FusionTranscriptAgent => proposal !== undefined)
      const synthesis = normalizeAgent(
        field(details, "synthesizer"),
        "synthesizer",
        stringField(details, "synthesis") || "",
      )
      const block: Extract<TranscriptBlock, { kind: "fusion" }> = {
        kind: "fusion",
        status: redactDisplayText(stringField(details, "status") || "UNKNOWN"),
        runId: redactDisplayText(stringField(details, "runId") || ""),
        runDir: redactDisplayText(stringField(details, "runDir") || ""),
        objective: redactDisplayText(stringField(details, "objective") || ""),
        proposals,
      }
      if (synthesis) block.synthesis = synthesis
      const workflowError = stringField(details, "error")
      const errors = [workflowError, provenanceErrors.length ? `Malformed Fusion provenance: ${provenanceErrors.join(", ")}` : undefined]
        .filter((error): error is string => Boolean(error))
      if (errors.length) block.error = redactDisplayText(errors.join("; "))
      if (workflowError || (proposals.length === 0 && !synthesis)) {
        const summary = contentText(field(message, "content"))
        if (summary) block.summary = summary
      }
      return [block]
    }
  }
  const content = field(message, "content") ?? field(message, "summary") ?? field(message, "details")
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = recordValue(part)
      const type = stringField(item, "type")
      if (type === "image" && item) return mediaBlock(item, "image")
      if (type === "file" && item) return mediaBlock(item, "file")
      const value = type === "text" ? field(item, "text") : part
      return { kind: "custom", name, text: safeText(value), value } as TranscriptBlock
    })
  }
  return [{ kind: "custom", name, text: safeText(content), value: content }]
}

export function messageBlocks(message: unknown, options: MessageBlockOptions = {}): TranscriptBlock[] {
  const value = recordValue(message)
  if (!value) return [{ kind: "unknown", text: safeText(message), value: message }]

  const role = stringField(value, "role") || ""
  if (messageRole(value) === "tool") {
    const expanded = resultText(value)
    const preview = previewText(expanded, options)
    const block: Extract<TranscriptBlock, { kind: "tool-result" }> = {
      kind: "tool-result",
      name: stringField(value, "toolName", "name", "tool") || "tool",
      isError: field(value, "isError") === true,
      preview: preview.text,
      expanded,
      truncated: preview.truncated,
    }
    const id = stringField(value, "toolCallId", "id", "callID")
    if (id !== undefined) block.id = id
    return [block, ...contentMedia(field(value, "content"))]
  }

  if (messageRole(value) === "custom") return customBlocks(value, role)

  const content = field(value, "content")
  if (typeof content === "string") return [{ kind: "text", text: content }]
  if (Array.isArray(content)) return content.map(partBlock)
  if (content !== undefined) return [{ kind: "unknown", text: safeText(content), value: content }]

  if (messageRole(value) === "unknown") return [{ kind: "unknown", text: safeText(message), value: message }]
  return []
}

export type TranscriptToolStatus = "pending" | "completed" | "error"

export function transcriptToolStates(messages: unknown[]): Record<string, TranscriptToolStatus> {
  const states: Record<string, TranscriptToolStatus> = {}
  for (const message of messages) {
    for (const block of messageBlocks(message)) {
      if (block.kind !== "tool-call" && block.kind !== "tool-result") continue
      if (!block.id) continue
      if (block.kind === "tool-result") states[block.id] = block.isError ? "error" : "completed"
      else if (block.kind === "tool-call" && states[block.id] === undefined) states[block.id] = "pending"
    }
  }
  return states
}
