# Team Workflow completion reports

The [team report reactor](../../apps/server/src/fork/orchestration/TeamReportReactor.ts) connects worker
threads back to their orchestrator without provider-specific polling or steering. It queues terminal
worker states, approval requests, and user-input requests from committed events. Once the
orchestrator is idle, it reads the projections, batches the pending signals into a contextual team
update, and starts the next orchestrator turn. Never inject a report into a running turn: the
[orchestrator instructions](../../apps/server/src/provider/RuntimeInstructions.ts) require the host
to end its turn after spawning workers so updates can resume it.

The reactor rebuilds unreported worker completions from projections after a restart. It also limits
automatic reports until the user sends another message and drops pending reports when the
orchestrator stops or is interrupted. Clients may render the context as a team card, while clients
without that presentation continue to show the message text.
