import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useContext } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useEnvironments } from "../../../state/environments";
import { Badge } from "../../../components/ui/badge";
import { crewRuns } from "../composer/crewComposerState";
import { crewProjectRunsAtom, useCrewPreferences } from "./crewBoardState";

export function CrewsPage() {
  const runId = useParams({ strict: false, select: (params) => params.runId });
  return runId ? <Outlet /> : <CrewRunsList />;
}

function CrewRunsList() {
  const groups = useAtomValue(crewProjectRunsAtom);
  const registry = useContext(RegistryContext);
  const showRoleThreads = useCrewPreferences((state) => state.showRoleThreads);
  const setShowRoleThreads = useCrewPreferences((state) => state.setShowRoleThreads);
  const now = useNowMinute();
  const { environments } = useEnvironments();
  const refreshing = groups.some(({ result }) => result.waiting);
  return (
    <main className="h-full min-w-0 space-y-6 overflow-auto p-4 sm:p-6 [overflow-wrap:anywhere]">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold">Crew runs</h1>
        <Link
          className="rounded-sm text-sm underline underline-offset-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          to="/settings/crews"
        >
          Crew settings
        </Link>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing || groups.length === 0}
          onClick={() => {
            for (const { project } of groups)
              registry.refresh(
                crewRuns.list({
                  environmentId: project.environmentId,
                  input: { projectId: project.id },
                }),
              );
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </header>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={showRoleThreads} onCheckedChange={setShowRoleThreads} />
        Show crew role threads in sidebar
      </label>
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Connect an environment and add a project to see its crew runs.
        </p>
      )}
      {groups.map(({ project, runs, result }) => (
        <section key={`${project.environmentId}:${project.id}`} className="space-y-3">
          <h2 className="min-w-0 font-medium">
            {project.title ?? project.id}{" "}
            <span className="text-xs text-muted-foreground">
              {environments.find(
                (environment) => environment.environmentId === project.environmentId,
              )?.label ?? project.environmentId}
            </span>
          </h2>
          {result._tag === "Failure" && (
            <p role="alert" className="text-sm text-destructive-foreground">
              Could not load runs for this project. Check the environment connection and refresh.
            </p>
          )}
          {runs.length === 0 && result._tag !== "Failure" && (
            <p role="status" className="text-sm text-muted-foreground">
              {result._tag === "Initial"
                ? "Loading runs…"
                : "No crew runs yet. Choose a crew in a new thread's composer to start one."}
            </p>
          )}
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.runId}>
                <Link
                  to="/crews/$environmentId/$runId"
                  params={{ environmentId: project.environmentId, runId: run.runId }}
                  className="block min-w-0 space-y-1 rounded-lg border bg-card p-3 outline-none hover:bg-muted/40 active:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <div className="flex flex-wrap gap-3 text-sm">
                    <span className="font-medium">{run.crewName}</span>
                    <Badge
                      variant={
                        run.status === "failed"
                          ? "error"
                          : run.status === "completed"
                            ? "success"
                            : "secondary"
                      }
                    >
                      {run.status}
                    </Badge>
                    <span>{run.needsYou} needs you</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={<time className="text-muted-foreground" dateTime={run.createdAt} />}
                      >
                        Started{" "}
                        {Math.max(
                          0,
                          Math.floor(
                            (Date.parse(`${now}:00Z`) - Date.parse(run.createdAt)) / 60_000,
                          ),
                        )}{" "}
                        min ago
                      </TooltipTrigger>
                      <TooltipPopup>{run.createdAt}</TooltipPopup>
                    </Tooltip>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{run.brief}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
