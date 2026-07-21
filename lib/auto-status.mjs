/**
 * Pure status resolution for /auto (P0.5 truthful orchestration).
 * COMPLETE requires pass=true; never COMPLETE with pass=false.
 */

/**
 * @param {{
 *   aborted?: boolean,
 *   authFail?: boolean,
 *   overBudget?: boolean,
 *   pass?: boolean,
 *   hasPartialOutput?: boolean,
 *   worktreeFailed?: boolean,
 * }} input
 * @returns {{ status: string, error?: string, pass: boolean }}
 */
export function resolveAutoStatus(input) {
  if (input.worktreeFailed) {
    return { status: "FAILED", error: "worktree_failed", pass: false };
  }
  if (input.aborted) {
    return { status: "ABORTED", pass: false };
  }
  if (input.authFail) {
    return { status: "AUTH_REQUIRED", error: "auth_required", pass: false };
  }
  if (input.overBudget) {
    return { status: "FAILED", error: "budget_exceeded", pass: false };
  }
  if (input.pass) {
    return { status: "COMPLETE", pass: true };
  }
  if (input.hasPartialOutput) {
    return { status: "PARTIAL", error: "requirements_not_met", pass: false };
  }
  return { status: "FAILED", error: "failed", pass: false };
}
