export function shouldPlayKitchenAlert({ previousOrderId, nextOrderId, preferred, ready }) {
  return Boolean(preferred && ready && nextOrderId && nextOrderId !== previousOrderId);
}

export function kitchenAlertButtonState({ supported, preferred, ready }) {
  if (!supported) return { label: "通知音は利用できません", pressed: false, tone: "unavailable" };
  if (ready) return { label: "通知音：オン", pressed: true, tone: "ready" };
  if (preferred) return { label: "通知音を準備", pressed: false, tone: "attention" };
  return { label: "通知音：オフ", pressed: false, tone: "off" };
}
