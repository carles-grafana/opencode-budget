import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DEFAULT_LIMIT_ENV = "OPENCODE_SESSION_BUDGET_USD"
const DEFAULT_COMMAND = "budget"
const STATE_VERSION = 1
const SERVICE = "session-budget"

export function normalizeOptions(options = {}, env = globalThis.process?.env ?? {}) {
  const rawDefaultLimit = firstDefined(options.defaultLimitUsd, options.defaultLimit, env[DEFAULT_LIMIT_ENV])
  const commandName = String(firstDefined(options.commandName, env.OPENCODE_SESSION_BUDGET_COMMAND, DEFAULT_COMMAND)).trim()

  return {
    commandName: commandName || DEFAULT_COMMAND,
    defaultLimitUsd:
      rawDefaultLimit === undefined || rawDefaultLimit === null || rawDefaultLimit === ""
        ? undefined
        : parseMoney(rawDefaultLimit, "defaultLimitUsd"),
    includeChildSessions: parseBoolean(
      firstDefined(options.includeChildSessions, env.OPENCODE_SESSION_BUDGET_INCLUDE_CHILDREN),
      true,
    ),
  }
}

export function createBudgetState(settings, snapshot, onRestoreWarning = () => {}) {
  const sessions = new Map()
  const budgets = new Map()
  const lockedBudgets = new Set()

  function getSession(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, {
        id: sessionID,
        parentID: undefined,
        children: new Set(),
        messages: new Map(),
      })
    }
    return sessions.get(sessionID)
  }

  function getMessage(sessionID, messageID) {
    const session = getSession(sessionID)
    if (!session.messages.has(messageID)) {
      session.messages.set(messageID, {
        messageCost: 0,
        stepCosts: new Map(),
      })
    }
    return session.messages.get(messageID)
  }

  function upsertSession(info) {
    if (!info?.id) return

    const existed = sessions.has(info.id)
    const session = getSession(info.id)
    const previousParentID = session.parentID
    if (session.parentID && sessions.has(session.parentID)) {
      sessions.get(session.parentID).children.delete(info.id)
    }

    session.parentID = info.parentID

    if (info.parentID) {
      getSession(info.parentID).children.add(info.id)
    }

    return !existed || previousParentID !== info.parentID
  }

  function removeSession(sessionID) {
    const session = sessions.get(sessionID)
    if (!session) return false

    if (session.parentID && sessions.has(session.parentID)) {
      sessions.get(session.parentID).children.delete(sessionID)
    }

    for (const childID of session.children) {
      const child = sessions.get(childID)
      if (child) child.parentID = undefined
    }

    sessions.delete(sessionID)
    budgets.delete(sessionID)
    lockedBudgets.delete(sessionID)
    return true
  }

  function recordAssistantMessage(info) {
    if (info?.role !== "assistant" || !info.sessionID || !info.id || typeof info.cost !== "number") return false
    const message = getMessage(info.sessionID, info.id)
    const cost = Math.max(0, info.cost)
    if (message.messageCost === cost) return false
    message.messageCost = cost
    return true
  }

  function recordStepFinish(part) {
    if (part?.type !== "step-finish" || !part.sessionID || !part.messageID || !part.id || typeof part.cost !== "number") return false
    const message = getMessage(part.sessionID, part.messageID)
    const cost = Math.max(0, part.cost)
    if (message.stepCosts.get(part.id) === cost) return false
    message.stepCosts.set(part.id, cost)
    return true
  }

  function rootOf(sessionID) {
    let current = getSession(sessionID)
    const seen = new Set()

    while (current.parentID && sessions.has(current.parentID) && !seen.has(current.id)) {
      seen.add(current.id)
      current = sessions.get(current.parentID)
    }

    return current.id
  }

  function budgetIDFor(sessionID) {
    return settings.includeChildSessions ? rootOf(sessionID) : sessionID
  }

  function limitForBudget(budgetID) {
    if (!budgets.has(budgetID)) return settings.defaultLimitUsd
    return budgets.get(budgetID) ?? undefined
  }

  function messageCost(message) {
    let stepCost = 0
    for (const cost of message.stepCosts.values()) stepCost += cost
    return Math.max(message.messageCost, stepCost)
  }

  function sessionCost(session) {
    let total = 0
    for (const message of session.messages.values()) total += messageCost(message)
    return total
  }

  function budgetSessionIDs(budgetID) {
    if (!settings.includeChildSessions) return [budgetID]

    const ids = []
    for (const sessionID of sessions.keys()) {
      if (rootOf(sessionID) === budgetID) ids.push(sessionID)
    }
    return ids.length > 0 ? ids : [budgetID]
  }

  function spentForBudget(budgetID) {
    let total = 0
    for (const sessionID of budgetSessionIDs(budgetID)) {
      const session = sessions.get(sessionID)
      if (session) total += sessionCost(session)
    }
    return total
  }

  function restore(snapshot) {
    if (!snapshot || snapshot.version !== STATE_VERSION) return
    const snapshotSessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
    const restoredSessionIDs = new Set()
    let invalid = false

    for (const item of snapshotSessions) {
      if (!item?.id || typeof item.id !== "string") {
        invalid = true
        continue
      }
      const session = getSession(item.id)
      restoredSessionIDs.add(item.id)
      if (item.parentID !== undefined && typeof item.parentID !== "string") invalid = true

      for (const messageInfo of Array.isArray(item.messages) ? item.messages : []) {
        if (!messageInfo?.id || typeof messageInfo.id !== "string") {
          invalid = true
          continue
        }
        const message = getMessage(item.id, messageInfo.id)
        if (Number.isFinite(messageInfo.messageCost)) message.messageCost = Math.max(0, messageInfo.messageCost)
        else if (messageInfo.messageCost !== undefined) invalid = true

        for (const entry of Array.isArray(messageInfo.stepCosts) ? messageInfo.stepCosts : []) {
          if (!Array.isArray(entry) || entry.length !== 2) {
            invalid = true
            continue
          }

          const [stepID, cost] = entry
          if (stepID && typeof stepID === "string" && Number.isFinite(cost)) message.stepCosts.set(stepID, Math.max(0, cost))
          else invalid = true
        }
      }
    }

    for (const entry of Array.isArray(snapshot.budgets) ? snapshot.budgets : []) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        invalid = true
        continue
      }

      const [budgetID, limitUsd] = entry
      if (budgetID && typeof budgetID === "string" && (Number.isFinite(limitUsd) || limitUsd === null)) budgets.set(budgetID, limitUsd)
      else invalid = true
    }

    for (const budgetID of Array.isArray(snapshot.lockedBudgets) ? snapshot.lockedBudgets : []) {
      if (budgetID && typeof budgetID === "string") lockedBudgets.add(budgetID)
      else invalid = true
    }

    for (const session of sessions.values()) {
      const item = snapshotSessions.find((candidate) => candidate?.id === session.id)
      if (item?.parentID && !restoredSessionIDs.has(item.parentID)) invalid = true
      session.parentID = item?.parentID && restoredSessionIDs.has(item.parentID) ? item.parentID : undefined
      session.children.clear()
    }

    for (const session of sessions.values()) {
      if (session.parentID) sessions.get(session.parentID).children.add(session.id)
    }

    if (invalid) onRestoreWarning()
  }

  restore(snapshot)

  function status(sessionID) {
    const budgetID = budgetIDFor(sessionID)
    const spentUsd = spentForBudget(budgetID)
    const limitUsd = limitForBudget(budgetID)
    const wasLocked = lockedBudgets.has(budgetID)
    const locked = limitUsd !== undefined && spentUsd + Number.EPSILON >= limitUsd

    if (locked) lockedBudgets.add(budgetID)
    else lockedBudgets.delete(budgetID)

    return {
      budgetID,
      spentUsd,
      limitUsd,
      remainingUsd: limitUsd === undefined ? undefined : Math.max(0, limitUsd - spentUsd),
      locked,
      justLocked: locked && !wasLocked,
      sessionIDs: budgetSessionIDs(budgetID),
    }
  }

  return {
    upsertSession,
    removeSession,
    recordAssistantMessage,
    recordStepFinish,
    setBudget(sessionID, limitUsd) {
      const budgetID = budgetIDFor(sessionID)
      budgets.set(budgetID, limitUsd)
      return status(sessionID)
    },
    clearBudget(sessionID) {
      const budgetID = budgetIDFor(sessionID)
      budgets.set(budgetID, null)
      lockedBudgets.delete(budgetID)
      return status(sessionID)
    },
    status,
    snapshot() {
      return {
        version: STATE_VERSION,
        sessions: [...sessions.values()].map((session) => ({
          id: session.id,
          parentID: session.parentID,
          messages: [...session.messages.entries()].map(([id, message]) => ({
            id,
            messageCost: message.messageCost,
            stepCosts: [...message.stepCosts.entries()],
          })),
        })),
        budgets: [...budgets.entries()],
        lockedBudgets: [...lockedBudgets],
      }
    },
    isLocked(sessionID) {
      return status(sessionID).locked
    },
    spentUsd(sessionID) {
      return status(sessionID).spentUsd
    },
  }
}

