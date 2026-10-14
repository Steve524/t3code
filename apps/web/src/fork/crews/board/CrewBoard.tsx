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
      className="text-xs text-primary underline underline-offset-2"
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
      <p className="text-xs">
        {result._tag === "Failure" ? "Could not load this run's toolbox." : "Loading run toolbox…"}
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
                <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} />}>
                  {item.name} · {item.source === "home" ? "T3 home" : item.source}
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
  const resolver = view.cards.find(
    (candidate) =>
      candidate.sourceCardId === card.cardId && candidate.stepType === "task" && candidate.threadId,
  );
  return (
    <article
      className="space-y-2 rounded-lg border bg-card p-3"
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
          <TooltipTrigger render={<p className="text-xs text-warning" />}>
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
      <CrewGateActions card={card} control={control} />
      {card.stepType === "script" && (
        <div className="space-y-1 text-xs">
          <p>
            {card.scriptExitCode !== undefined
              ? `Exit ${card.scriptExitCode}`
              : "Script running or queued"}
          </p>
          {card.summary && (
            <details>
              <summary className="cursor-pointer">Output tail</summary>
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
        <div className="space-y-3 border-t pt-2">
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
              {!["completed", "failed", "cancelled"].includes(view.status) && (
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
    <section className="w-80 shrink-0 space-y-3" aria-label={column.label}>
      <h2 className="text-sm font-medium">
        {column.label} <span className="text-muted-foreground">{column.cards.length}</span>
      </h2>
      {visible.map((card) => (
        <BoardCard key={card.cardId} {...{ card, environmentId, view, control, now }} />
      ))}
      {collapse && (
        <Button size="sm" variant="ghost" onClick={() => setShowDone(!showDone)}>
          {showDone ? "Hide finished cards" : `Show ${done.length} done`}
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
      <div className="p-6">
        <p>
          {result?._tag === "Failure"
            ? "Could not load this crew run. Check the environment connection."
            : result?._tag === "Success"
              ? "No crew run is linked to this thread."
              : "Loading crew run…"}
        </p>
        <Link to="/crews">Crew runs</Link>
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
  const control = useCrewControl(environmentId, view.runId);
  const now = useNowMinute();
  const navigate = useNavigate();
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const needsYou = crewRunActivity(view).needsYou;
  const lead = view.roles.find((role) => role.id === view.leadRoleId);
  const terminal = ["completed", "failed", "cancelled"].includes(view.status);
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col" aria-label={`${view.crewName} board`}>
      <header className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link className="text-xs underline" to="/crews">
            Crew runs
          </Link>
          {inPanel ? (
            <Link
              className="text-xs underline"
              to="/crews/$environmentId/$runId"
              params={{ environmentId, runId: view.runId }}
            >
              Full page
            </Link>
          ) : view.homeThreadId ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate(openCrewBoard(environmentId, view))}
            >
              Open beside home thread
            </Button>
          ) : null}
          <h1 className="text-lg font-semibold">{view.crewName}</h1>
          <Badge variant="secondary">{view.status}</Badge>
          <code className="break-all text-xs">
            {view.integrationBranch ?? "Preparing workspace"}
          </code>
          <span className="text-xs">
            {view.cards.filter((card) => card.lane === "done").length}/{view.cards.length} done
          </span>
        </div>
        {disconnected && (
          <p role="alert" className="text-sm text-warning">
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
            <details key={route.id} className="text-xs">
              <summary className="cursor-pointer">{crewCounterLabel(route)}</summary>
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
            <summary className="cursor-pointer">Run options</summary>
            <p>Toolbox mode: {view.toolboxMode}</p>
          </details>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {view.budget.gate && <CrewBudgetGate view={view} control={control} />}
        <div className="flex items-start gap-4">
          {crewBoardColumns(view, needsYouOnly).map((column) => (
            <BoardColumn key={column.id} {...{ column, environmentId, view, control, now }} />
          ))}
        </div>
      </div>
    </main>
  );
}
