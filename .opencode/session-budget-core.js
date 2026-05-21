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
  }
}

export function createBudgetState(settings, snapshot, onRestoreWarning = () => {}) {
  const sessions = new Map()
  const budgets = new Map()
  const budgetVersions = new Map()
  const changedBudgets = new Set()
  const changedParents = new Set()
  let budgetVersionSequence = 0
  const lockedBudgets = new Set()
  const deletedSessions = new Set()

  function getSession(sessionID) {
    if (!sessions.has(sessionID)) {
      sessions.set(sessionID, {
        id: sessionID,
        parentID: undefined,
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
    deletedSessions.delete(info.id)
    const parentID = info.parentID && info.parentID !== info.id && !deletedSessions.has(info.parentID) ? info.parentID : undefined
    const changed = !existed || session.parentID !== parentID
    session.parentID = parentID
    if (changed && (existed || parentID)) changedParents.add(info.id)
    return changed
  }

  function removeSession(sessionID) {
    if (!sessions.has(sessionID)) return false

    sessions.delete(sessionID)
    budgets.delete(sessionID)
    budgetVersions.delete(sessionID)
    lockedBudgets.delete(sessionID)
    deletedSessions.add(sessionID)
    for (const session of sessions.values()) {
      if (session.parentID === sessionID) {
        session.parentID = undefined
        changedParents.add(session.id)
      }
    }
    return true
  }

  function recordAssistantMessage(info) {
    if (info?.role !== "assistant" || !info.sessionID || !info.id || !Number.isFinite(info.cost)) return false
    const message = getMessage(info.sessionID, info.id)
    const cost = Math.max(0, info.cost)
    if (message.messageCost === cost) return false
    message.messageCost = cost
    return true
  }

  function recordStepFinish(part) {
    if (part?.type !== "step-finish" || !part.sessionID || !part.messageID || !part.id || !Number.isFinite(part.cost)) return false
    const message = getMessage(part.sessionID, part.messageID)
    const cost = Math.max(0, part.cost)
    if (message.stepCosts.get(part.id) === cost) return false
    message.stepCosts.set(part.id, cost)
    return true
  }

  function rootOf(sessionID) {
    const start = getSession(sessionID)
    let current = start
    const seen = new Set()

    while (current.parentID && sessions.has(current.parentID)) {
      if (seen.has(current.id)) return start.id
      seen.add(current.id)
      current = sessions.get(current.parentID)
    }

    return current.id
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
    if (!snapshot) return

    if (snapshot.version !== STATE_VERSION) {
      onRestoreWarning()
      return
    }

    const snapshotSessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
    let invalid = false
    if (!Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.budgets) || !Array.isArray(snapshot.lockedBudgets)) invalid = true

    for (const item of snapshotSessions) {
      if (!item?.id || typeof item.id !== "string") {
        invalid = true
        continue
      }
      const session = getSession(item.id)
      if (item.parentID !== undefined && item.parentID !== null && typeof item.parentID !== "string") invalid = true
      session.parentID = item.parentID && item.parentID !== item.id ? item.parentID : undefined

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
      if (budgetID && typeof budgetID === "string" && ((Number.isFinite(limitUsd) && limitUsd > 0) || limitUsd === null)) budgets.set(budgetID, limitUsd)
      else invalid = true
    }

    for (const entry of Array.isArray(snapshot.budgetVersions) ? snapshot.budgetVersions : []) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        invalid = true
        continue
      }

      const [budgetID, version] = entry
      if (budgetID && typeof budgetID === "string" && isBudgetVersion(version)) {
        budgetVersions.set(budgetID, version)
        budgetVersionSequence = Math.max(budgetVersionSequence, budgetVersionSequenceOf(version))
      } else invalid = true
    }

    for (const budgetID of Array.isArray(snapshot.lockedBudgets) ? snapshot.lockedBudgets : []) {
      if (budgetID && typeof budgetID === "string") lockedBudgets.add(budgetID)
      else invalid = true
    }

    for (const sessionID of Array.isArray(snapshot.deletedSessions) ? snapshot.deletedSessions : []) {
      if (sessionID && typeof sessionID === "string") deletedSessions.add(sessionID)
      else invalid = true
    }

    for (const sessionID of deletedSessions) {
      sessions.delete(sessionID)
      budgets.delete(sessionID)
      budgetVersions.delete(sessionID)
      lockedBudgets.delete(sessionID)
    }

    for (const session of sessions.values()) {
      if (session.parentID && (!sessions.has(session.parentID) || session.parentID === session.id)) session.parentID = undefined
    }

    if (invalid) onRestoreWarning()
  }

  restore(snapshot)

  function status(sessionID) {
    const budgetID = rootOf(sessionID)
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
      const budgetID = rootOf(sessionID)
      budgets.set(budgetID, limitUsd)
      budgetVersions.set(budgetID, nextBudgetVersion(++budgetVersionSequence))
      changedBudgets.add(budgetID)
      return status(sessionID)
    },
    clearBudget(sessionID) {
      const budgetID = rootOf(sessionID)
      budgets.set(budgetID, null)
      budgetVersions.set(budgetID, nextBudgetVersion(++budgetVersionSequence))
      changedBudgets.add(budgetID)
      lockedBudgets.delete(budgetID)
      return status(sessionID)
    },
    status,
    snapshot() {
      return {
        version: STATE_VERSION,
        sessions: [...sessions.values()].map((session) => ({
          id: session.id,
          parentID: session.parentID ?? null,
          messages: [...session.messages.entries()].map(([id, message]) => ({
            id,
            messageCost: message.messageCost,
            stepCosts: [...message.stepCosts.entries()],
          })),
        })),
        budgets: [...budgets.entries()],
        budgetVersions: [...budgetVersions.entries()],
        changedBudgets: [...changedBudgets],
        changedParents: [...changedParents],
        lockedBudgets: [...lockedBudgets],
        deletedSessions: [...deletedSessions],
      }
    },
    markBudgetChangesSaved(budgetIDs = []) {
      for (const budgetID of budgetIDs) changedBudgets.delete(budgetID)
    },
    markParentChangesSaved(sessionIDs = []) {
      for (const sessionID of sessionIDs) changedParents.delete(sessionID)
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

  function saveSoon() {
    const snapshot = state.snapshot()
    state.markBudgetChangesSaved(snapshot.changedBudgets)
    state.markParentChangesSaved(snapshot.changedParents)
    void persistence.save(snapshot)
  }

  async function saveNow() {
    const snapshot = state.snapshot()
    state.markBudgetChangesSaved(snapshot.changedBudgets)
    state.markParentChangesSaved(snapshot.changedParents)
    await persistence.save(snapshot, true)
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
    await printSessionNotice(client, result.budgetID, budgetStopMessage(result), warnOnce)
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
        if (changed) saveSoon()
        return
      }

      if (event.type === "session.deleted") {
        if (state.removeSession(event.properties.info.id)) saveSoon()
        return
      }

      if (event.type === "message.updated") {
        const info = event.properties.info
        const changed = state.recordAssistantMessage(info)
        if (info?.sessionID) await enforce(info.sessionID)
        if (changed) saveSoon()
        return
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        const changed = state.recordStepFinish(part)
        if (part?.sessionID) await enforce(part.sessionID)
        if (changed) saveSoon()
      }
    },
    "chat.message": async (input, output) => {
      if (isBudgetNotice(output?.parts)) return
      await assertOpen(input.sessionID)
    },
    "chat.params": async (input) => {
      await assertOpen(input.sessionID)
    },
    "command.execute.before": async (input) => {
      if (input.command === settings.commandName) {
        const shouldSave = !/^\s*(status)?\s*$/i.test(input.arguments ?? "")
        const result = runBudgetCommand(state, input.sessionID, input.arguments)
        if (shouldSave) await saveNow()
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

function budgetStopMessage(result) {
  return `${blockedMessage(result)} Raise the budget with /budget ${formatUsdForCommand(nextBudget(result.spentUsd))}, or run /budget off to continue without a budget.`
}

function isBudgetNotice(parts) {
  return Array.isArray(parts) && parts.some((part) => part?.type === "text" && part.metadata?.service === SERVICE)
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

function formatUsdForCommand(value) {
  return value.toFixed(2)
}

function nextBudget(spentUsd) {
  return Math.ceil((spentUsd + 0.01) * 100) / 100
}

async function printSessionNotice(client, sessionID, message, warnOnce = async () => {}) {
  if (!client.session?.promptAsync) return

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: message, synthetic: true, metadata: { service: SERVICE } }],
      },
    })
  } catch (error) {
    await warnOnce(`notice:${sessionID}`, `Failed to print over-budget session notice for ${sessionID}: ${errorMessage(error)}`)
  }
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
  let queuedSnapshot
  let queuedWrite

  async function write(snapshot) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await withStateLock(file, warnOnce, async () => {
        const current = await readSnapshotFile(file, warnOnce)
        const merged = mergeSnapshots(current, snapshot)
        const random = Math.random().toString(36).slice(2)
        const temp = `${file}.${globalThis.process?.pid ?? "tmp"}.${Date.now()}.${random}.tmp`
        try {
          await fs.writeFile(temp, `${JSON.stringify(merged)}\n`, { mode: 0o600 })
          await fs.rename(temp, file)
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => {})
          await warnOnce(`state:save:${file}`, `Failed to persist session budget state to ${file}: ${errorMessage(error)}`)
        }
      })
    } catch (error) {
      await warnOnce(`state:save:${file}`, `Failed to persist session budget state to ${file}: ${errorMessage(error)}`)
    }
  }

  return {
    async load() {
      return readSnapshotFile(file, warnOnce)
    },
    save(snapshot, wait = false) {
      queuedSnapshot = snapshot
      if (!queuedWrite) {
        queuedWrite = Promise.resolve().then(() => {
          const next = queuedSnapshot
          queuedSnapshot = undefined
          queuedWrite = undefined
          pending = pending.then(() => write(next), () => write(next))
          return pending
        })
      }
      return wait ? queuedWrite : Promise.resolve()
    },
  }
}