export function runBudgetCommand(state, sessionID, args = "") {
  const trimmed = args.trim()

  if (!trimmed || /^status$/i.test(trimmed)) {
    const status = state.status(sessionID)
    return { status, message: statusMessage(status) }
  }

  if (/^(off|clear|reset|none|disable|disabled)$/i.test(trimmed)) {
    const status = state.clearBudget(sessionID)
    return { status, message: `Budget disabled for this session. ${spentMessage(status)}` }
  }

  const amount = trimmed.replace(/^set\s+/i, "")
  const status = state.setBudget(sessionID, parseMoney(amount, "budget"))
  const message = status.locked
    ? `${blockedMessage(status)} Raise the limit above ${formatUsd(status.spentUsd)} or run /budget off to continue without a budget.`
    : `Budget set to ${formatUsd(status.limitUsd)} for this session. ${spentMessage(status)}`

  return { status, message }
}

export const createSessionBudgetPlugin = async (input, options = {}) => {
  const { client } = input
  const settings = normalizeOptions(options)
  const warned = new Set()

  async function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    await log(client, "warn", message)
  }

  const persistence = createPersistence(input, options, globalThis.process?.env ?? {}, warnOnce)
  const state = createBudgetState(settings, await persistence.load(), () => {
    void warnOnce("state:restore", "Ignored malformed persisted session budget state entries.")
  })
  const notifiedBudgets = new Map()
  const abortedSessions = new Map()

  async function save() {
    await persistence.save(state.snapshot())
  }

  async function enforce(sessionID) {
    const result = state.status(sessionID)
    if (result.locked) await stopWork(result)
    return result
  }

  async function assertOpen(sessionID) {
    const result = await enforce(sessionID)
    if (result.locked) throw new Error(blockedMessage(result))
  }

  async function stopWork(result) {
    for (const sessionID of result.sessionIDs) {
      if (abortedSessions.get(sessionID) === result.limitUsd) continue
      if (await abortSession(client, sessionID, warnOnce)) abortedSessions.set(sessionID, result.limitUsd)
    }

    if (notifiedBudgets.get(result.budgetID) === result.limitUsd) return
    notifiedBudgets.set(result.budgetID, result.limitUsd)

    const message = blockedMessage(result)
    await log(client, "warn", message)
    await toast(client, message, "error")
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[settings.commandName] = {
        description: "Set or show the current session budget",
        template: "$ARGUMENTS",
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.created" || event.type === "session.updated") {
        const changed = state.upsertSession(event.properties.info)
        await enforce(event.properties.info.id)
        if (changed) await save()
        return
      }

      if (event.type === "session.deleted") {
        if (state.removeSession(event.properties.info.id)) await save()
        return
      }

      if (event.type === "message.updated") {
        const info = event.properties.info
        const changed = state.recordAssistantMessage(info)
        if (info?.sessionID) await enforce(info.sessionID)
        if (changed) await save()
        return
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        const changed = state.recordStepFinish(part)
        if (part?.sessionID) await enforce(part.sessionID)
        if (changed) await save()
      }
    },
    "chat.message": async (input) => {
      await assertOpen(input.sessionID)
    },
    "chat.params": async (input) => {
      await assertOpen(input.sessionID)
    },
    "command.execute.before": async (input) => {
      if (input.command === settings.commandName) {
        const shouldSave = !/^\s*(status)?\s*$/i.test(input.arguments ?? "")
        const result = runBudgetCommand(state, input.sessionID, input.arguments)
        if (shouldSave) await save()
        notifiedBudgets.delete(result.status.budgetID)
        for (const sessionID of result.status.sessionIDs) abortedSessions.delete(sessionID)
        await log(client, result.status.locked ? "warn" : "info", result.message)
        await toast(client, result.message, result.status.locked ? "error" : "success")
        if (result.status.locked) await stopWork(result.status)
        throw new Error(result.message)
      }

      await assertOpen(input.sessionID)
    },
    "shell.env": async (input) => {
      if (input.sessionID) await assertOpen(input.sessionID)
    },
    "tool.execute.before": async (input) => {
      await assertOpen(input.sessionID)
    },
    "permission.ask": async (input, output) => {
      const result = await enforce(input.sessionID)
      if (result.locked) output.status = "deny"
    },
    "experimental.compaction.autocontinue": async (input, output) => {
      const result = await enforce(input.sessionID)
      if (result.locked) output.enabled = false
    },
  }
}

