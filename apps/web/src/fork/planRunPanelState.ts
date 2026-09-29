import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RunView = Schema.Struct({
  phase: Schema.Literals(["planning", "research", "review", "approved", "blocked", "cancelled"]),
  workflow: Schema.Struct({ maxReviewRounds: Schema.Int }),
  plan: Schema.NullOr(Schema.Struct({ version: Schema.Int, hash: Schema.String })),
  reservations: Schema.Array(
    Schema.Struct({
      requestId: Schema.String,
      purpose: Schema.String,
      status: Schema.String,
      error: Schema.NullOr(Schema.String),
    }),
  ),
  reviews: Schema.Array(
    Schema.Struct({
      requestId: Schema.String,
      verdict: Schema.NullOr(
        Schema.Struct({
          verdict: Schema.Literals(["APPROVED", "REVISE", "BLOCKED"]),
          summary: Schema.String,
        }),
      ),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});

const ArtifactView = Schema.Struct({
  artifactId: Schema.String,
  kind: Schema.Literals(["plan", "research", "review"]),
  path: Schema.String,
  temporary: Schema.Boolean,
  attachment: Schema.Struct({
    attachmentId: Schema.String,
    fileName: Schema.String,
  }),
  createdAt: Schema.String,
});

const decodeRun = Schema.decodeUnknownOption(RunView);
const decodeArtifact = Schema.decodeUnknownOption(ArtifactView);

type NotesChoice = { kind: "temporary" | "project" | "custom"; label: string };

function notesChoiceForAnswer(question: string, answer: string): NotesChoice | null {
  if (!question.toLowerCase().includes("research brief")) return null;
  if (answer === "Temporary directory") return { kind: "temporary", label: answer };
  if (answer === "Project directory") return { kind: "project", label: answer };
  if (answer === "Custom directory") return { kind: "custom", label: answer };
  return null;
}

function notesChoiceForMessage(text: string): NotesChoice | null {
  const prefix = "For this Research and plan run, save the research brief in ";
  if (!text.startsWith(prefix)) return null;
  const location = text.slice(prefix.length);
  if (location.startsWith("temporary notes outside the repository."))
    return { kind: "temporary", label: "Temporary directory" };
  if (location.startsWith("project research notes under docs/research."))
    return { kind: "project", label: "Project directory" };
  if (location.startsWith("the custom directory "))
    return { kind: "custom", label: "Custom directory" };
  return null;
}

export function planningPanelState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  messages: ReadonlyArray<OrchestrationMessage> = [],
) {
  let run: typeof RunView.Type | null = null;
  const selectedNotes = { choice: null as NotesChoice | null, at: "" };
  const rememberNotesChoice = (choice: NotesChoice | null, createdAt: string) => {
    if (choice && createdAt >= selectedNotes.at) {
      selectedNotes.choice = choice;
      selectedNotes.at = createdAt;
    }
  };
  const artifacts: (typeof ArtifactView.Type)[] = [];
  for (const activity of activities) {
    if (activity.kind === "team.plan-run.updated") {
      const decoded = decodeRun(activity.payload);
      if (Option.isSome(decoded)) run = decoded.value;
    } else if (activity.kind === "team.artifact.exported") {
      const decoded = decodeArtifact(activity.payload);
      if (Option.isSome(decoded)) artifacts.push(decoded.value);
    } else if (activity.kind === "user-input.resolved") {
      const payload = activity.payload;
      if (
        payload &&
        typeof payload === "object" &&
        "answers" in payload &&
        payload.answers &&
        typeof payload.answers === "object" &&
        !Array.isArray(payload.answers)
      ) {
        for (const [question, answer] of Object.entries(payload.answers)) {
          if (typeof answer === "string")
            rememberNotesChoice(notesChoiceForAnswer(question, answer), activity.createdAt);
        }
      }
    }
  }
  for (const message of messages) {
    if (message.role === "user")
      rememberNotesChoice(notesChoiceForMessage(message.text), message.createdAt);
  }
  const reviewAttempts = run?.reservations.filter(({ purpose }) => purpose === "reviewer") ?? [];
  const attempts = reviewAttempts.length;
  return {
    run,
    reviewAttempts,
    attempts,
    exhausted: run !== null && run.phase !== "approved" && attempts >= run.workflow.maxReviewRounds,
    artifacts,
    notesChoice: selectedNotes.choice,
  };
}
