import type { CrewFile } from "../../../../../../packages/contracts/src/fork/crews/crewFile.ts";
import {
  crewStepIsolation,
  type CompiledCrewFlow,
} from "../../../../../../packages/shared/src/fork/crews/compileCrewFlow.ts";
import { detectCrewHome } from "../../../../../../packages/shared/src/fork/crews/crewHome.ts";
import type {
  BudgetKind,
  CrewCard,
  CrewEffect,
  CrewEvent,
  CrewFact,
  CrewGroup,
  CrewSnapshot,
} from "./types.ts";

export function createCrewSnapshot(
  crew: CrewFile,
  flow: CompiledCrewFlow,
  options: {
    artifacts?: Record<string, unknown>;
    roleInstances?: Record<string, string>;
    providerCaps?: Record<string, number>;
  } = {},
): CrewSnapshot {
  return {
    crew,
    flow,
    homeMode: detectCrewHome(crew).home?.mode ?? "first-step",
    status: "pending",
    paused: false,
    lastEventSeq: 0,
    lastEventAt: null,
    activeSince: null,
    visits: {},
    cards: [],
    groups: [],
    pendingSteps: [],
    artifacts: options.artifacts ?? {},
    routeCounters: Object.fromEntries(
      flow.edges.filter((e) => e.limit && e.kind !== "join").map((e) => [e.id, 0]),
    ),
    roleInstances: options.roleInstances ?? {},
    roleModels: {},
    providerCaps: options.providerCaps ?? {},
    budget: {
      limits: {
        maxCards: crew.limits?.maxCards ?? 60,
        maxHours: crew.limits?.maxHours ?? 8,
        maxFanoutItems: crew.limits?.maxFanoutItems ?? 12,
      },
      extensions: { maxCards: 0, maxHours: 0, maxFanoutItems: 0 },
      cards: 0,
      activeSeconds: 0,
    },
    budgetGate: null,
  };
}

const isActive = (card: CrewCard) =>
  ["dispatching", "working", "reported", "stopping"].includes(card.state);
const isTerminal = (snapshot: CrewSnapshot) =>
  ["completed", "failed", "cancelled"].includes(snapshot.status);
const isClosed = (card: CrewCard) => ["done", "skipped", "cancelled"].includes(card.state);

