import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import SessionBudget from "../.opencode/session-budget.js"
import { createBudgetState, normalizeOptions, runBudgetCommand } from "../.opencode/session-budget-core.js"

test("normalizes budget options", () => {
  assert.deepEqual(normalizeOptions({ defaultLimitUsd: "$0.25", includeChildSessions: false, commandName: "cost" }, {}), {
    commandName: "cost",
    defaultLimitUsd: 0.25,
    includeChildSessions: false,
  })

  assert.deepEqual(normalizeOptions({}, { OPENCODE_SESSION_BUDGET_USD: "0.5" }), {
    commandName: "budget",
    defaultLimitUsd: 0.5,
    includeChildSessions: true,
  })
})

test("locks a session when assistant message costs reach the limit", () => {
  const state = createBudgetState({ defaultLimitUsd: 0.05, includeChildSessions: true })

  state.upsertSession({ id: "session-1" })
  state.recordAssistantMessage({ role: "assistant", sessionID: "session-1", id: "message-1", cost: 0.02 })
  assert.equal(state.status("session-1").locked, false)

  state.recordAssistantMessage({ role: "assistant", sessionID: "session-1", id: "message-2", cost: 0.03 })

  const first = state.status("session-1")
  assert.equal(first.locked, true)
  assert.equal(first.justLocked, true)
  assert.equal(first.spentUsd, 0.05)

  const second = state.status("session-1")
  assert.equal(second.locked, true)
  assert.equal(second.justLocked, false)
})

test("ignores non-finite live costs", () => {
  const state = createBudgetState({ defaultLimitUsd: 0.01, includeChildSessions: true })

  state.recordAssistantMessage({ role: "assistant", sessionID: "session-1", id: "message-1", cost: Number.NaN })
  state.recordStepFinish({ type: "step-finish", sessionID: "session-1", messageID: "message-2", id: "step-1", cost: Infinity })

  assert.equal(state.spentUsd("session-1"), 0)
  assert.equal(state.status("session-1").locked, false)
})

test("includes child sessions in parent budget by default", () => {
  const state = createBudgetState({ defaultLimitUsd: 0.05, includeChildSessions: true })

  state.upsertSession({ id: "parent" })
  state.upsertSession({ id: "child", parentID: "parent" })
  state.recordAssistantMessage({ role: "assistant", sessionID: "parent", id: "message-1", cost: 0.02 })
  state.recordAssistantMessage({ role: "assistant", sessionID: "child", id: "message-2", cost: 0.03 })

  const result = state.status("child")
  assert.equal(result.locked, true)
  assert.equal(result.budgetID, "parent")
  assert.deepEqual(new Set(result.sessionIDs), new Set(["parent", "child"]))
})

test("does not resurrect deleted parent sessions from persisted state", () => {
  const state = createBudgetState({ includeChildSessions: true })

  state.upsertSession({ id: "parent" })
  state.upsertSession({ id: "child", parentID: "parent" })
  state.removeSession("parent")
  runBudgetCommand(state, "child", "0.05")

  const restored = createBudgetState({ includeChildSessions: true }, state.snapshot())
  const status = restored.status("child")

  assert.equal(status.budgetID, "child")
  assert.equal(status.limitUsd, 0.05)
  assert.deepEqual(status.sessionIDs, ["child"])
})

test("ignores malformed persisted state entries", () => {
  let warnings = 0
  const state = createBudgetState(
    { includeChildSessions: true },
    {
      version: 1,
      sessions: [
        {
          id: "session-1",
          parentID: "missing-parent",
          messages: [{ id: "message-1", messageCost: "bad", stepCosts: [null, ["step-1", 0.01]] }],
        },
      ],
      budgets: [null, ["session-1", 0.05], ["bad", "not-money"], ["free", 0]],
      lockedBudgets: [null, "session-1"],
    },
    () => warnings++,
  )

  const status = state.status("session-1")
  assert.equal(status.budgetID, "session-1")
  assert.equal(status.limitUsd, 0.05)
  assert.equal(status.spentUsd, 0.01)
  assert.equal(warnings, 1)
})

test("breaks cyclic restored parent links", () => {
  let warnings = 0
  const state = createBudgetState(
    { includeChildSessions: true },
    {
      version: 1,
      sessions: [
        { id: "a", parentID: "b", messages: [] },
        { id: "b", parentID: "a", messages: [] },
      ],
      budgets: [],
      lockedBudgets: [],
    },
    () => warnings++,
  )

  assert.equal(state.status("a").budgetID, "a")
  assert.equal(state.status("b").budgetID, "b")
  assert.equal(warnings, 1)
})

