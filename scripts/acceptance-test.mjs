import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

function argument(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseUrl = new URL(argument("--base-url", process.env.ACCEPTANCE_BASE_URL || ""));
const credentialsFile = argument("--credentials-file", process.env.ACCEPTANCE_CREDENTIALS_FILE);
if (!credentialsFile) throw new Error("--credentials-file is required");
if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
  throw new Error("Acceptance credentials may only be sent to HTTPS or localhost");
}

function parseCredentials(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const entries = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const delimiter = line.indexOf(":");
      if (delimiter < 0) return null;
      return [line.slice(0, delimiter).trim().toLowerCase(), line.slice(delimiter + 1).trim()];
    }).filter(Boolean);
    const values = Object.fromEntries(entries);
    return {
      loginName: values.loginname || values.loginid || values.login,
      password: values.password || values.pass,
    };
  }
}

const credentials = parseCredentials(await readFile(credentialsFile, "utf8"));
assert(typeof credentials.loginName === "string" && credentials.loginName.length >= 3, "Invalid loginName in credentials file");
assert(typeof credentials.password === "string" && credentials.password.length >= 12, "Invalid password in credentials file");

const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const resources = { eventId: null, itemId: null, deviceIds: [] };
let adminToken = null;
let cleanupStarted = false;

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}` };
}

function deviceHeaders(device) {
  return { "X-Device-ID": device.id, "X-Device-Key": device.key };
}

async function request(path, { method = "GET", headers = {}, json, expected = 200 } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { ...headers, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
    redirect: "error",
  });
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  if (!expectedStatuses.includes(response.status)) {
    let errorCode = "unknown";
    try {
      const body = await response.clone().json();
      if (typeof body?.error === "string") errorCode = body.error;
    } catch {
      // Do not include response bodies because successful auth responses contain secrets.
    }
    throw new Error(`${method} ${path}: expected ${expectedStatuses.join("/")}, received ${response.status} (${errorCode})`);
  }
  return response;
}

async function jsonRequest(path, options) {
  return (await request(path, options)).json();
}

async function createDevice(role, suffix) {
  const id = `ACCEPT-${runId}-${suffix}`.toUpperCase();
  const result = await jsonRequest("/api/admin/devices", {
    method: "POST",
    headers: adminHeaders(),
    json: { id, role, displayName: `受入確認 ${suffix}` },
    expected: 201,
  });
  assert(typeof result.deviceKey === "string" && result.deviceKey.length >= 32, `${suffix}: device key was not issued`);
  resources.deviceIds.push(id);
  return { id, key: result.deviceKey, role };
}

async function disableDevice(id) {
  await request(`/api/admin/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: adminHeaders(),
    json: { active: false },
  });
}

async function cleanup() {
  if (cleanupStarted || !adminToken) return;
  cleanupStarted = true;
  const failures = [];
  const attempt = async (label, operation) => {
    try { await operation(); } catch (error) { failures.push(`${label}: ${error.message}`); }
  };
  if (resources.eventId) {
    await attempt("close event", () => request(`/api/admin/events/${resources.eventId}`, {
      method: "PATCH", headers: adminHeaders(), json: { status: "CLOSED" },
    }));
  }
  if (resources.itemId) {
    await attempt("disable menu", () => request(`/api/admin/menu/items/${resources.itemId}`, {
      method: "DELETE", headers: adminHeaders(),
    }));
  }
  for (const id of resources.deviceIds) await attempt(`disable ${id}`, () => disableDevice(id));
  await attempt("logout", () => request("/api/auth/logout", { method: "POST", headers: adminHeaders() }));
  if (failures.length) throw new Error(`Acceptance cleanup failed: ${failures.join("; ")}`);
}