async function readSnapshotFile(file, warnOnce) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await warnOnce(`state:load:${file}`, `Failed to load session budget state from ${file}: ${errorMessage(error)}`)
    }
    return undefined
  }
}

async function withStateLock(file, warnOnce, fn) {
  const lock = `${file}.lock`
  const started = Date.now()

  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 })
      break
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await warnOnce(`state:lock:${file}`, `Failed to lock session budget state ${file}: ${errorMessage(error)}`)
        return
      }

      if (Date.now() - started > 2000) {
        await warnOnce(`state:lock:${file}`, `Timed out locking session budget state ${file}; skipping this save.`)
        return
      }

      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  try {
    await fn()
  } finally {
    await fs.rm(lock, { recursive: true, force: true }).catch(() => {})
  }
}

function mergeSnapshots(current, next) {
  if (!current || current.version !== STATE_VERSION) return next

  const deleted = new Set([...(arrayOfStrings(current.deletedSessions) ?? []), ...(arrayOfStrings(next.deletedSessions) ?? [])])
  const changedBudgets = new Set(arrayOfStrings(next.changedBudgets) ?? [])
  const changedParents = new Set(arrayOfStrings(next.changedParents) ?? [])
  const sessions = new Map()
  const budgets = new Map()
  const budgetVersions = new Map()
  const lockedBudgets = new Set()

  for (const item of Array.isArray(current.sessions) ? current.sessions : []) {
    if (item?.id && typeof item.id === "string" && !deleted.has(item.id)) sessions.set(item.id, mergeSessionSnapshot(sessions.get(item.id), item, deleted, changedParents))
  }

  for (const item of Array.isArray(next.sessions) ? next.sessions : []) {
    if (item?.id && typeof item.id === "string" && !deleted.has(item.id)) sessions.set(item.id, mergeSessionSnapshot(sessions.get(item.id), item, deleted, changedParents))
  }

  for (const entry of Array.isArray(current.budgets) ? current.budgets : []) {
    applyBudgetEntry(budgets, budgetVersions, entry, budgetVersionFor(current, entry?.[0]), deleted)
  }

  for (const entry of Array.isArray(next.budgets) ? next.budgets : []) {
    const budgetID = entry?.[0]
    const version = changedBudgets.has(budgetID)
      ? changedBudgetVersion(budgetVersions.get(budgetID), budgetVersionFor(next, budgetID))
      : budgetVersionFor(next, budgetID)
    applyBudgetEntry(budgets, budgetVersions, entry, version, deleted)
  }

  for (const budgetID of arrayOfStrings(current.lockedBudgets) ?? []) {
    if (!deleted.has(budgetID)) lockedBudgets.add(budgetID)
  }

  for (const budgetID of arrayOfStrings(next.lockedBudgets) ?? []) {
    if (!deleted.has(budgetID)) lockedBudgets.add(budgetID)
  }

  return {
    version: STATE_VERSION,
    sessions: [...sessions.values()],
    budgets: [...budgets.entries()],
    budgetVersions: [...budgetVersions.entries()],
    changedBudgets: [],
    changedParents: [],
    lockedBudgets: [...lockedBudgets],
    deletedSessions: [...deleted],
  }
}