test("uses the larger of assistant message cost and summed step costs", () => {
  const state = createBudgetState({ defaultLimitUsd: 0.05, includeChildSessions: true })

  state.upsertSession({ id: "session-1" })
  state.recordStepFinish({ type: "step-finish", sessionID: "session-1", messageID: "message-1", id: "step-1", cost: 0.02 })
  state.recordStepFinish({ type: "step-finish", sessionID: "session-1", messageID: "message-1", id: "step-2", cost: 0.02 })
  assert.equal(state.spentUsd("session-1"), 0.04)

  state.recordAssistantMessage({ role: "assistant", sessionID: "session-1", id: "message-1", cost: 0.05 })
  assert.equal(state.spentUsd("session-1"), 0.05)
})

test("sets and clears a per-session budget through the budget command", () => {
  const state = createBudgetState({ includeChildSessions: true })

  state.upsertSession({ id: "session-1" })
  assert.match(runBudgetCommand(state, "session-1", "").message, /No budget set/)

  const set = runBudgetCommand(state, "session-1", "$0.05")
  assert.equal(set.status.limitUsd, 0.05)
  assert.equal(set.status.locked, false)

  state.recordAssistantMessage({ role: "assistant", sessionID: "session-1", id: "message-1", cost: 0.05 })
  assert.equal(state.status("session-1").locked, true)

  const raised = runBudgetCommand(state, "session-1", "set 0.10 usd")
  assert.equal(raised.status.limitUsd, 0.1)
  assert.equal(raised.status.locked, false)

  const cleared = runBudgetCommand(state, "session-1", "off")
  assert.equal(cleared.status.limitUsd, undefined)
  assert.equal(cleared.status.locked, false)
})

test("/budget off disables the env default for that session", () => {
  const state = createBudgetState({ defaultLimitUsd: 0.05, includeChildSessions: true })

  state.upsertSession({ id: "session-1" })
  assert.equal(state.status("session-1").limitUsd, 0.05)

  const cleared = runBudgetCommand(state, "session-1", "off")
  assert.equal(cleared.status.limitUsd, undefined)
  assert.equal(cleared.status.locked, false)
})

test("plugin entry exports only the plugin function", async () => {
  const mod = await import("../.opencode/session-budget.js")

  assert.deepEqual(Object.keys(mod), ["default"])
  assert.equal(typeof mod.default, "function")
})

test("plugin injects /budget and blocks work after session budget is reached", async () => {
  const aborted = []
  const logs = []
  const toasts = []
  const plugin = await SessionBudget(
    {
      client: {
        session: {
          abort: async ({ path }) => aborted.push(path.id),
        },
        app: {
          log: async ({ body }) => logs.push(body),
        },
        tui: {
          showToast: async ({ body }) => toasts.push(body),
        },
      },
    },
    { persistState: false },
  )

  const cfg = {}
  await plugin.config(cfg)
  assert.deepEqual(cfg.command.budget, {
    description: "Set or show the current session budget",
    template: "$ARGUMENTS",
  })

  await plugin.event({ event: { type: "session.created", properties: { info: { id: "session-1" } } } })

  await assert.rejects(
    () => plugin["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )

  await plugin.event({
    event: {
      type: "message.updated",
      properties: { info: { role: "assistant", sessionID: "session-1", id: "message-1", cost: 0.02 } },
    },
  })

  assert.deepEqual(aborted, ["session-1"])
  assert.equal(logs.length, 2)
  assert.equal(toasts.length, 2)

  await assert.rejects(
    () => plugin["tool.execute.before"]({ tool: "bash", sessionID: "session-1", callID: "call-1" }, { args: {} }),
    /Budget limit reached/,
  )

  await assert.rejects(
    () => plugin["shell.env"]({ cwd: "/tmp", sessionID: "session-1" }, { env: {} }),
    /Budget limit reached/,
  )
})

test("plugin retries aborting locked sessions after abort failures", async () => {
  let attempts = 0
  const plugin = await SessionBudget(
    {
      client: {
        session: {
          abort: async () => {
            attempts++
            if (attempts === 1) throw new Error("transient abort failure")
          },
        },
        app: { log: async () => {} },
        tui: { showToast: async () => {} },
      },
    },
    { persistState: false },
  )

  await plugin.event({ event: { type: "session.created", properties: { info: { id: "session-1" } } } })
  await assert.rejects(
    () => plugin["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )

  await plugin.event({
    event: {
      type: "message.updated",
      properties: { info: { role: "assistant", sessionID: "session-1", id: "message-1", cost: 0.02 } },
    },
  })
  await plugin.event({
    event: {
      type: "message.part.updated",
      properties: { part: { type: "step-finish", sessionID: "session-1", messageID: "message-2", id: "step-1", cost: 0.01 } },
    },
  })

  assert.equal(attempts, 2)
})

test("plugin persists budget state outside the worktree by default", async (t) => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-"))
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await fs.rm(worktree, { recursive: true, force: true })
    await fs.rm(stateHome, { recursive: true, force: true })
  })

  const client = {
    session: { abort: async () => {} },
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
  }

  let plugin = await SessionBudget({ client, worktree, directory: worktree }, {})
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "session-1" } } } })
  await assert.rejects(
    () => plugin["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )
  await plugin.event({
    event: {
      type: "message.updated",
      properties: { info: { role: "assistant", sessionID: "session-1", id: "message-1", cost: 0.02 } },
    },
  })
  await waitFor(async () => {
    const snapshot = JSON.parse(await fs.readFile(defaultStatePath(stateHome, worktree), "utf8"))
    const session = snapshot.sessions.find((item) => item.id === "session-1")
    const message = session?.messages.find((item) => item.id === "message-1")
    return message?.messageCost === 0.02
  })
  assert.equal(await pathExists(path.join(worktree, ".opencode", "session-budget-state.json")), false)
  assert.equal(await pathExists(defaultStatePath(stateHome, worktree)), true)

  plugin = await SessionBudget({ client, worktree, directory: worktree }, {})

  await assert.rejects(
    () => plugin["tool.execute.before"]({ tool: "bash", sessionID: "session-1", callID: "call-1" }, { args: {} }),
    /Budget limit reached/,
  )
})