async function main() {
  const login = await jsonRequest("/api/auth/login", {
    method: "POST",
    json: { loginName: credentials.loginName, password: credentials.password },
  });
  assert(typeof login.token === "string" && login.token.length > 0, "Admin token was not issued");
  adminToken = login.token;

  const events = await jsonRequest("/api/admin/events", { headers: adminHeaders() });
  const openEvent = events.events?.find((event) => event.status === "OPEN");
  assert(!openEvent, `Refusing to close existing OPEN event: ${openEvent?.name || openEvent?.id}`);

  const createdEvent = await jsonRequest("/api/admin/events", {
    method: "POST",
    headers: adminHeaders(),
    json: { name: `自動受入確認 ${runId}`, businessDate: new Date().toISOString().slice(0, 10) },
    expected: 201,
  });
  resources.eventId = createdEvent.event.id;

  const createdItem = await jsonRequest("/api/admin/menu/items", {
    method: "POST",
    headers: adminHeaders(),
    json: { name: `受入焼きそば ${runId}`, description: "自動受入確認用", sortOrder: 9999 },
    expected: 201,
  });
  resources.itemId = createdItem.item.id;
  const createdGroup = await jsonRequest(`/api/admin/menu/items/${resources.itemId}/option-groups`, {
    method: "POST",
    headers: adminHeaders(),
    json: { name: "味付け", selectionType: "SINGLE", required: true, sortOrder: 0 },
    expected: 201,
  });
  await jsonRequest(`/api/admin/menu/option-groups/${createdGroup.group.id}/options`, {
    method: "POST",
    headers: adminHeaders(),
    json: { name: "ソース", sortOrder: 0 },
    expected: 201,
  });

  const reception = await createDevice("RECEPTION", "RECEPTION");
  const kitchenA = await createDevice("KITCHEN", "KITCHEN-A");
  const kitchenB = await createDevice("KITCHEN", "KITCHEN-B");
  const delivery = await createDevice("DELIVERY", "DELIVERY");
  const display = await createDevice("DISPLAY", "DISPLAY");

  await request(`/api/admin/events/${resources.eventId}`, {
    method: "PATCH", headers: adminHeaders(), json: { status: "OPEN" },
  });
  const currentEvent = await jsonRequest("/api/events/current");
  assert(currentEvent.event?.id === resources.eventId, "The acceptance event did not become current");

  for (const device of [reception, kitchenA, kitchenB, delivery, display]) {
    const session = await jsonRequest("/api/device/session", { headers: deviceHeaders(device) });
    assert(session.device?.id === device.id && session.device?.role === device.role, `${device.id}: session role mismatch`);
  }
  const wrongRole = await jsonRequest(`/api/delivery/ready?eventId=${resources.eventId}`, {
    headers: deviceHeaders(reception), expected: 403,
  });
  assert(wrongRole.error === "DEVICE_ROLE_FORBIDDEN", "Role mismatch was not rejected by the API");

  const orderPayload = {
    eventId: resources.eventId,
    mode: "ONLINE",
    acceptedAt: new Date().toISOString(),
    requestId: randomUUID(),
    items: [{
      itemCode: resources.itemId,
      quantity: 2,
      note: "受入確認備考",
      options: [{ groupName: "味付け", optionName: "ソース" }],
    }],
  };
  const missingRequiredOption = await jsonRequest("/api/orders", {
    method: "POST",
    headers: deviceHeaders(reception),
    json: {
      ...orderPayload,
      requestId: randomUUID(),
      items: [{ ...orderPayload.items[0], options: [] }],
    },
    expected: 400,
  });
  assert(missingRequiredOption.error === "INVALID_MENU_SELECTION", "Required menu options were not enforced");
  const createdOrder = await jsonRequest("/api/orders", {
    method: "POST", headers: deviceHeaders(reception), json: orderPayload, expected: 201,
  });
  const order = createdOrder.order;
  assert(order?.status === "WAITING" && order.ticket_number !== "__ONLINE__", "Online order was not numbered and queued");
  const replay = await jsonRequest("/api/orders", {
    method: "POST", headers: deviceHeaders(reception), json: orderPayload,
  });
  assert(replay.replayed === true && replay.order.id === order.id, "Order idempotency replay failed");

  const firstAssignment = await jsonRequest("/api/kitchen/next", {
    method: "POST",
    headers: deviceHeaders(kitchenA),
    json: { eventId: resources.eventId, deviceId: kitchenA.id, operationId: randomUUID() },
  });
  assert(firstAssignment.assignment?.id === order.id, "Kitchen A did not receive the queued order");
  const cookingDisplay = await jsonRequest(`/api/display/cooking?eventId=${resources.eventId}`);
  const cookingPublicOrder = cookingDisplay.orders?.find((candidate) => candidate.id === order.id);
  assert(cookingPublicOrder?.ticket_number === order.ticket_number, "Cooking display did not include the ticket number");
  assert(!Object.hasOwn(cookingPublicOrder, "items"), "Public cooking display exposed item details");

  await request(`/api/admin/orders/${order.id}/requeue`, {
    method: "POST", headers: adminHeaders(), json: { operationId: randomUUID() },
  });
  const secondAssignment = await jsonRequest("/api/kitchen/next", {
    method: "POST",
    headers: deviceHeaders(kitchenB),
    json: { eventId: resources.eventId, deviceId: kitchenB.id, operationId: randomUUID() },
  });
  assert(secondAssignment.assignment?.id === order.id, "Kitchen B did not receive the requeued order");
  const staleKitchen = await jsonRequest(`/api/orders/${order.id}/ready`, {
    method: "POST",
    headers: deviceHeaders(kitchenA),
    json: { deviceId: kitchenA.id, operationId: randomUUID() },
    expected: 403,
  });
  assert(staleKitchen.error === "DEVICE_MISMATCH", "The previous kitchen could still complete a requeued order");
  await request(`/api/orders/${order.id}/ready`, {
    method: "POST",
    headers: deviceHeaders(kitchenB),
    json: { deviceId: kitchenB.id, operationId: randomUUID() },
  });

  const deliveryQueue = await jsonRequest(`/api/delivery/ready?eventId=${resources.eventId}`, {
    headers: deviceHeaders(delivery),
  });
  const deliveryOrder = deliveryQueue.orders?.find((candidate) => candidate.id === order.id);
  assert(deliveryOrder?.items?.[0]?.quantity === 2, "Delivery did not receive item quantity");
  assert(deliveryOrder.items[0].note === "受入確認備考", "Delivery did not receive the item note");
  assert(deliveryOrder.items[0].options?.[0]?.option_name === "ソース", "Delivery did not receive item options");
  const readyDisplay = await jsonRequest(`/api/display/ready?eventId=${resources.eventId}`);
  const readyPublicOrder = readyDisplay.orders?.find((candidate) => candidate.id === order.id);
  assert(readyPublicOrder?.ticket_number === order.ticket_number, "Ready display did not include the ticket number");
  assert(!Object.hasOwn(readyPublicOrder, "items"), "Public ready display exposed item details");

  await request(`/api/orders/${order.id}/complete`, {
    method: "POST",
    headers: deviceHeaders(delivery),
    json: { deviceId: delivery.id, operationId: randomUUID() },
  });
  const adminOrders = await jsonRequest(`/api/admin/orders?eventId=${resources.eventId}`, { headers: adminHeaders() });
  const completed = adminOrders.orders?.find((candidate) => candidate.id === order.id);
  assert(completed?.status === "COMPLETED", "Order did not reach COMPLETED");
  for (const field of ["accepted_at", "created_at", "cooking_started_at", "ready_at", "completed_at"]) {
    assert(typeof completed[field] === "string" && Number.isFinite(Date.parse(completed[field])), `Completed order is missing ${field}`);
  }
  assert(completed.assigned_device_id === kitchenB.id, "Completed order lost its assigned kitchen");

  const renamedEvent = await jsonRequest(`/api/admin/events/${resources.eventId}`, {
    method: "PATCH",
    headers: adminHeaders(),
    json: { name: `自動受入確認（名称変更） ${runId}` },
  });
  assert(renamedEvent.numbersReset === true, "Renaming the open business day did not reset order numbers");

  const cancellableOrderResult = await jsonRequest("/api/orders", {
    method: "POST",
    headers: deviceHeaders(reception),
    json: { ...orderPayload, requestId: randomUUID(), acceptedAt: new Date().toISOString() },
    expected: 201,
  });
  const cancellableOrder = cancellableOrderResult.order;
  assert(cancellableOrder.ticket_number === order.ticket_number, "The first number after renaming did not return to the configured start");
  const cancelOperationId = randomUUID();
  const cancelledOrder = await jsonRequest(`/api/admin/orders/${cancellableOrder.id}/cancel`, {
    method: "POST",
    headers: adminHeaders(),
    json: { operationId: cancelOperationId, reason: "自動受入確認による取消" },
  });
  assert(cancelledOrder.order?.status === "CANCELLED", "Admin cancellation did not reach CANCELLED");
  const auditTrail = await jsonRequest(`/api/admin/orders/${cancellableOrder.id}/history`, { headers: adminHeaders() });
  const cancellationEntry = auditTrail.history?.at(-1);
  assert(auditTrail.order?.status === "CANCELLED", "Audit trail did not return the current order status");
  assert(cancellationEntry?.from_status === "WAITING" && cancellationEntry.to_status === "CANCELLED", "Audit trail is missing the cancellation transition");
  assert(cancellationEntry.operation_id === cancelOperationId, "Audit trail lost the cancellation operation ID");
  assert(cancellationEntry.metadata?.reason === "MANUAL_CANCEL" && cancellationEntry.metadata?.note === "自動受入確認による取消", "Audit trail lost the cancellation reason");
  assert(typeof cancellationEntry.device_id === "string" && cancellationEntry.device_id.startsWith("ADMIN:"), "Audit trail did not identify the administrator");

  const receptionCancellableResult = await jsonRequest("/api/orders", {
    method: "POST",
    headers: deviceHeaders(reception),
    json: { ...orderPayload, requestId: randomUUID(), acceptedAt: new Date().toISOString() },
    expected: 201,
  });
  const receptionCancellable = receptionCancellableResult.order;
  const receptionLookup = await jsonRequest(`/api/reception/orders/lookup?eventId=${resources.eventId}&ticketNumber=${encodeURIComponent(receptionCancellable.ticket_number)}`, {
    headers: deviceHeaders(reception),
  });
  assert(receptionLookup.order?.id === receptionCancellable.id && receptionLookup.order?.items?.length === 1, "Reception lookup did not return the expected order details");
  const receptionCancelOperationId = randomUUID();
  const receptionCancelled = await jsonRequest(`/api/reception/orders/${receptionCancellable.id}/cancel`, {
    method: "POST",
    headers: deviceHeaders(reception),
    json: { operationId: receptionCancelOperationId, reason: "受付端末の自動受入確認による取消" },
  });
  assert(receptionCancelled.order?.status === "CANCELLED", "Reception cancellation did not reach CANCELLED");
  const receptionAuditTrail = await jsonRequest(`/api/admin/orders/${receptionCancellable.id}/history`, { headers: adminHeaders() });
  const receptionCancellationEntry = receptionAuditTrail.history?.at(-1);
  assert(receptionCancellationEntry?.operation_id === receptionCancelOperationId, "Reception cancellation audit lost the operation ID");
  assert(receptionCancellationEntry?.device_id === reception.id, "Reception cancellation audit lost the reception device ID");
  const assignmentAfterCancellation = await jsonRequest("/api/kitchen/next", {
    method: "POST",
    headers: deviceHeaders(kitchenA),
    json: { eventId: resources.eventId, deviceId: kitchenA.id, operationId: randomUUID() },
  });
  assert(assignmentAfterCancellation.assignment === null, "A cancelled order was assigned to a kitchen");

  const summary = await jsonRequest(`/api/admin/summary?eventId=${resources.eventId}`, { headers: adminHeaders() });
  assert(summary.summary?.COMPLETED === 1 && summary.summary?.CANCELLED === 2 && summary.total === 3, "Admin summary counts are incorrect");
  const productCount = summary.productCounts?.find((product) => product.item_code === resources.itemId);
  assert(productCount?.quantity === 2 && productCount.order_count === 1, "Admin product summary did not exclude cancelled quantities");
  assert(productCount.cancelled_quantity === 4 && productCount.total_quantity === 6, "Admin product summary cancellation totals are incorrect");
  const receptionProductSummary = await jsonRequest(`/api/reception/product-summary?eventId=${resources.eventId}`, { headers: deviceHeaders(reception) });
  const receptionProductCount = receptionProductSummary.productCounts?.find((product) => product.item_code === resources.itemId);
  assert(receptionProductSummary.itemTotal === 2 && receptionProductCount?.quantity === 2, "Reception product summary is incorrect");
  assert(!Object.hasOwn(receptionProductCount, "cancelled_quantity"), "Reception product summary exposed management-only cancellation totals");
  const csvResponse = await request(`/api/admin/export.csv?eventId=${resources.eventId}`, { headers: adminHeaders() });
  const csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
  const csvText = new TextDecoder().decode(csvBytes);
  assert(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, "CSV does not have a UTF-8 BOM");
  assert(csvText.includes("\r\n"), "CSV does not use CRLF line endings");
  assert(csvText.includes(`受入焼きそば ${runId}（味付け：ソース、備考：受入確認備考）×2`), "CSV is missing Japanese item details");
  assert(csvText.includes(kitchenB.id), "CSV is missing the assigned kitchen");
  assert(csvText.includes("CANCELLED"), "CSV is missing the cancelled order");
  const productCsvResponse = await request(`/api/admin/product-summary.csv?eventId=${resources.eventId}`, { headers: adminHeaders() });
  const productCsvBytes = new Uint8Array(await productCsvResponse.arrayBuffer());
  const productCsvText = new TextDecoder().decode(productCsvBytes);
  assert(productCsvBytes[0] === 0xef && productCsvBytes[1] === 0xbb && productCsvBytes[2] === 0xbf, "Product summary CSV does not have a UTF-8 BOM");
  assert(productCsvText.startsWith("item_code,item_name,order_count,quantity,cancelled_quantity,total_quantity\r\n"), "Product summary CSV columns are incorrect");
  assert(productCsvText.includes(resources.itemId) && productCsvText.includes(createdItem.item.name), "Product summary CSV is missing the product row");
  assert(!productCsvText.includes("ソース"), "Product summary CSV incorrectly includes option details");

  await disableDevice(display.id);
  const disabledSession = await jsonRequest("/api/device/session", {
    headers: deviceHeaders(display), expected: 401,
  });
  assert(disabledSession.error === "INVALID_DEVICE_CREDENTIALS", "Disabled device credentials remained valid");
  const rotatedReception = await jsonRequest(`/api/admin/devices/${reception.id}`, {
    method: "PATCH", headers: adminHeaders(), json: { rotateKey: true },
  });
  const oldReceptionSession = await jsonRequest("/api/device/session", {
    headers: deviceHeaders(reception), expected: 401,
  });
  assert(oldReceptionSession.error === "INVALID_DEVICE_CREDENTIALS", "Rotated device key remained valid");
  reception.key = rotatedReception.deviceKey;
  await request("/api/device/session", { headers: deviceHeaders(reception) });

  await cleanup();
  const revokedAdmin = await jsonRequest("/api/admin/events", { headers: adminHeaders(), expected: 401 });
  assert(revokedAdmin.error === "SESSION_EXPIRED", "Logged-out admin session remained valid");
  console.log(`Acceptance check passed: ${baseUrl.origin} (${runId})`);
}

let mainError;
try {
  await main();
} catch (error) {
  mainError = error;
  process.exitCode = 1;
  console.error(`Acceptance check failed: ${error.message}`);
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    process.exitCode = 1;
    console.error(cleanupError.message);
    if (!mainError) mainError = cleanupError;
  }
}
