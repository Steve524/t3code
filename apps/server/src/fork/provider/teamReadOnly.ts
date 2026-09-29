/** Tools that only read the disk or the web. Claude still asks before using some of them. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

/**
 * The server's answer to an approval request from a read-only worker in the planner's checkout.
 * `detail` is the adapter's `<Tool>: <input>` summary; anything else is declined, so a changed
 * summary format fails closed.
 */
export const readOnlyApprovalDecision = (detail: unknown): "accept" | "decline" =>
  typeof detail === "string" && READ_TOOLS.has(detail.split(":", 1)[0]!) ? "accept" : "decline";

/** Appends the plan's current text for a reviewer that can't see the planner's checkout. */
export const withPlanText = (
  text: string,
  plan: { readonly path: string; readonly text: string },
) =>
  `${text}\n\n---\nThe plan to review, \`${plan.path}\`, as of this message. The file isn't in your worktree, so review this text:\n\n${plan.text}`;

/** The first task for a read-only worker in an isolated worktree. */
export const isolatedReadOnlyTask = (task: string, baseBranch: string) =>
  `${task}\n\n---\nYou run in an isolated worktree of \`${baseBranch}\` at its last commit, because this provider can't be held to read-only in the planner's checkout. The planner's uncommitted files aren't here; if a finding depends on them, list that under limitations. Nothing you change here reaches the project, and the worktree is deleted when you're stopped.`;
