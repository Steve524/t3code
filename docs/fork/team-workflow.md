# Team Workflow

On web and desktop, choose **New orchestrator thread** beside a project or in the
command palette. You can also open a draft and select a preset from the
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

Select **Research and plan** when creating a thread. Your starting chat is the
planner, using the model and permissions selected in the chat composer. Discuss
requirements, answer questions, and revise the plan in that chat. The planner
delegates research and independent review to separate worker threads and brings
their questions back to you.

Configure the reviewer and researcher models and the planner's instructions in
**Settings → Workflows** before starting the thread. Select the preset in that settings page to set its research depth, deep
research worker count, and review limit. Send a planning request, or use `/t3-plan-loop <request>` in that
planning chat. You can include `mode=review` for an existing plan and
`research=none`, `research=web`, or `research=deep`. Choose where research notes
should be saved in the Team panel or in your request. Temporary notes can be removed
by operating-system cleanup; custom directories resolve on the connected environment,
and project notes go under `docs/research`. The Team panel shows the run phase, review
rounds and verdicts, and links to saved artifacts. A worker thread or another workflow
cannot start this protocol.

Deep research uses the selected worker count and parallel limit. Each research worker can receive one follow-up before approval; failed attempts still count. The research lead receives the complete saved results for synthesis. Missing or unfinished results block synthesis instead of producing a brief from partial evidence.

Existing threads keep their saved workflow version. Start a new Research and plan
thread to use planning in the starting chat; older threads and their artifacts remain available.

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
workflow runs only in a compatible T3 orchestrator thread.
