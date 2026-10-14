import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useContext } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { useNowMinute } from "../../../hooks/useNowMinute";
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
  return (
    <main className="h-full space-y-6 overflow-auto p-6">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold">Crew runs</h1>
        <Link className="text-sm underline" to="/settings/crews">
          Crew settings
        </Link>
        <Button
          variant="outline"
          size="sm"
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
          Refresh
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
          <h2 className="font-medium">
            {project.title ?? project.id}{" "}
            <span className="text-xs text-muted-foreground">{project.environmentId}</span>
          </h2>
          {result._tag === "Failure" && (
            <p role="alert" className="text-sm">
              Could not load runs for this project.
            </p>
          )}
          {runs.length === 0 && result._tag !== "Failure" && (
            <p className="text-sm text-muted-foreground">
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
                  className="block space-y-1 rounded-lg border bg-card p-3 hover:bg-muted/40"
                >
                  <div className="flex flex-wrap gap-3 text-sm">
                    <span className="font-medium">{run.crewName}</span>
                    <span>{run.status}</span>
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
