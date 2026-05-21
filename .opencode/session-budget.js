import { createSessionBudgetPlugin } from "./session-budget-core.js"

export default async function SessionBudget(input, options) {
  return createSessionBudgetPlugin(input, options)
}