export function blockedMessage(result) {
  return `Budget limit reached for this session (${formatUsd(result.spentUsd)} / ${formatUsd(result.limitUsd)}). Opencode work has been stopped.`
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined)
}

function parseMoney(value, name) {
  const normalized = typeof value === "string" ? value.trim().replace(/^\$/, "").replace(/\s*usd$/i, "") : value
  const parsed = Number(normalized)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[${SERVICE}] ${name} must be a positive USD number, got ${JSON.stringify(value)}`)
  }

  return parsed
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "boolean") return value

  const normalized = String(value).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false

  throw new Error(`[${SERVICE}] boolean option must be true or false, got ${JSON.stringify(value)}`)
}

function statusMessage(status) {
  if (status.limitUsd === undefined) return `No budget set for this session. ${spentMessage(status)}`
  if (status.locked) return blockedMessage(status)
  return `Budget is ${formatUsd(status.limitUsd)} for this session. ${spentMessage(status)}`
}

function spentMessage(status) {
  if (status.remainingUsd === undefined) return `Spent ${formatUsd(status.spentUsd)}.`
  return `Spent ${formatUsd(status.spentUsd)}, remaining ${formatUsd(status.remainingUsd)}.`
}

function formatUsd(value) {
  if (value === undefined) return "unconfigured"
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`
}

