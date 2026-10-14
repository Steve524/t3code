import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRunCard, CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useInlineActionConfirm } from "../../../components/pullRequest/useInlineActionConfirm";
import { positiveCrewAmount } from "./crewBoard.logic";
import { useCrewControl, type CrewControl } from "./crewBoardState";

export function CrewConfirm({
  action,
  label,
  disabled,
  onConfirm,
}: {
  action: string;
  label: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const confirm = useInlineActionConfirm(action);
  return (
    <Button size="xs" variant="outline" disabled={disabled} {...confirm.props(action, onConfirm)}>
      {confirm.isArmed(action) ? `Confirm ${label.toLowerCase()}` : label}
    </Button>
  );
}

export function CrewGateActions({ card, control }: { card: CrewRunCard; control: CrewControl }) {
  const [deciding, setDeciding] = useState(false);
  const [note, setNote] = useState("");
  if (!card.gate || !["needs_you", "waiting_lead"].includes(card.state)) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm">{card.gate.prompt}</p>
      {card.note && <p className="text-xs text-muted-foreground">{card.note}</p>}
      {card.state === "waiting_lead" && !deciding ? (
        <Button
          size="xs"
          variant="outline"
          disabled={control.disabled}
          onClick={() => setDeciding(true)}
        >
          Decide myself
        </Button>
      ) : (
        <>
          <Input
            aria-label="Optional decision note"
            placeholder="Optional note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={control.disabled}
          />
          <div className="flex flex-wrap gap-1">
            {card.gate.outcomes.map((outcome) => (
              <Button
                key={outcome}
                size="xs"
                variant="outline"
                disabled={control.disabled}
                onClick={() =>
                  void control.send({
                    type: "resolveGate",
                    cardId: card.cardId,
                    outcome,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  })
                }
              >
                {outcome}
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CrewBudgetGate({ view, control }: { view: CrewRunView; control: CrewControl }) {
  const [amountText, setAmountText] = useState("");
  const gate = view.budget.gate;
  if (!gate) return null;
  const fanout = gate.kind === "maxFanoutItems";
  const hours = gate.kind === "maxHours";
  const amount = positiveCrewAmount(amountText, !hours);
  const usage = hours ? view.budget.hours : view.budget.cards;
  return (
    <section
      className="space-y-3 rounded-lg border border-warning/50 bg-card p-3"
      aria-label="Budget gate"
    >
      <h2 className="text-sm font-medium">
        Needs you · {fanout ? "Fan-out item limit" : hours ? "Active hours budget" : "Card budget"}
      </h2>
      <p className="text-sm">
        {fanout
          ? `${gate.total ?? ""} items exceed the limit of ${view.budget.fanoutItems}.`
          : `${usage.used}/${usage.limit} ${hours ? "hours" : "cards"} used.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {fanout ? (
          <Button
            size="xs"
            variant="outline"
            disabled={control.disabled}
            onClick={() => void control.send({ type: "selectFanout", choice: "all" })}
          >
            Run all
          </Button>
        ) : (
          (hours ? [1, 2, 4] : [10, 20, 50]).map((by) => (
            <Button
              key={by}
              size="xs"
              variant="outline"
              disabled={control.disabled}
              onClick={() => void control.send({ type: "extendBudget", kind: gate.kind, by })}
            >
              Extend by {by}
            </Button>
          ))
        )}
        <div className="w-32">
          <Input
            type="number"
            min={hours ? 0.1 : 1}
            step={hours ? 0.1 : 1}
            max={fanout ? Math.min(gate.total ?? Infinity, view.budget.fanoutItems) : undefined}
            value={amountText}
            aria-label={fanout ? "Number of items to run" : "Custom budget extension"}
            placeholder={fanout ? "First N" : "Amount"}
            onChange={(event) => setAmountText(event.target.value)}
          />
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={
            control.disabled ||
            amount === null ||
            (fanout && amount > Math.min(gate.total ?? Infinity, view.budget.fanoutItems))
          }
          onClick={() => {
            if (amount !== null)
              void control.send(
                fanout
                  ? { type: "selectFanout", choice: "first", count: amount }
                  : { type: "extendBudget", kind: gate.kind, by: amount },
              );
          }}
        >
          {fanout ? "Run first N" : "Extend"}
        </Button>
        <CrewConfirm
          action={`${view.runId}:budget-stop`}
          label="Stop run"
          disabled={control.disabled}
          onConfirm={() =>
            void control.send(
              fanout ? { type: "selectFanout", choice: "stop" } : { type: "cancel" },
            )
          }
        />
      </div>
    </section>
  );
}

/** Banner controls share the board command and permissions. */
export function CrewBannerGates({
  environmentId,
  view,
}: {
  environmentId: EnvironmentId;
  view: CrewRunView;
}) {
  const control = useCrewControl(environmentId, view.runId);
  return (
    <div className="space-y-3">
      {view.cards
        .filter((card) => card.gate && ["needs_you", "waiting_lead"].includes(card.state))
        .map((card) => (
          <CrewGateActions key={card.cardId} card={card} control={control} />
        ))}
      {view.budget.gate && <CrewBudgetGate view={view} control={control} />}
    </div>
  );
}
