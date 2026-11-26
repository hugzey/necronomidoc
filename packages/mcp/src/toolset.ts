import { checkChange } from "./change.js";
import { whatChangedSince } from "./changes.js";
import { getSessionChecks } from "./checks.js";
import { getContextForTask, getRecipes } from "./context.js";
import { isThisADuplicate } from "./duplicates.js";
import { coreTools } from "./tools.js";

/**
 * Every read-only MCP tool, by name: the ten established documentation tools
 * plus the task-shaped agent tools of decision 0024. Each takes the store and
 * its arguments and returns a JSON-serializable result.
 */
export const tools = {
  ...coreTools,
  get_context_for_task: getContextForTask,
  get_recipes: getRecipes,
  what_changed_since: whatChangedSince,
  check_change: checkChange,
  is_this_a_duplicate: isThisADuplicate,
  get_session_checks: getSessionChecks,
};
