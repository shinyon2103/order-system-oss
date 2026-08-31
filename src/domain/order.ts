export const ORDER_STATUSES = [
  "WAITING",
  "COOKING",
  "READY",
  "COMPLETED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
    WAITING: ["COOKING", "CANCELLED"],
    COOKING: ["READY", "WAITING"],
    READY: ["COOKING", "COMPLETED", "CANCELLED"],
    COMPLETED: ["CANCELLED"],
    CANCELLED: [],
  };

  return transitions[from].includes(to);
}