async function abortSession(client, sessionID, warnOnce = async () => {}) {
  if (!client.session?.abort) {
    await warnOnce("abort:unavailable", "Unable to abort over-budget sessions because the session abort API is unavailable.")
    return false
  }

  try {
    await client.session.abort({ path: { id: sessionID } })
    return true
  } catch (error) {
    await warnOnce(`abort:${sessionID}`, `Failed to abort over-budget session ${sessionID}: ${errorMessage(error)}`)
    return false
  }
}

async function log(client, level, message) {
  try {
    await client.app?.log?.({ body: { service: SERVICE, level, message } })
  } catch {}
}

async function toast(client, message, variant) {
  try {
    await client.tui?.showToast?.({
      body: {
        title: SERVICE,
        message,
        variant,
        duration: 10000,
      },
    })
  } catch {}
}

function createPersistence(input = {}, options = {}, env = globalThis.process?.env ?? {}, warnOnce = async () => {}) {
  const enabled = parseBoolean(firstDefined(options.persistState, env.OPENCODE_SESSION_BUDGET_PERSIST_STATE), true)
  if (!enabled) return { load: async () => undefined, save: async () => {} }

  const configured = firstDefined(options.statePath, env.OPENCODE_SESSION_BUDGET_STATE)
  const base = input.worktree || input.directory || globalThis.process?.cwd?.()
  const file = configured ? resolveStatePath(String(configured), base) : path.join(defaultStateDir(env), `${stateKey(base)}.json`)
  if (!file) return { load: async () => undefined, save: async () => {} }

  let pending = Promise.resolve()

  async function write(snapshot) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const random = Math.random().toString(36).slice(2)
      const temp = `${file}.${globalThis.process?.pid ?? "tmp"}.${Date.now()}.${random}.tmp`
      await fs.writeFile(temp, `${JSON.stringify(snapshot)}\n`)
      await fs.rename(temp, file)
    } catch (error) {
      await warnOnce(`state:save:${file}`, `Failed to persist session budget state to ${file}: ${errorMessage(error)}`)
    }
  }

  return {
    async load() {
      try {
        return JSON.parse(await fs.readFile(file, "utf8"))
      } catch (error) {
        if (error?.code !== "ENOENT") {
          await warnOnce(`state:load:${file}`, `Failed to load session budget state from ${file}: ${errorMessage(error)}`)
        }
        return undefined
      }
    },
    save(snapshot) {
      pending = pending.then(() => write(snapshot), () => write(snapshot))
      return pending
    },
  }
}

function resolveStatePath(configured, base) {
  if (path.isAbsolute(configured)) return configured
  return base ? path.join(base, configured) : path.resolve(configured)
}

function defaultStateDir(env) {
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "opencode-session-budget")
  if (env.HOME) return path.join(env.HOME, ".local", "state", "opencode-session-budget")
  return path.join(os.tmpdir(), "opencode-session-budget")
}

function stateKey(value) {
  return crypto.createHash("sha256").update(String(value || "default")).digest("hex")
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
