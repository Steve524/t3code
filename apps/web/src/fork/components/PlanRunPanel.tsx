import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { planningPanelState } from "../planRunPanelState";

function ArtifactLink({
  environmentId,
  artifact,
}: {
  environmentId: EnvironmentId;
  artifact: ReturnType<typeof planningPanelState>["artifacts"][number];
}) {
  const resource = useMemo(
    () => ({ _tag: "attachment" as const, attachmentId: artifact.attachment.attachmentId }),
    [artifact.attachment.attachmentId],
  );
  const asset = useAssetUrlState(environmentId, resource);
  const label =
    artifact.kind === "research"
      ? "Research brief"
      : artifact.kind === "review"
        ? "Review result"
        : "Plan";
  return (
    <div className="space-y-0.5 border-t border-border/50 py-2 text-xs">
      <div>
        {asset._tag === "Success" ? (
          <a
            className="font-medium text-foreground underline"
            href={asset.url}
            download={artifact.attachment.fileName}
          >
            {label}
          </a>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        <span className="ml-2 text-muted-foreground">{artifact.attachment.fileName}</span>
      </div>
      <p className="break-all text-muted-foreground">{artifact.path}</p>
    </div>
  );
}

export function PlanRunPanel({
  activities,
  messages,
  environmentId,
  orchestratorBusy,
  onChooseNotes,
}: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  messages: ReadonlyArray<OrchestrationMessage>;
  environmentId: EnvironmentId;
  orchestratorBusy: boolean;
  onChooseNotes: (message: string) => Promise<boolean>;
}) {
  const { run, reviewAttempts, attempts, exhausted, artifacts, notesChoice } = useMemo(
    () => planningPanelState(activities, messages),
    [activities, messages],
  );
  const [destination, setDestination] = useState("");
  const [directory, setDirectory] = useState("");
  const [sending, setSending] = useState(false);
  const [choiceSent, setChoiceSent] = useState(false);
  const researchSaved = artifacts.some(({ kind }) => kind === "research");
  const selectedDestination = destination || notesChoice?.kind || "";
  const submittedChoice = (choiceSent || notesChoice !== null) && !destination;
  const needsRevision = run?.reviews.at(-1)?.verdict?.verdict === "REVISE" && !exhausted;
  const submitNotes = async () => {
    if (!destination || (destination === "custom" && !directory.trim()) || sending) return;
    const location =
      destination === "temporary"
        ? "temporary notes outside the repository"
        : destination === "project"
          ? "project research notes under docs/research"
          : `the custom directory ${JSON.stringify(directory.trim())}`;
    setSending(true);
    try {
      if (
        await onChooseNotes(
          `For this Research and plan run, save the research brief in ${location}. Confirm the resolved destination before export.`,
        )
      ) {
        setChoiceSent(true);
        setDestination("");
        setDirectory("");
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-h-96 space-y-3 overflow-y-auto border-b border-border/60 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">Planning run</span>
        <span className="text-muted-foreground">
          {exhausted
            ? "Review limit reached"
            : needsRevision && run?.phase === "blocked"
              ? "Needs revision"
              : (run?.phase ?? "Waiting to start")}
        </span>
        {run ? (
          <span className="text-muted-foreground">
            Review {attempts}/{run.workflow.maxReviewRounds}
          </span>
        ) : null}
        {run?.plan ? <span className="text-muted-foreground">Plan v{run.plan.version}</span> : null}
      </div>
      {reviewAttempts.map((attempt, index) => {
        const review = run?.reviews.find(({ requestId }) => requestId === attempt.requestId);
        return (
          <p key={attempt.requestId} className="text-xs text-muted-foreground">
            Round {index + 1}:{" "}
            {review?.error ??
              (review?.verdict
                ? `${review.verdict.verdict}${review.verdict.summary ? `: ${review.verdict.summary}` : ""}`
                : (attempt.error ?? attempt.status))}
          </p>
        );
      })}
      {exhausted ? <p className="text-xs text-destructive">Review budget exhausted.</p> : null}
      {run?.phase === "blocked" && !exhausted && !needsRevision ? (
        <p className="text-xs text-destructive">
          The run is blocked. Open the latest team update for details.
        </p>
      ) : null}
      {run?.phase === "cancelled" ? (
        <p className="text-xs text-muted-foreground">The run was cancelled.</p>
      ) : null}
      {submittedChoice && !researchSaved ? (
        <p className="text-xs text-muted-foreground">
          Notes choice submitted{notesChoice ? `: ${notesChoice.label}` : ""}. The coordinator will
          confirm the destination.
        </p>
      ) : null}
      {!researchSaved && run?.phase !== "approved" && run?.phase !== "cancelled" ? (
        <div className="space-y-2 rounded-lg border border-border/60 p-2">
          <p className="text-xs font-medium">Research notes destination</p>
          <div className="flex flex-wrap gap-2">
            <Select
              value={selectedDestination}
              onValueChange={(value) => {
                setDestination(value ?? "");
                setChoiceSent(false);
              }}
            >
              <SelectTrigger size="sm" aria-label="Research notes destination">
                <SelectValue>
                  {selectedDestination === "temporary"
                    ? "Temporary"
                    : selectedDestination === "custom"
                      ? "Custom directory"
                      : selectedDestination === "project"
                        ? "Project research notes"
                        : "Choose a destination"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                <SelectItem value="temporary">Temporary</SelectItem>
                <SelectItem value="custom">Custom directory</SelectItem>
                <SelectItem value="project">Project research notes</SelectItem>
              </SelectPopup>
            </Select>
            {destination === "custom" ? (
              <Input
                size="sm"
                value={directory}
                onChange={(event) => {
                  setDirectory(event.target.value);
                  setChoiceSent(false);
                }}
                aria-label="Custom research notes directory"
                placeholder="Directory on this environment"
              />
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={
                !destination ||
                (destination === "custom" && !directory.trim()) ||
                sending ||
                orchestratorBusy
              }
              onClick={() => void submitNotes()}
            >
              {sending ? "Sending…" : submittedChoice ? "Choice submitted" : "Send choice"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Relative paths resolve from the selected project root.
          </p>
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div>
          <p className="text-xs font-medium">Saved artifacts</p>
          {artifacts.map((artifact) => (
            <ArtifactLink
              key={artifact.artifactId}
              environmentId={environmentId}
              artifact={artifact}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
