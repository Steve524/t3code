import type { EnvironmentId } from "@t3tools/contracts";
import type { CrewRunCard, CrewRunView } from "@t3tools/contracts/fork/crews/crewRun";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { useInlineActionConfirm } from "../../../components/pullRequest/useInlineActionConfirm";
import { positiveCrewAmount } from "./crewBoard.logic";
import { useCrewControl, type CrewControl } from "./crewBoardState";

export function CrewConfirm({
  action,
  label,
  disabled,
  onConfirm,
  size = "xs",
}: {
  action: string;
  label: string;
  disabled: boolean;
  onConfirm: () => void;
  size?: "xs" | "sm-multiline";
}) {
  const confirm = useInlineActionConfirm(action);
  return (
    <Button
      size={size}
      className="min-w-0 max-w-full"
      variant={confirm.isArmed(action) ? "destructive-outline" : "outline"}
      disabled={disabled}
      {...confirm.props(action, onConfirm)}
    >
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        {confirm.isArmed(action) ? `Confirm ${label.toLowerCase()}` : label}
      </span>
    </Button>
  );
}

export function CrewGateActions({ card, control }: { card: CrewRunCard; control: CrewControl }) {
  const [deciding, setDeciding] = useState(false);
  const [note, setNote] = useState("");
  if (!card.gate || !["needs_you", "waiting_lead"].includes(card.state)) return null;
  return (
    <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
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
            aria-label={`Optional decision note for ${card.title ?? card.stepId}`}
            placeholder="Optional note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={control.disabled}
          />
          <div className="flex flex-wrap gap-1">
            {card.gate.outcomes.map((outcome) => (
              <Button
                key={outcome}
                size="sm-multiline"
                className="min-w-0 max-w-full"
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
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{outcome}</span>
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
  const inputId = useId();
  const gate = view.budget.gate;
  if (!gate) return null;
  const fanout = gate.kind === "maxFanoutItems";
  const hours = gate.kind === "maxHours";
  const amount = positiveCrewAmount(amountText, !hours);
  const maximum = fanout ? Math.min(gate.total ?? Infinity, view.budget.fanoutItems) : undefined;
  const amountError =
    amountText !== "" && amount === null
      ? hours
        ? "Enter a number greater than zero."
        : "Enter a whole number greater than zero."
      : amount !== null && maximum !== undefined && amount > maximum
        ? `Enter no more than ${maximum} items.`
        : null;
  const submitAmount = () => {
    if (control.disabled || amount === null || amountError) return;
    void control.send(
      fanout
        ? { type: "selectFanout", choice: "first", count: amount }
        : { type: "extendBudget", kind: gate.kind, by: amount },
    );
  };
  const usage = hours ? view.budget.hours : view.budget.cards;
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border border-warning/50 bg-card p-3 [overflow-wrap:anywhere]"
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
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>
          {fanout ? "Items to run" : hours ? "Additional hours" : "Additional cards"}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-32">
            <Input
              id={inputId}
              type="number"
              min={hours ? 0 : 1}
              step={hours ? "any" : 1}
              max={maximum}
              disabled={control.disabled}
              value={amountText}
              aria-invalid={amountError !== null}
              aria-describedby={`${inputId}-hint`}
              placeholder={fanout ? "First N" : "Amount"}
              onChange={(event) => setAmountText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitAmount();
                }
              }}
            />
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={control.disabled || amount === null || amountError !== null}
            onClick={submitAmount}
          >
            {fanout ? "Run first N" : "Extend"}
          </Button>
        </div>
        <p
          id={`${inputId}-hint`}
          role={amountError ? "alert" : undefined}
          className={
            amountError ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
          }
        >
          {amountError ??
            (fanout
              ? `Choose up to ${maximum} items.`
              : hours
                ? "Enter additional active hours."
                : "Enter additional cards.")}
        </p>
      </div>
      <CrewConfirm
        action={`${view.runId}:budget-stop`}
        label="Stop run"
        disabled={control.disabled}
        onConfirm={() =>
          void control.send(fanout ? { type: "selectFanout", choice: "stop" } : { type: "cancel" })
        }
      />
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
  if (["completed", "failed", "cancelled"].includes(view.status)) return null;
  return (
    <div className="space-y-3">
      {control.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating crew run…
        </p>
      )}
      {view.cards
        .filter((card) => card.gate && ["needs_you", "waiting_lead"].includes(card.state))
        .map((card) => (
          <section
            key={card.cardId}
            className="min-w-0 space-y-2"
            aria-label={card.title ?? card.stepId}
          >
            <h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">
              {card.title ?? card.stepId}
            </h3>
            <CrewGateActions card={card} control={control} />
          </section>
        ))}
      {view.budget.gate && (
        <CrewBudgetGate key={view.budget.gate.kind} view={view} control={control} />
      )}
    </div>
  );
}