/** Step one ordered input. Persist emitted facts with the result; do not feed them back as inputs. */
export function decide(previous: CrewSnapshot, event: CrewEvent) {
  const effects: CrewEffect[] = [];
  const events: CrewFact[] = [];
  if (event.seq <= previous.lastEventSeq) return { snapshot: previous, effects, events };
  if (
    !Number.isSafeInteger(event.seq) ||
    !Number.isFinite(event.at) ||
    event.at < (previous.lastEventAt ?? 0)
  ) {
    throw new Error(
      "Crew events require increasing sequence numbers and nondecreasing timestamps.",
    );
  }
  if (isTerminal(previous)) return { snapshot: previous, effects, events };

  // Clone runtime state only; the validated definition and compiled graph are immutable inputs.
  const { crew, flow, ...runtime } = previous;
  const snapshot: CrewSnapshot = { ...structuredClone(runtime), crew, flow };
  snapshot.lastEventSeq = event.seq;
  snapshot.lastEventAt = event.at;
  if (snapshot.activeSince !== null)
    snapshot.budget.activeSeconds += (event.at - snapshot.activeSince) / 1000;
  snapshot.activeSince = null;
  const steps = new Map(flow.nodes.map((node) => [node.id, node.step]));
  const routes = flow.edges.filter((edge) => edge.kind === "next" || edge.kind === "outcome");
  const getStep = (id: string) => {
    const step = steps.get(id);
    if (!step) throw new Error(`Unknown crew step: ${id}`);
    return step;
  };
  const getCard = (id: string) => snapshot.cards.find((card) => card.id === id);
  const getGroup = (id: string) => snapshot.groups.find((group) => group.id === id)!;
  const ref = (card: CrewCard) => ({ cardId: card.id, attempt: card.attempt });
  const emit = (fact: CrewFact) => events.push(structuredClone(fact));

  function resetCounters(stepId: string, userGate: boolean, stepFinished = true) {
    const region = flow.loopRegions.find((candidate) => candidate.steps.includes(stepId));
    const resets = routes.filter(
      (edge) =>
        edge.limit &&
        (edge.limit.resetOn !== undefined
          ? stepFinished && edge.limit.resetOn.includes(stepId)
          : userGate && region?.routeIds.includes(edge.id)),
    );
    if (resets.length === 0) return;
    for (const edge of resets) snapshot.routeCounters[edge.id] = 0;
    emit({
      type: "route.counters_reset",
      regionId: region?.id ?? stepId,
      routeIds: resets.map((edge) => edge.id),
      cause: userGate ? "gate" : "step",
    });
  }

  function openBudget(kind: BudgetKind, group: CrewGroup | null = null) {
    if (snapshot.budgetGate) return;
    snapshot.budgetGate = {
      kind,
      by: "user",
      groupId: group?.id ?? null,
      total: group?.total ?? null,
      choices: kind === "maxFanoutItems" ? ["all", "first", "stop"] : ["extend", "stop"],
    };
    emit({ type: "budget.exhausted", kind });
    effects.push({ type: "notify", message: `Crew budget exhausted: ${kind}` });
  }

  function stopCard(card: CrewCard) {
    if (isClosed(card) || card.state === "stopping") return;
    if (isActive(card)) {
      card.state = "stopping";
      effects.push({ type: "stop_thread", ...ref(card), threadId: card.threadId });
    } else card.state = "skipped";
  }

  function endRun(status: "completed" | "failed" | "cancelled") {
    snapshot.status = status;
    snapshot.pendingSteps = [];
    for (const card of snapshot.cards) stopCard(card);
    for (const group of snapshot.groups) group.state = "done";
    snapshot.budgetGate = null;
    if (status === "completed") emit({ type: "run.completed" });
    else if (status === "failed")
      emit({ type: "run.failed", reason: "Flow ended with failed status." });
  }

  function belongsTo(parent: CrewCard["parent"], groupId: string): boolean {
    while (parent) {
      if (parent.groupId === groupId) return true;
      parent = getGroup(parent.groupId).parent;
    }
    return false;
  }

  function finishBranch(parent: NonNullable<CrewCard["parent"]>, outcome: string) {
    const group = getGroup(parent.groupId);
    if (group.state !== "active" || group.finished.includes(parent.branch)) return;
    group.finished.push(parent.branch);
    if (group.mode === "all" && group.finished.length < group.total) return;
    group.state = "done";
    if (group.mode === "any") {
      for (const card of snapshot.cards) if (belongsTo(card.parent, group.id)) stopCard(card);
      snapshot.pendingSteps = snapshot.pendingSteps.filter(
        (entry) => !belongsTo(entry.parent, group.id),
      );
      for (const child of snapshot.groups)
        if (belongsTo(child.parent, group.id)) child.state = "done";
      const budgetGroupId = snapshot.budgetGate?.groupId;
      if (budgetGroupId && getGroup(budgetGroupId).state === "done") snapshot.budgetGate = null;
    }
    resetCounters(group.stepId, false);
    route(group.stepId, outcome, group.parent);
  }

  function route(stepId: string, outcome: string, parent: CrewCard["parent"]) {
    const edge =
      routes.find((candidate) => candidate.from === stepId && candidate.outcome === outcome) ??
      routes.find((candidate) => candidate.from === stepId && candidate.kind === "next");
    if (!edge) {
      if (parent) finishBranch(parent, outcome);
      else endRun("completed");
      return;
    }
    let target = edge.to;
    if (edge.limit) {
      const used = snapshot.routeCounters[edge.id] ?? 0;
      if (used < edge.limit.max) snapshot.routeCounters[edge.id] = used + 1;
      else {
        target = edge.limit.else;
        emit({ type: "route.limit_reached", routeId: edge.id });
      }
    }
    if (parent) {
      const parentGroup = getGroup(parent.groupId);
      const join = flow.joins.find((candidate) => candidate.stepId === parentGroup.stepId);
      if (
        join?.branches.length &&
        join.routeIds.some((id) => {
          const parentEdge = routes.find((candidate) => candidate.id === id);
          return parentEdge?.to === target || parentEdge?.limit?.else === target;
        })
      ) {
        finishBranch(parent, outcome);
        return;
      }
    }
    snapshot.pendingSteps.push({ stepId: target, parent });
  }

  function createCard(
    stepId: string,
    visit: number,
    parent: CrewCard["parent"],
    itemIndex: number | null = null,
    item: unknown = null,
  ) {
    const step = getStep(stepId);
    if (step.type === "end" || step.type === "parallel")
      throw new Error("A control step is not a card.");
    const roleId = "role" in step ? step.role : null;
    const card: CrewCard = {
      id: `${stepId}:${visit}${itemIndex === null ? "" : `:${itemIndex}`}`,
      stepId,
      visit,
      type: step.type,
      parent,
      itemIndex,
      item: structuredClone(item),
      roleId,
      instanceId: null,
      isolation: crewStepIsolation(crew, step, parent !== null),
      state: "queued",
      attempt: 1,
      reminderSent: false,
      followUp: null,
      threadId: null,
      orchestrationRunId: null,
      report: null,
      outcome: null,
      sourceCardId: null,
      decidedBy: null,
      note: null,
    };
    snapshot.cards.push(card);
    emit({ type: "card.created", card });
    return card;
  }

  function openGate(card: CrewCard, by: "user" | "lead", prompt: string, outcomes: string[]) {
    card.state = by === "user" ? "needs_you" : "waiting_lead";
    emit({ type: "gate.opened", cardId: card.id, by, prompt, outcomes });
    if (by === "lead") effects.push({ type: "send_decision_request", cardId: card.id, outcomes });
    else effects.push({ type: "notify", cardId: card.id, message: prompt });
  }

  function ask(card: CrewCard, outcome: string) {
    card.state = "blocked";
    card.outcome = outcome;
    const decision: CrewCard = {
      ...card,
      id: `${card.id}:decision:${card.attempt}:${event.seq}`,
      type: "decision",
      sourceCardId: card.id,
      threadId: null,
      orchestrationRunId: null,
      roleId: null,
      report: null,
      outcome: null,
    };
    snapshot.cards.push(decision);
    emit({ type: "card.created", card: decision });
    const outcomes = routes
      .filter((edge) => edge.from === card.stepId && edge.outcome)
      .map((edge) => edge.outcome!);
    if (
      routes.some((edge) => edge.from === card.stepId && edge.kind === "next") ||
      outcomes.length === 0
    )
      outcomes.push("done");
    openGate(
      decision,
      snapshot.homeMode === "lead" ? "lead" : "user",
      `Choose an outcome for ${card.stepId}: ${outcome}`,
      outcomes,
    );
  }

  function retry(card: CrewCard, reminder: boolean) {
    card.attempt += 1;
    card.state = "queued";
    card.report = null;
    card.outcome = null;
    card.orchestrationRunId = null;
    card.followUp = reminder ? "reminder" : "retry";
    if (reminder) card.reminderSent = true;
  }

  function finish(card: CrewCard, outcome: string, userGate = false, forced = false) {
    const step = getStep(card.stepId);
    const mapped = routes.some((edge) => edge.from === card.stepId && edge.outcome === outcome);
    if (!forced && !mapped && (outcome === "no_report" || outcome === "failed")) {
      const policy = step.onNoReport ?? crew.defaults?.onNoReport ?? "retry-then-ask";
      if (outcome !== "failed" && policy === "done") outcome = "done";
      else if (outcome !== "failed" && policy === "retry-then-ask" && !card.reminderSent) {
        retry(card, true);
        return;
      } else {
        ask(card, outcome);
        return;
      }
    }
    if (
      !forced &&
      !routes.some((edge) => edge.from === card.stepId && edge.outcome === outcome) &&
      (outcome === "skipped" ||
        (routes.some((edge) => edge.from === card.stepId) &&
          !routes.some((edge) => edge.from === card.stepId && edge.kind === "next")))
    ) {
      ask(card, outcome);
      return;
    }
    card.state = "done";
    card.outcome = outcome;
    if (card.report) Object.assign(snapshot.artifacts, structuredClone(card.report.artifacts));
    emit({ type: "card.completed", ...ref(card), outcome });
    if (card.type === "fanout") {
      if (userGate) resetCounters(card.stepId, true, false);
      if (card.parent) finishBranch(card.parent, outcome);
    } else {
      resetCounters(card.stepId, userGate);
      route(card.stepId, outcome, card.parent);
    }
  }

  function expandFanout(group: CrewGroup, count: number) {
    group.state = "active";
    group.total = count;
    for (let index = 0; index < count; index++)
      createCard(
        group.stepId,
        group.visit,
        { groupId: group.id, branch: index },
        index,
        group.items[index],
      );
    if (count === 0) {
      group.state = "done";
      resetCounters(group.stepId, false);
      route(group.stepId, "done", group.parent);
    }
  }

  function enter(stepId: string, parent: CrewCard["parent"]) {
    if (parent && getGroup(parent.groupId).state === "done") return;
    const step = getStep(stepId);
    const visit = (snapshot.visits[stepId] ?? 0) + 1;
    snapshot.visits[stepId] = visit;
    emit({ type: "step.entered", stepId, visit });
    if (step.type === "end") {
      resetCounters(stepId, false);
      if (parent) finishBranch(parent, step.status ?? "done");
      else endRun(step.status ?? "completed");
    } else if (step.type === "parallel" || step.type === "fanout") {
      const join = flow.joins.find((candidate) => candidate.stepId === stepId)!;
      const group: CrewGroup = {
        id: `${stepId}:${visit}`,
        stepId,
        visit,
        parent,
        mode: join.mode,
        state: "active",
        total: join.branches.length,
        finished: [],
        items: [],
      };
      snapshot.groups.push(group);
      if (step.type === "parallel")
        join.branches.forEach((branch, index) =>
          snapshot.pendingSteps.push({
            stepId: branch.start,
            parent: { groupId: group.id, branch: index },
          }),
        );
      else {
        const fanout = flow.fanouts.find((candidate) => candidate.stepId === stepId)!;
        let items: unknown = { artifacts: snapshot.artifacts };
        for (const key of fanout.over.split(".")) {
          items =
            typeof items === "object" && items !== null && Object.hasOwn(items, key)
              ? (items as Record<string, unknown>)[key]
              : undefined;
        }
        if (!Array.isArray(items))
          throw new Error(`Fan-out ${stepId} requires a list at ${fanout.over}.`);
        group.items = structuredClone(items);
        group.total = items.length;
        if (items.length > snapshot.budget.limits.maxFanoutItems) {
          group.state = "blocked";
          openBudget("maxFanoutItems", group);
        } else expandFanout(group, items.length);
      }
    } else {
      const card = createCard(stepId, visit, parent);
      if (step.type === "gate")
        openGate(card, step.by ?? "user", step.prompt, Object.keys(step.outcomes));
    }
  }

  function canDispatch(card: CrewCard, active: CrewCard[]) {
    const step = getStep(card.stepId);
    if (active.length >= (crew.defaults?.maxParallel ?? Number.MAX_SAFE_INTEGER)) return false;
    if (
      active.filter((other) => other.stepId === card.stepId).length >=
      (step.maxParallel ?? Number.MAX_SAFE_INTEGER)
    )
      return false;
    if (
      card.roleId &&
      active.filter((other) => other.roleId === card.roleId).length >=
        (crew.roles[card.roleId]?.maxConcurrent ?? Number.MAX_SAFE_INTEGER)
    )
      return false;
    if (
      card.instanceId &&
      active.filter((other) => other.instanceId === card.instanceId).length >=
        (snapshot.providerCaps[card.instanceId] ?? Number.MAX_SAFE_INTEGER)
    )
      return false;
    if (card.isolation === "shared" && active.some((other) => other.isolation === "shared"))
      return false;
    if (card.threadId && active.some((other) => other.threadId === card.threadId)) return false;
    let parent = card.parent;
    while (parent) {
      const group = getGroup(parent.groupId);
      if (group.state !== "active") return false;
      if (
        active.filter((other) => belongsTo(other.parent, group.id)).length >=
        (getStep(group.stepId).maxParallel ?? Number.MAX_SAFE_INTEGER)
      )
        return false;
      parent = group.parent;
    }
    return true;
  }

  function pump() {
    while (snapshot.pendingSteps.length && !isTerminal(snapshot)) {
      const entry = snapshot.pendingSteps.shift()!;
      enter(entry.stepId, entry.parent);
    }
    if (snapshot.paused || snapshot.budgetGate || isTerminal(snapshot)) return;
    const blocked = snapshot.groups.find((group) => group.state === "blocked");
    if (blocked) {
      openBudget("maxFanoutItems", blocked);
      return;
    }
    for (const card of snapshot.cards) {
      if (card.state !== "queued") continue;
      const step = getStep(card.stepId);
      card.instanceId = card.roleId ? (snapshot.roleInstances[card.roleId] ?? null) : null;
      if (
        card.followUp === null &&
        "continue" in step &&
        step.continue === "same-thread" &&
        card.roleId
      ) {
        const prior = snapshot.cards.findLast(
          (other) =>
            other.id !== card.id &&
            other.roleId === card.roleId &&
            other.threadId !== null &&
            isClosed(other),
        );
        if (prior) {
          card.threadId = prior.threadId;
          card.isolation = prior.isolation;
        }
      }
      if (!canDispatch(card, snapshot.cards.filter(isActive))) continue;
      const counted = card.type !== "merge";
      if (counted && snapshot.budget.cards >= snapshot.budget.limits.maxCards) {
        openBudget("maxCards");
        break;
      }
      if (snapshot.budget.activeSeconds >= snapshot.budget.limits.maxHours * 3600) {
        openBudget("maxHours");
        break;
      }
      card.state = "dispatching";
      if (counted) snapshot.budget.cards++;
      if (card.type === "script") effects.push({ type: "run_script", ...ref(card) });
      else if (card.type === "merge") effects.push({ type: "check_ownership", cardId: card.id });
      else if (card.threadId)
        effects.push({
          type: "send_follow_up",
          ...ref(card),
          threadId: card.threadId,
          reason: card.followUp ?? "continue",
        });
      else effects.push({ type: "launch_card", ...ref(card) });
      if (card.followUp === "reminder") emit({ type: "card.reminder_sent", ...ref(card) });
    }
  }

  const card = "cardId" in event ? getCard(event.cardId) : undefined;
  const currentAttempt = card && (!("attempt" in event) || event.attempt === card.attempt);
  switch (event.type) {
    case "run.created":
      if (snapshot.status === "pending") {
        snapshot.status = "running";
        snapshot.pendingSteps.push({ stepId: flow.start, parent: null });
      }
      break;
    case "card.dispatched":
      if (currentAttempt && (card.state === "dispatching" || card.state === "stopping")) {
        card.threadId = event.threadId;
        card.orchestrationRunId = event.orchestrationRunId;
        if (card.state === "stopping")
          effects.push({ type: "stop_thread", ...ref(card), threadId: card.threadId });
        else card.state = "working";
      }
      break;
    case "card.reported":
      if (currentAttempt && isActive(card) && card.state !== "stopping") {
        card.report = {
          outcome: event.outcome,
          summary: event.summary,
          artifacts: structuredClone(event.artifacts),
        };
        card.state = "reported";
      }
      break;
    case "card.turn_finished":
    case "card.completed":
    case "card.failed":
      if (currentAttempt && isActive(card)) {
        if (card.state === "stopping") card.state = "cancelled";
        else
          finish(
            card,
            event.type === "card.completed"
              ? event.outcome
              : event.type === "card.failed"
                ? "failed"
                : (card.report?.outcome ?? (event.status === "failed" ? "failed" : "no_report")),
          );
      }
      break;
    case "card.reminder_sent":
      if (currentAttempt && card.followUp === "reminder") card.reminderSent = true;
      break;
    case "script.finished":
      if (currentAttempt && card.type === "script" && isActive(card) && card.state !== "stopping") {
        card.report = {
          outcome: event.exitCode === 0 ? "pass" : "fail",
          summary: event.outputTail.slice(-8192),
          artifacts: {},
        };
        finish(card, card.report.outcome);
      }
      break;
    case "gate.resolved": {
      if (!card || !["needs_you", "waiting_lead"].includes(card.state)) break;
      if (event.by === "lead" && card.state !== "waiting_lead")
        throw new Error("Only the user can resolve this gate.");
      const source = card.sourceCardId ? getCard(card.sourceCardId)! : card;
      if (source !== card && source.state !== "blocked") break;
      const choices = routes
        .filter((edge) => edge.from === source.stepId && edge.outcome)
        .map((edge) => edge.outcome);
      if (
        !choices.includes(event.outcome) &&
        !(
          event.outcome === "done" &&
          (choices.length === 0 ||
            routes.some((edge) => edge.from === source.stepId && edge.kind === "next"))
        )
      )
        throw new Error("The gate outcome is not one of its routes.");
      card.decidedBy = event.by;
      card.note = event.note;
      if (source !== card) {
        card.state = "done";
        card.outcome = event.outcome;
      }
      finish(source, event.outcome, event.by === "user", true);
      break;
    }
    case "gate.escalated":
      if (card?.state === "waiting_lead") {
        card.state = "needs_you";
        card.note = event.reason;
        effects.push({ type: "notify", cardId: card.id, message: event.reason });
      }
      break;
    case "budget.extended":
      if (
        !Number.isFinite(event.by) ||
        event.by <= 0 ||
        (event.kind !== "maxHours" && !Number.isSafeInteger(event.by))
      )
        throw new Error("Budget extensions must be positive, with whole cards/items.");
      snapshot.budget.limits[event.kind] += event.by;
      snapshot.budget.extensions[event.kind] += event.by;
      if (snapshot.budgetGate?.kind === event.kind) snapshot.budgetGate = null;
      if (event.kind === "maxFanoutItems")
        for (const group of snapshot.groups)
          if (group.state === "blocked" && group.total <= snapshot.budget.limits.maxFanoutItems)
            expandFanout(group, group.total);
      break;
    case "budget.fanout_selected": {
      const gate = snapshot.budgetGate;
      if (gate?.kind !== "maxFanoutItems" || gate.groupId !== event.groupId) break;
      if (event.choice === "stop") {
        endRun("cancelled");
        break;
      }
      const group = getGroup(event.groupId);
      const count =
        event.choice === "all"
          ? group.total
          : (event.count ?? snapshot.budget.limits.maxFanoutItems);
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > group.total ||
        (event.choice === "first" && count > snapshot.budget.limits.maxFanoutItems)
      )
        throw new Error("Invalid fan-out selection.");
      if (event.choice === "all") {
        const by = Math.max(0, count - snapshot.budget.limits.maxFanoutItems);
        snapshot.budget.limits.maxFanoutItems += by;
        snapshot.budget.extensions.maxFanoutItems += by;
        emit({ type: "budget.extended", kind: "maxFanoutItems", by });
      }
      snapshot.budgetGate = null;
      expandFanout(group, count);
      break;
    }
    case "run.paused":
      snapshot.paused = true;
      break;
    case "run.resumed":
      snapshot.paused = false;
      break;
    case "run.cancel_requested":
      endRun("cancelled");
      break;
    case "run.completed":
      endRun("completed");
      break;
    case "run.failed":
      endRun("failed");
      break;
    case "user.card_action":
      if (!card || card.type === "gate" || card.type === "decision" || isActive(card)) break;
      if (
        event.action === "force_outcome" &&
        (!event.outcome ||
          (!routes.some(
            (edge) =>
              edge.from === card.stepId && (edge.outcome === event.outcome || edge.kind === "next"),
          ) &&
            !(event.outcome === "done" && !routes.some((edge) => edge.from === card.stepId))))
      )
        throw new Error("Force outcome requires an available route.");
      for (const decision of snapshot.cards)
        if (decision.sourceCardId === card.id && !isClosed(decision)) decision.state = "skipped";
      if (event.action === "retry") {
        if (isClosed(card))
          throw new Error("A routed card cannot be retried after its successors have started.");
        card.reminderSent = false;
        retry(card, false);
      } else if (!isClosed(card)) {
        finish(
          card,
          event.action === "skip" ? "skipped" : event.outcome!,
          false,
          event.action === "force_outcome",
        );
        if (event.action === "skip" && card.state === "done") card.state = "skipped";
      }
      break;
    case "user.role_model_changed":
      if (!Object.hasOwn(crew.roles, event.roleId)) throw new Error("Unknown crew role.");
      snapshot.roleInstances[event.roleId] = event.selection.instanceId;
      snapshot.roleModels[event.roleId] = event.selection;
      break;
    case "route.counters_reset":
      for (const id of event.routeIds) {
        if (!Object.hasOwn(snapshot.routeCounters, id)) throw new Error("Unknown route counter.");
        snapshot.routeCounters[id] = 0;
      }
      break;
    case "merge.started":
      if (card?.type === "merge" && card.state === "dispatching") {
        card.state = "working";
        effects.push({ type: "merge_branch", cardId: card.id });
      }
      break;
    case "merge.conflict":
      if (card?.type === "merge" && isActive(card))
        openGate(card, "user", `Merge conflict: ${event.paths.join(", ")}`, ["done"]);
      break;
    case "merge.resolved":
      if (card?.type === "merge" && !isClosed(card)) finish(card, "done");
      break;
    case "budget.exhausted":
      openBudget(event.kind);
      break;
    case "lead.update_queued":
      effects.push({ type: "deliver_lead_update", milestone: event.milestone });
      break;
    // These facts describe work already recorded by decide or owned by later workers.
    case "step.entered":
    case "card.created":
    case "gate.opened":
    case "route.limit_reached":
    case "merge.card_merged":
    case "lead.kickoff_finished":
    case "lead.update_delivered":
      break;
  }

  if (
    !isTerminal(snapshot) &&
    snapshot.budget.activeSeconds >= snapshot.budget.limits.maxHours * 3600
  )
    openBudget("maxHours");
  pump();
  if (!isTerminal(snapshot)) {
    const active = snapshot.cards.some(isActive);
    snapshot.status = snapshot.paused
      ? "paused"
      : snapshot.budgetGate || !active
        ? "waiting"
        : "running";
    if (!snapshot.paused && active) snapshot.activeSince = event.at;
  }
  return { snapshot, effects, events };
}