test("default persistence separates worktrees", async (t) => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-first-"))
  const second = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-second-"))
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await fs.rm(first, { recursive: true, force: true })
    await fs.rm(second, { recursive: true, force: true })
    await fs.rm(stateHome, { recursive: true, force: true })
  })

  const client = { session: { abort: async () => {} }, app: { log: async () => {} }, tui: { showToast: async () => {} } }
  const firstPlugin = await SessionBudget({ client, worktree: first, directory: first }, {})
  const secondPlugin = await SessionBudget({ client, worktree: second, directory: second }, {})

  await assert.rejects(
    () => firstPlugin["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )
  await assert.rejects(
    () => secondPlugin["command.execute.before"]({ command: "budget", sessionID: "session-2", arguments: "0.02" }, { parts: [] }),
    /Budget set to/,
  )

  assert.notEqual(defaultStatePath(stateHome, first), defaultStatePath(stateHome, second))
  assert.equal(await pathExists(defaultStatePath(stateHome, first)), true)
  assert.equal(await pathExists(defaultStatePath(stateHome, second)), true)
})

test("configured statePath persists relative to the worktree", async (t) => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-"))
  const statePath = "state/session-budget.json"
  t.after(async () => {
    await fs.rm(worktree, { recursive: true, force: true })
  })

  const client = { session: { abort: async () => {} }, app: { log: async () => {} }, tui: { showToast: async () => {} } }
  const plugin = await SessionBudget({ client, worktree, directory: worktree }, { statePath })

  await assert.rejects(
    () => plugin["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )

  assert.equal(await pathExists(path.join(worktree, statePath)), true)
})

test("disabled persistence does not write state", async (t) => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-"))
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await fs.rm(worktree, { recursive: true, force: true })
    await fs.rm(stateHome, { recursive: true, force: true })
  })

  const client = { session: { abort: async () => {} }, app: { log: async () => {} }, tui: { showToast: async () => {} } }
  const plugin = await SessionBudget({ client, worktree, directory: worktree }, { persistState: false })

  await assert.rejects(
    () => plugin["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )

  assert.equal(await pathExists(defaultStatePath(stateHome, worktree)), false)
})

test("concurrent plugin instances merge persisted state", async (t) => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-"))
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-budget-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  t.after(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await fs.rm(worktree, { recursive: true, force: true })
    await fs.rm(stateHome, { recursive: true, force: true })
  })

  const client = { session: { abort: async () => {} }, app: { log: async () => {} }, tui: { showToast: async () => {} } }
  const first = await SessionBudget({ client, worktree, directory: worktree }, {})
  const second = await SessionBudget({ client, worktree, directory: worktree }, {})

  await assert.rejects(
    () => first["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "0.01" }, { parts: [] }),
    /Budget set to/,
  )
  await assert.rejects(
    () => second["command.execute.before"]({ command: "budget", sessionID: "session-2", arguments: "0.02" }, { parts: [] }),
    /Budget set to/,
  )

  const restored = await SessionBudget({ client, worktree, directory: worktree }, {})
  await assert.rejects(
    () => restored["command.execute.before"]({ command: "budget", sessionID: "session-1", arguments: "status" }, { parts: [] }),
    /Budget is \$0\.0100/,
  )
  await assert.rejects(
    () => restored["command.execute.before"]({ command: "budget", sessionID: "session-2", arguments: "status" }, { parts: [] }),
    /Budget is \$0\.0200/,
  )
})

async function pathExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function defaultStatePath(stateHome, worktree) {
  const key = crypto.createHash("sha256").update(worktree).digest("hex")
  return path.join(stateHome, "opencode-session-budget", `${key}.json`)
}

async function waitFor(predicate) {
  const started = Date.now()
  while (Date.now() - started < 1000) {
    try {
      if (await predicate()) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("condition was not met before timeout")
}
