import type { CrewFile } from "../../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import type { ModelSelection } from "../../../../../../packages/contracts/src/modelSelection.ts";
import type { CompiledCrewFlow } from "../../../../../../packages/shared/src/fork/crews/compileCrewFlow.ts";

export type BudgetKind = "maxCards" | "maxHours" | "maxFanoutItems";
type Parent = { groupId: string; branch: number };
type CardRef = { cardId: string; attempt: number };
type Report = { outcome: string; summary: string; artifacts: Record<string, unknown> };

export interface CrewCard {
  id: string;
  stepId: string;
  visit: number;
  type: "task" | "fanout" | "script" | "merge" | "gate" | "decision";
  parent: Parent | null;
  itemIndex: number | null;
  item: unknown;
  roleId: string | null;
  instanceId: string | null;
  isolation: "shared" | "worktree" | "read-only";
  state:
    | "queued"
    | "dispatching"
    | "working"
    | "reported"
    | "blocked"
    | "needs_you"
    | "waiting_lead"
    | "done"
    | "skipped"
    | "stopping"
    | "cancelled";
  attempt: number;
  reminderSent: boolean;
  followUp: "reminder" | "retry" | null;
  threadId: string | null;
  orchestrationRunId: string | null;
  report: Report | null;
  outcome: string | null;
  sourceCardId: string | null;
  decidedBy: "user" | "lead" | null;
  note: string | null;
}

export interface CrewGroup {
  id: string;
  stepId: string;
  visit: number;
  parent: Parent | null;
  mode: "all" | "any";
  state: "blocked" | "active" | "done";
  total: number;
  finished: number[];
  items: unknown[];
}

/** The role that runs in the home thread for the whole run, in lead mode. */
export interface CrewLead {
  roleId: string;
  canEdit: boolean;
  updates: "milestones" | "decisions";
  // The turn the crew started in the home thread and waits on. Nothing else is sent there
  // until it ends, which is what batches the digest.
  turn: {
    id: number;
    kind: "kickoff" | "update" | "decision" | "reminder";
    cardId: string | null;
  } | null;
  // Milestones the lead has not been sent yet.
  digest: string[];
}

export interface CrewSnapshot {
  crew: CrewFile;
  flow: CompiledCrewFlow;
  homeMode: "first-step" | "lead";
  // Absent in runs started before lead mode existed, which are all first-step.
  lead?: CrewLead | null;
  status: "pending" | "running" | "paused" | "waiting" | "completed" | "failed" | "cancelled";
  paused: boolean;
  lastEventSeq: number;
  lastEventAt: number | null;
  activeSince: number | null;
  visits: Record<string, number>;
  cards: CrewCard[];
  groups: CrewGroup[];
  pendingSteps: { stepId: string; parent: Parent | null }[];
  artifacts: Record<string, unknown>;
  routeCounters: Record<string, number>;
  roleInstances: Record<string, string>;
  // The instances a role's fan-out cards are spread over, when it has more than one.
  rolePools: Record<string, string[]>;
  roleModels: Record<string, ModelSelection>;
  providerCaps: Record<string, number>;
  budget: {
    limits: Record<BudgetKind, number>;
    extensions: Record<BudgetKind, number>;
    cards: number;
    activeSeconds: number;
  };
  budgetGate: {
    kind: BudgetKind;
    by: "user";
    groupId: string | null;
    total: number | null;
    choices: string[];
  } | null;
}

// Lifecycle facts accompany the snapshot for the future transaction/outbox owner.
export type CrewFact =
  | { type: "run.created" }
  | { type: "step.entered"; stepId: string; visit: number }
  | { type: "card.created"; card: CrewCard }
  | ({ type: "card.dispatched"; threadId: string; orchestrationRunId: string } & CardRef)
  | ({ type: "card.reported" } & CardRef & Report)
  | ({
      type: "card.turn_finished";
      status: "completed" | "failed" | "cancelled" | "interrupted";
    } & CardRef)
  | ({ type: "card.reminder_sent" } & CardRef)
  | ({ type: "card.completed"; outcome: string } & CardRef)
  | ({ type: "card.failed"; reason: string } & CardRef)
  | { type: "merge.started"; cardId: string }
  | { type: "merge.card_merged"; cardId: string; sourceCardId: string }
  | { type: "merge.conflict"; cardId: string; paths: string[] }
  | { type: "merge.resolved"; cardId: string }
  | { type: "merge.blocked"; cardId: string; reason: string }
  | ({ type: "script.finished"; exitCode: number; outputTail: string } & CardRef)
  | { type: "gate.opened"; cardId: string; prompt: string; outcomes: string[]; by: "user" | "lead" }
  | { type: "gate.resolved"; cardId: string; outcome: string; note: string; by: "user" | "lead" }
  | { type: "gate.escalated"; cardId: string; reason: string }
  | { type: "route.limit_reached"; routeId: string }
  | {
      type: "route.counters_reset";
      regionId: string;
      routeIds: string[];
      cause: "gate" | "step" | "user";
    }
  | { type: "budget.exhausted"; kind: BudgetKind }
  | { type: "budget.extended"; kind: BudgetKind; by: number }
  | { type: "lead.kickoff_finished" }
  | { type: "lead.update_queued"; milestone: string }
  | { type: "lead.update_delivered" }
  | { type: "run.paused" }
  | { type: "run.resumed" }
  | { type: "run.cancel_requested" }
  | { type: "run.completed" }
  | { type: "run.failed"; reason: string }
  | {
      type: "user.card_action";
      cardId: string;
      action: "retry" | "skip" | "force_outcome";
      outcome?: string;
    }
  | { type: "user.role_model_changed"; roleId: string; selection: ModelSelection };

export type CrewEvent = (
  | CrewFact
  | {
      type: "budget.fanout_selected";
      groupId: string;
      choice: "all" | "first" | "stop";
      count?: number;
    }
  // The home thread's turn that `turnId` names ended.
  | { type: "lead.turn_finished"; turnId: number }
) & {
  // Ordered input events, with milliseconds supplied by the caller, never read by decide.
  seq: number;
  at: number;
};

export type CrewEffect =
  | ({ type: "launch_card" } & CardRef)
  | ({
      type: "send_follow_up";
      threadId: string;
      reason: "continue" | "reminder" | "retry";
    } & CardRef)
  | ({ type: "stop_thread"; threadId: string | null } & CardRef)
  | ({ type: "commit_workspace"; when: "before_launch" | "after_turn" } & CardRef)
  | { type: "merge_branch"; cardId: string }
  | { type: "check_ownership"; cardId: string }
  | ({ type: "run_script" } & CardRef)
  | { type: "remove_worktree"; cardId: string }
  | { type: "deliver_notes"; cardId: string }
  // The three turns the crew starts in the home thread. `turnId` comes back in `lead.turn_finished`.
  | { type: "launch_lead"; turnId: number }
  | { type: "deliver_lead_update"; turnId: number; milestones: string[] }
  | {
      type: "send_decision_request";
      cardId: string;
      outcomes: string[];
      turnId: number;
      reminder: boolean;
    }
  | { type: "notify"; message: string; cardId?: string };
