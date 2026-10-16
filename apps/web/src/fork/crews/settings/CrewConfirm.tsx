import { useInlineActionConfirm } from "../../../components/pullRequest/useInlineActionConfirm";
import { Button } from "../../../components/ui/button";

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