function changedBudgetVersion(currentVersion, nextVersion) {
  const sequence = Math.max(budgetVersionSequenceOf(currentVersion), budgetVersionSequenceOf(nextVersion)) + 1
  const time = Math.max(Date.now(), Number.isFinite(currentVersion?.time) ? currentVersion.time : 0, nextVersion.time)
  return { time, sequence, id: crypto.randomBytes(8).toString("hex") }
}

function applyBudgetEntry(budgets, budgetVersions, entry, version, deleted) {
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || deleted.has(entry[0])) return

  const [budgetID, limitUsd] = entry
  const currentVersion = budgetVersions.get(budgetID)
  if (currentVersion && compareBudgetVersions(currentVersion, version) > 0) return

  budgets.set(budgetID, limitUsd)
  budgetVersions.set(budgetID, version)
}

function budgetVersionFor(snapshot, budgetID) {
  if (!budgetID || typeof budgetID !== "string") return legacyBudgetVersion()

  for (const entry of Array.isArray(snapshot.budgetVersions) ? snapshot.budgetVersions : []) {
    if (Array.isArray(entry) && entry.length === 2 && entry[0] === budgetID && isBudgetVersion(entry[1])) return entry[1]
  }

  return legacyBudgetVersion()
}

function mergeSessionSnapshot(current, next, deleted, changedParents) {
  if (!current) {
    const parentID = next.parentID && !deleted.has(next.parentID) ? next.parentID : undefined
    return { ...next, parentID }
  }

  const messages = new Map()
  for (const item of Array.isArray(current.messages) ? current.messages : []) {
    if (item?.id && typeof item.id === "string") messages.set(item.id, mergeMessageSnapshot(messages.get(item.id), item))
  }
  for (const item of Array.isArray(next.messages) ? next.messages : []) {
    if (item?.id && typeof item.id === "string") messages.set(item.id, mergeMessageSnapshot(messages.get(item.id), item))
  }

  let parentID = changedParents.has(next.id) ? (next.parentID ?? undefined) : current.parentID
  if (parentID && deleted.has(parentID)) parentID = undefined

  return {
    ...current,
    ...next,
    parentID,
    messages: [...messages.values()],
  }
}

