export function sortPendingOrders(orders = []) {
  return [...orders].sort((left, right) => {
    const acceptedAtOrder = String(left?.acceptedAt || "").localeCompare(String(right?.acceptedAt || ""));
    if (acceptedAtOrder !== 0) return acceptedAtOrder;
    return String(left?.requestId || "").localeCompare(String(right?.requestId || ""));
  });
}

export function prepareOfflineOrder(input, prefix, nextNumber) {
  return {
    ...input,
    mode: "OFFLINE",
    ticketNumber: `${prefix}${nextNumber}`,
  };
}

export function isNetworkUnavailable(error) {
  return error?.code === "NETWORK_UNAVAILABLE" || (Number.isInteger(error?.status) && error.status >= 500);
}
