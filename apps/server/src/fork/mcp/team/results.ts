import type { MessageId, OrchestrationThread, TurnId } from "@t3tools/contracts";

export const RESULT_PAGE_CHARACTERS = 8_000;

export function completedTurnResult(thread: OrchestrationThread, turnId: TurnId) {
  const latest = thread.latestTurn?.turnId === turnId ? thread.latestTurn : null;
  const checkpoint = thread.checkpoints.findLast(
    (item) => item.turnId === turnId && item.assistantMessageId !== null,
  );
  const messageId: MessageId | null = latest
    ? latest.state === "completed" && latest.completedAt !== null
      ? latest.assistantMessageId
      : null
    : (checkpoint?.assistantMessageId ?? null);
  if (messageId === null) return null;
  const message = thread.messages.find(
    (item) =>
      item.id === messageId &&
      item.turnId === turnId &&
      item.role === "assistant" &&
      !item.streaming,
  );
  return message ?? null;
}

export function pageResult(text: string, cursor: number) {
  const characters = Array.from(text);
  if (cursor > characters.length) return null;
  const next = Math.min(cursor + RESULT_PAGE_CHARACTERS, characters.length);
  return {
    text: characters.slice(cursor, next).join(""),
    totalCharacters: characters.length,
    totalBytes: Buffer.byteLength(text, "utf8"),
    cursor,
    nextCursor: next < characters.length ? next : null,
    complete: next === characters.length,
    truncated: false,
  };
}
