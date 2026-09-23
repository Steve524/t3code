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