function mergeMessageSnapshot(current, next) {
  if (!current) return next

  const stepCosts = new Map()
  for (const [stepID, cost] of validStepCosts(current.stepCosts)) stepCosts.set(stepID, cost)
  for (const [stepID, cost] of validStepCosts(next.stepCosts)) {
    const existing = stepCosts.get(stepID)
    stepCosts.set(stepID, Number.isFinite(existing) ? Math.max(existing, cost) : cost)
  }

  const costs = [current.messageCost, next.messageCost].filter(Number.isFinite)
  return {
    ...current,
    ...next,
    messageCost: costs.length > 0 ? Math.max(...costs) : 0,
    stepCosts: [...stepCosts.entries()],
  }
}

function validStepCosts(value) {
  return Array.isArray(value)
    ? value.filter((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && Number.isFinite(entry[1]))
    : []
}

function nextBudgetVersion(sequence) {
  return { time: Date.now(), sequence, id: crypto.randomBytes(8).toString("hex") }
}

function legacyBudgetVersion() {
  return { time: 0, sequence: 0, id: "" }
}

function isBudgetVersion(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isFinite(value.time) &&
    (value.sequence === undefined || Number.isFinite(value.sequence)) &&
    typeof value.id === "string"
  )
}

function budgetVersionSequenceOf(value) {
  return Number.isFinite(value?.sequence) ? value.sequence : 0
}

function compareBudgetVersions(left, right) {
  if (left.time !== right.time) return left.time - right.time
  const sequenceDiff = budgetVersionSequenceOf(left) - budgetVersionSequenceOf(right)
  if (sequenceDiff !== 0) return sequenceDiff
  return 0
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined
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
