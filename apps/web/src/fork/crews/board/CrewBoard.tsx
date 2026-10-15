import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { crewRunActivity } from "@t3tools/client-runtime/fork/crews/runs";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { CrewRunCard, CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { memo, useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useThreadShell } from "../../../state/entities";
import { crewRuns } from "../composer/crewComposerState";
import {
  crewAttemptLabels,
  crewBoardColumns,
  crewBudgetLabel,
  crewCardActions,
  crewCardElapsed,
  crewCounterLabel,
  crewLaneLabel,
} from "./crewBoard.logic";
import { useCrewControl, useCrewLive, type CrewControl } from "./crewBoardState";
import { CrewBudgetGate, CrewConfirm, CrewGateActions } from "./CrewControls";
import { CrewModelLabel, CrewRoleModel } from "./CrewModel";
import { openCrewBoard } from "./openCrewBoard";

export function CrewThreadLink({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  children: React.ReactNode;
}) {
  return (
    <Link
      className="rounded-sm text-xs text-primary underline underline-offset-2 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-ring"
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
    >
      {children}
    </Link>
  );
}

function CrewActivity({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  return <span>{shell?.latestRun?.status ?? "Idle"}</span>;
}

function FrozenToolbox({
  environmentId,
  view,
  roleId,
}: {
  environmentId: EnvironmentId;
  view: CrewRunView;
  roleId: string;
}) {
  const result = useAtomValue(crewRuns.get({ environmentId, input: { runId: view.runId } }));
  const toolbox = Option.getOrNull(AsyncResult.value(result))?.roles.find(
    (role) => role.id === roleId,
  )?.toolbox;
  if (!toolbox)
    return (
      <p
        role={result._tag === "Failure" ? "alert" : "status"}
        className="text-xs text-muted-foreground"
      >
        {result._tag === "Failure"
          ? "Could not load this run's toolbox."
          : result._tag === "Success"
            ? "No toolbox was recorded for this role."
            : "Loading run toolbox…"}
      </p>
    );
  return (
    <section className="space-y-2" aria-label="Frozen run toolbox">
      <p className="text-xs text-muted-foreground">Toolbox used by this run · {view.toolboxMode}</p>
      {(["skills", "mcp", "tools"] as const).map((kind) => (
        <div key={kind} className="space-y-1">
          <h4 className="text-xs font-medium">{kind === "mcp" ? "MCP servers" : kind}</h4>
          <div className="flex flex-wrap gap-1">
            {toolbox[kind].map((item) => (
              <Tooltip key={item.name}>
                <TooltipTrigger
                  render={<Badge variant="secondary" tabIndex={0} className="min-w-0 max-w-full" />}
                >
                  <span className="min-w-0 max-w-48 truncate">
                    {item.name} · {item.source === "home" ? "T3 home" : item.source}
                  </span>
                </TooltipTrigger>
                <TooltipPopup>
                  {"path" in item
                    ? item.path
                    : "command" in item
                      ? [item.command, ...item.args].join(" ")
                      : item.run}
                </TooltipPopup>
              </Tooltip>
            ))}
            {toolbox[kind].length === 0 && (
              <span className="text-xs text-muted-foreground">None</span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

const BoardCard = memo(function BoardCard({
  environmentId,
  view,
  card,
  control,
  now,
}: {
  environmentId: EnvironmentId;
  view: CrewRunView;
  card: CrewRunCard;
  control: CrewControl;
  now: string;
}) {
  const [details, setDetails] = useState(false);
  const actions = crewCardActions(card, view);
  const role = view.roles.find((candidate) => candidate.id === card.roleId);
  const terminal = ["completed", "failed", "cancelled"].includes(view.status);
  const resolver = view.cards.find(
    (candidate) =>
      candidate.sourceCardId === card.cardId && candidate.stepType === "task" && candidate.threadId,
  );
  return (
    <article
      className="min-w-0 space-y-2 rounded-lg border bg-card p-3 [overflow-wrap:anywhere]"
      aria-label={`${card.title ?? card.stepId}: ${crewLaneLabel(card)}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">{role?.name ?? card.stepType}</span>
        {card.modelSelection && (
          <CrewModelLabel environmentId={environmentId} selection={card.modelSelection} />
        )}
      </div>
      <h3 className="text-sm font-medium">
        {card.itemIndex !== null ? `#${card.itemIndex + 1} ` : ""}
        {card.title ?? card.stepId}
      </h3>
      <p className="text-xs">
        <span aria-hidden="true">● </span>
        {crewLaneLabel(card)}
        {card.lane === "working" && card.threadId && (
          <>
            {" "}
            · <CrewActivity environmentId={environmentId} threadId={card.threadId} />
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {crewAttemptLabels(card).map((label) => (
          <span key={label}>{label}</span>
        ))}
        <span>{crewCardElapsed(card, now)}</span>
        {card.changedFileCount != null && <span>{card.changedFileCount} files</span>}
      </div>
      {card.ownershipViolations.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <p
                tabIndex={0}
                className="rounded-sm text-xs text-warning-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
            }
          >
            Outside owned paths: {card.ownershipViolations.length}
          </TooltipTrigger>
          <TooltipPopup>{card.ownershipViolations.join("\n")}</TooltipPopup>
        </Tooltip>
      )}
      {card.decidedBy && (
        <p className="text-xs">
          Decided by {card.decidedBy === "user" ? "you" : "lead"}
          {card.outcome ? `: ${card.outcome}` : ""}
        </p>
      )}
      {card.note && !card.gate && <p className="text-xs text-muted-foreground">{card.note}</p>}
      {!terminal && <CrewGateActions card={card} control={control} />}
      {card.stepType === "script" && (
        <div className="space-y-1 text-xs">
          <p>
            {card.scriptExitCode !== undefined
              ? `Exit ${card.scriptExitCode}`
              : card.lane === "working"
                ? "Script running"
                : card.lane === "queued"
                  ? "Script queued"
                  : crewLaneLabel(card)}
          </p>
          {card.summary && (
            <details>
              <summary className="cursor-pointer rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
                Output tail
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                {card.summary}
              </pre>
            </details>
          )}
        </div>
      )}
      {card.stepType === "merge" && (
        <div className="space-y-1 text-xs">
          <p>{card.mergedCount ?? 0} branches merged</p>
          {(card.conflictPaths?.length ?? 0) > 0 && (
            <ul className="list-inside list-disc">
              {card.conflictPaths!.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
          {resolver?.threadId && (
            <CrewThreadLink environmentId={environmentId} threadId={resolver.threadId}>
              Open resolver thread
            </CrewThreadLink>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {card.threadId && (
          <CrewThreadLink environmentId={environmentId} threadId={card.threadId}>
            Open thread
          </CrewThreadLink>
        )}
        {actions.stop && (
          <CrewConfirm
            action={`${card.cardId}:stop`}
            label="Stop"
            disabled={control.disabled}
            onConfirm={() => void control.send({ type: "stopCard", cardId: card.cardId })}
          />
        )}
        {actions.retry && (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={control.disabled}
              onClick={() => void control.send({ type: "retryCard", cardId: card.cardId })}
            >
              Retry
            </Button>
            <CrewConfirm
              action={`${card.cardId}:skip`}
              label="Skip"
              disabled={control.disabled}
              onConfirm={() => void control.send({ type: "skipCard", cardId: card.cardId })}
            />
          </>
        )}
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          {details ? "Hide details" : "Details & actions"}
        </Button>
      </div>
      {details && (
        <div className="min-w-0 space-y-3 border-t pt-2">
          {card.summary && card.stepType !== "script" && (
            <p className="whitespace-pre-wrap text-xs">{card.summary}</p>
          )}
          {card.decidedBy && card.note && <p className="text-xs">{card.note}</p>}
          {actions.retry && (
            <div className="flex flex-wrap gap-1">
              {(card.outcomes?.length ? card.outcomes : ["done"]).map((outcome) => (
                <CrewConfirm
                  key={outcome}
                  action={`${card.cardId}:force:${outcome}`}
                  label={`Force ${outcome}`}
                  size="sm-multiline"
                  disabled={control.disabled}
                  onConfirm={() =>
                    void control.send({ type: "forceOutcome", cardId: card.cardId, outcome })
                  }
                />
              ))}
            </div>
          )}
          {card.roleId && (
            <>
              <FrozenToolbox environmentId={environmentId} view={view} roleId={card.roleId} />
              {!terminal && (
                <CrewRoleModel
                  environmentId={environmentId}
                  view={view}
                  roleId={card.roleId}
                  control={control}
                />
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
});

function BoardColumn({
  column,
  environmentId,
  view,
  control,
  now,
}: {
  column: ReturnType<typeof crewBoardColumns>[number];
  environmentId: EnvironmentId;
  view: CrewRunView;
  control: CrewControl;
  now: string;
}) {
  const [showDone, setShowDone] = useState(false);
  const done = column.cards.filter((card) => card.lane === "done" || card.lane === "skipped");
  const collapse = done.length > 8;
  const visible =
    collapse && !showDone
      ? column.cards.filter((card) => card.lane !== "done" && card.lane !== "skipped")
      : column.cards;
  return (
    <section className="min-w-0 space-y-3" aria-label={column.label}>
      <h2 className="text-sm font-medium">
        {column.label} <span className="text-muted-foreground">{column.cards.length}</span>
      </h2>
      {column.cards.length === 0 && (
        <p className="text-xs text-muted-foreground">No cards in this column.</p>
      )}
      {visible.map((card) => (
        <BoardCard key={card.cardId} {...{ card, environmentId, view, control, now }} />
      ))}
      {collapse && (
        <Button
          size="sm-multiline"
          variant="ghost"
          aria-expanded={showDone}
          onClick={() => setShowDone(!showDone)}
        >
          {showDone ? "Hide finished cards" : `Show ${done.length} finished cards`}
        </Button>
      )}
    </section>
  );
}

export function CrewBoard({
  environmentId,
  ...input
}: {
  environmentId: EnvironmentId;
} & ({ runId: string } | { threadId: ThreadId })) {
  const { view, result } = useCrewLive(environmentId, input);
  if (!view)
    return (
      <div className="space-y-3 p-6 text-sm">
        <p role={result?._tag === "Failure" ? "alert" : "status"}>
          {result?._tag === "Failure"
            ? "Could not load this crew run. Check the environment connection."
            : result?._tag === "Success"
              ? "threadId" in input
                ? "No crew run is linked to this thread."
                : "This crew run could not be found."
              : "Loading crew run…"}
        </p>
        <Button variant="outline" size="sm" render={<Link to="/crews" />}>
          Crew runs
        </Button>
      </div>
    );
  return (
    <LiveCrewBoard
      key={`${environmentId}:${view.runId}`}
      environmentId={environmentId}
      view={view}
      disconnected={result?._tag === "Failure"}
      inPanel={"threadId" in input}
    />
  );
}

function LiveCrewBoard({
  environmentId,
  view,
  disconnected,
  inPanel,
}: {
  environmentId: EnvironmentId;
  view: CrewRunView;
  disconnected: boolean;
  inPanel: boolean;
}) {
  const commands = useCrewControl(environmentId, view.runId);
  const control = { ...commands, disabled: commands.disabled || disconnected };
  const now = useNowMinute();
  const navigate = useNavigate();
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const needsYou = crewRunActivity(view).needsYou;
  const lead = view.roles.find((role) => role.id === view.leadRoleId);
  const terminal = ["completed", "failed", "cancelled"].includes(view.status);
  const columns = crewBoardColumns(view, needsYouOnly);
  return (
    <main
      className="@container h-full min-h-0 min-w-0 overflow-auto [overflow-wrap:anywhere]"
      aria-label={`${view.crewName} board`}
    >
      <header className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            className="rounded-sm text-xs underline underline-offset-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            to="/crews"
          >
            Crew runs
          </Link>
          {inPanel ? (
            <Link
              className="rounded-sm text-xs underline underline-offset-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              to="/crews/$environmentId/$runId"
              params={{ environmentId, runId: view.runId }}
            >
              Full page
            </Link>
          ) : view.homeThreadId ? (
            <Button
              size="sm-multiline"
              variant="outline"
              onClick={() => void navigate(openCrewBoard(environmentId, view))}
            >
              Open beside home thread
            </Button>
          ) : null}
          <h1 className="min-w-0 text-lg font-semibold">{view.crewName}</h1>
          <Badge variant="secondary">{view.status}</Badge>
          <code className="break-all text-xs">
            {view.integrationBranch ?? "Preparing workspace"}
          </code>
          <span className="text-xs">
            {view.cards.filter((card) => card.lane === "done").length}/{view.cards.length} done
          </span>
        </div>
        {disconnected && (
          <p role="alert" className="text-sm text-warning-foreground">
            Connection interrupted. Showing the last received state.
          </p>
        )}
        <p className="break-words text-sm text-muted-foreground">{view.brief}</p>
        {lead && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Lead: {lead.name}</span>
            <CrewModelLabel environmentId={environmentId} selection={lead.modelSelection} />
            {view.homeThreadId && (
              <>
                <CrewActivity environmentId={environmentId} threadId={view.homeThreadId} />
                <CrewThreadLink environmentId={environmentId} threadId={view.homeThreadId}>
                  Lead thread
                </CrewThreadLink>
              </>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {view.routes.map((route) => (
            <details key={route.id} className="min-w-0 text-xs">
              <summary className="cursor-pointer rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
                {crewCounterLabel(route)}
              </summary>
              <CrewConfirm
                action={`${view.runId}:${route.id}:reset`}
                label="Reset counter"
                disabled={control.disabled || terminal}
                onConfirm={() => void control.send({ type: "resetRoute", routeId: route.id })}
              />
            </details>
          ))}
          {(["cards", "hours"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-xs">
              {crewBudgetLabel(view.budget[kind], kind === "hours" ? "h" : "cards")}
              <meter
                aria-label={`${kind} budget`}
                min={0}
                max={Math.max(1, view.budget[kind].limit)}
                value={view.budget[kind].used}
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!terminal && (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={control.disabled}
                onClick={() =>
                  void control.send({ type: view.status === "paused" ? "resume" : "pause" })
                }
              >
                {view.status === "paused" ? "Resume" : "Pause"}
              </Button>
              <CrewConfirm
                action={`${view.runId}:cancel`}
                label="Cancel run"
                disabled={control.disabled}
                onConfirm={() => void control.send({ type: "cancel" })}
              />
            </>
          )}
          {view.homeThreadId && (
            <CrewThreadLink environmentId={environmentId} threadId={view.homeThreadId}>
              Home thread
            </CrewThreadLink>
          )}
          <Button
            size="xs"
            variant={needsYouOnly ? "secondary" : "outline"}
            aria-pressed={needsYouOnly}
            onClick={() => setNeedsYouOnly(!needsYouOnly)}
          >
            Needs you ({needsYou})
          </Button>
          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
              Run options
            </summary>
            <p>Toolbox mode: {view.toolboxMode}</p>
          </details>
        </div>
      </header>
      {control.pending && (
        <p role="status" className="px-4 pt-3 text-xs text-muted-foreground">
          Updating crew run…
        </p>
      )}
      <div className="space-y-4 p-4">
        {columns.length === 0 && !needsYouOnly && (
          <p role="status" className="text-sm text-muted-foreground">
            No cards in this run.
          </p>
        )}
        {!terminal && view.budget.gate && (
          <CrewBudgetGate key={view.budget.gate.kind} view={view} control={control} />
        )}
        {needsYouOnly && columns.every((column) => column.cards.length === 0) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {view.budget.gate
              ? "Only the budget needs your attention."
              : "No cards need your attention."}
          </p>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {columns.map((column) => (
              <BoardColumn key={column.id} {...{ column, environmentId, view, control, now }} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
