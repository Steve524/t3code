# Team Workflow

On web and desktop, choose **New orchestrator thread** beside a project or in the
command palette. You can also open a draft and select **Full-stack team** from the
**Workflow** menu before sending the first message. The model selected in the composer
coordinates the work and delegates it to separate worker threads.

Open **Settings → Workflows** for the selected environment to choose each role's
provider, model, effort, permissions, and instructions. Changes apply to new teams;
an existing orchestrator keeps the workflow it started with.

Follow workers from the orchestrator's **Team** panel. T3 Code integrates completed
worker branches into a dedicated integration branch, but never merges that branch
into the base branch. When the orchestrator reports that review passed, inspect and
merge the integration branch yourself. Mobile can view the threads and team updates,
but starting and configuring workflows requires web or desktop.

Workflow workers are separate threads; follow them from their orchestrator's
**Team** panel instead of the **Agents** panel.

## Research and plan skill

Select **Research and plan** when creating an orchestrator thread. Configure the
planner, reviewer, and researcher models in **Settings → Workflows** before starting
the thread. Send a planning request, or use `/t3-plan-loop <request>` in that
orchestrator thread. You can include `mode=review` for an existing plan and
`research=none`, `research=web`, or `research=deep`. Choose where research notes
should be saved when prompted. A worker thread or another workflow cannot start
this protocol.

T3 Code bundles the skill. To make the same instructions available in an agent's
own skill catalog, copy the entire
[`t3-plan-loop` package](../../apps/server/src/fork/skills/t3-plan-loop/SKILL.md)
(also shipped at `dist/skills/t3-plan-loop/` in the server package) to one of
these locations:

| Agent       | Project scope                  | User scope                       | Native invocation |
| ----------- | ------------------------------ | -------------------------------- | ----------------- |
| Codex       | `.agents/skills/t3-plan-loop/` | `~/.agents/skills/t3-plan-loop/` | `$t3-plan-loop`   |
| Claude Code | `.claude/skills/t3-plan-loop/` | `~/.claude/skills/t3-plan-loop/` | `/t3-plan-loop`   |
| Cursor      | `.cursor/skills/t3-plan-loop/` | `~/.cursor/skills/t3-plan-loop/` | `/t3-plan-loop`   |

The package version must match the workflow's saved protocol version. To remove
an installed copy, delete only its `t3-plan-loop/` directory. Installing the
package does not create a T3 connection or team credentials; its planning
workflow runs only in a compatible T3 orchestrator thread. The command reports
missing guarded planning capabilities until the server provides them.
