import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashDeviceKey, type DeviceRole } from "../src/device-auth";

const TEST_DEVICE_KEY = "test-device-key-1234567890";

type Assignment = {
  id: string;
  ticket_number: string;
  status: "COOKING";
  assigned_device_id: string;
  items: Array<{
    item_name: string;
    quantity: number;
    options: Array<{ group_name: string; option_name: string; required: number }>;
  }>;
};

type DetailedOrder = Omit<Assignment, "status"> & {
  status: string;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<{ response: Response; data: T }> {
  const response = await exports.default.fetch(new Request(`https://example.test${path}`, init));
  return { response, data: await response.json<T>() };
}

async function seedQueue(orderCount: number): Promise<string> {
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO events (id, name, business_date, status, created_at, updated_at)
       VALUES (?1, '競合テスト', '2026-08-21', 'OPEN', ?2, ?2)`,
    ).bind(eventId, now),
  ];

  for (let index = 0; index < orderCount; index += 1) {
    const orderId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const acceptedAt = new Date(Date.parse(now) + index).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT INTO orders
           (id, event_id, ticket_number, status, accepted_at, created_at, updated_at, request_id)
         VALUES (?1, ?2, ?3, 'WAITING', ?4, ?4, ?4, ?5)`,
      ).bind(orderId, eventId, String(index + 1).padStart(3, "0"), acceptedAt, crypto.randomUUID()),
      env.DB.prepare(
        `INSERT INTO order_items (id, order_id, item_code, item_name, quantity, created_at)
         VALUES (?1, ?2, 'FOOD', '焼きそば', 1, ?3)`,
      ).bind(itemId, orderId, acceptedAt),
      env.DB.prepare(
        `INSERT INTO order_item_options (id, order_item_id, group_name, option_name, required, created_at)
         VALUES (?1, ?2, '味付け', 'ソース', 1, ?3)`,
      ).bind(crypto.randomUUID(), itemId, acceptedAt),
    );
  }

  await env.DB.batch(statements);
  return eventId;
}

async function registerDevice(deviceId: string, role: DeviceRole, key = TEST_DEVICE_KEY): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO devices (id, device_key_hash, role, display_name, active, created_at)
     VALUES (?1, ?2, ?3, ?1, 1, ?4)
     ON CONFLICT(id) DO UPDATE SET device_key_hash = excluded.device_key_hash, role = excluded.role, active = 1`,
  ).bind(deviceId, await hashDeviceKey(key), role, new Date().toISOString()).run();
}

function deviceHeaders(deviceId: string, key = TEST_DEVICE_KEY): Record<string, string> {
  return { "content-type": "application/json", "X-Device-ID": deviceId, "X-Device-Key": key };
}

async function nextOrder(eventId: string, deviceId: string): Promise<Assignment | null> {
  const { response, data } = await requestJson<{ assignment: Assignment | null }>("/api/kitchen/next", {
    method: "POST",
    headers: deviceHeaders(deviceId),
    body: JSON.stringify({ eventId, deviceId, operationId: crypto.randomUUID() }),
  });
  expect(response.status).toBe(200);
  return data.assignment;
}

async function completeCooking(order: Assignment): Promise<void> {
  const { response } = await requestJson(`/api/orders/${order.id}/ready`, {
    method: "POST",
    headers: deviceHeaders(order.assigned_device_id),
    body: JSON.stringify({ deviceId: order.assigned_device_id, operationId: crypto.randomUUID() }),
  });
  expect(response.status).toBe(200);
}

describe("Worker order flow", () => {
  it("reports readiness only after the required database schema is available", async () => {
    const { response, data } = await requestJson<{ ok: boolean; database: string; schemaVersion: number }>("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(data).toEqual({ ok: true, service: "order-system", database: "ready", schemaVersion: 12 });
  });

  it("rejects unknown APIs and invalid realtime events before Durable Object routing", async () => {
    const unknownApi = await requestJson<{ error: string }>("/api/not-a-real-endpoint");
    expect(unknownApi.response.status).toBe(404);
    expect(unknownApi.response.headers.get("content-type")).toContain("application/json");
    expect(unknownApi.response.headers.get("cache-control")).toBe("no-store");
    expect(unknownApi.data).toEqual({ error: "API_NOT_FOUND" });

    const missingEventId = await requestJson<{ error: string }>("/api/realtime");
    expect(missingEventId.response.status).toBe(400);
    expect(missingEventId.data.error).toBe("EVENT_ID_REQUIRED");

    const unknownEvent = await requestJson<{ error: string }>(`/api/realtime?eventId=${crypto.randomUUID()}`);
    expect(unknownEvent.response.status).toBe(404);
    expect(unknownEvent.data.error).toBe("EVENT_NOT_FOUND");

    const closedEventId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO events (id, name, business_date, status, created_at, updated_at)
       VALUES (?1, '終了済み営業日', '2026-08-20', 'CLOSED', ?2, ?2)`,
    ).bind(closedEventId, now).run();
    const closedEvent = await requestJson<{ error: string }>(`/api/realtime?eventId=${closedEventId}`);
    expect(closedEvent.response.status).toBe(409);
    expect(closedEvent.data.error).toBe("EVENT_NOT_OPEN");

    const openEventId = await seedQueue(0);
    const currentEvent = await requestJson<{ event: { id: string } }>("/api/current-business-day");
    expect(currentEvent.response.status).toBe(200);
    expect(currentEvent.response.headers.get("cache-control")).toBe("no-store");
    expect(currentEvent.data.event.id).toBe(openEventId);
    const noUpgrade = await requestJson<{ error: string }>(`/api/realtime?eventId=${openEventId}`);
    expect(noUpgrade.response.status).toBe(426);
    expect(noUpgrade.data.error).toBe("WEBSOCKET_UPGRADE_REQUIRED");
  });

  it("restores the same cooking assignment after a kitchen reload", async () => {
    const eventId = await seedQueue(2);
    await registerDevice("KITCHEN-01", "KITCHEN");
    const first = await nextOrder(eventId, "KITCHEN-01");
    const resumed = await nextOrder(eventId, "KITCHEN-01");

    expect(first).not.toBeNull();
    expect(resumed?.id).toBe(first?.id);
    expect(resumed?.items[0]).toMatchObject({
      item_name: "焼きそば",
      quantity: 1,
      options: [{ group_name: "味付け", option_name: "ソース", required: 1 }],
    });

    const waiting = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1 AND status = 'WAITING'",
    ).bind(eventId).first<{ count: number }>();
    expect(waiting?.count).toBe(1);
    const countResult = await requestJson<{ assignment: Assignment; waitingCount: number }>("/api/kitchen/next", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-01"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-01", operationId: crypto.randomUUID() }),
    });
    expect(countResult.data.assignment.id).toBe(first?.id);
    expect(countResult.data.waitingCount).toBe(1);
  });

  it("does not reload item details when the kitchen already has the current assignment", async () => {
    const eventId = await seedQueue(2);
    await registerDevice("KITCHEN-CACHED", "KITCHEN");
    const first = await nextOrder(eventId, "KITCHEN-CACHED");
    expect(first).not.toBeNull();

    const known = await requestJson<{ assignment: null; assignmentUnchanged: boolean; assignmentId: string; waitingCount: number }>("/api/kitchen/next", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-CACHED"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-CACHED", operationId: crypto.randomUUID(), knownOrderId: first!.id }),
    });
    expect(known.response.status).toBe(200);
    expect(known.data).toMatchObject({ assignment: null, assignmentUnchanged: true, assignmentId: first!.id, waitingCount: 1 });
  });

  it("requeues an unstarted assignment before going away and blocks new assignments", async () => {
    const eventId = await seedQueue(2);
    await registerDevice("KITCHEN-AWAY-01", "KITCHEN");
    await registerDevice("KITCHEN-AWAY-02", "KITCHEN");
    const assignment = await nextOrder(eventId, "KITCHEN-AWAY-01");
    expect(assignment).not.toBeNull();

    const presence = await requestJson<{ away: boolean; assignment: null; requeuedOrderId: string }>("/api/kitchen/presence", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-AWAY-01"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-AWAY-01", away: true, mode: "REQUEUE_UNSTARTED", confirmedUnstarted: true, operationId: crypto.randomUUID() }),
    });
    expect(presence.response.status).toBe(200);
    expect(presence.data).toMatchObject({ away: true, assignment: null, requeuedOrderId: assignment!.id });
    const requeued = await env.DB.prepare(`SELECT status, assigned_device_id FROM orders WHERE id = ?1`).bind(assignment!.id).first<{ status: string; assigned_device_id: string | null }>();
    expect(requeued).toEqual({ status: "WAITING", assigned_device_id: null });

    const awayNext = await requestJson<{ away: boolean; assignment: Assignment | null }>("/api/kitchen/next", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-AWAY-01"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-AWAY-01", operationId: crypto.randomUUID() }),
    });
    expect(awayNext.data).toMatchObject({ away: true, assignment: null });
    expect((await nextOrder(eventId, "KITCHEN-AWAY-02"))?.id).toBe(assignment!.id);
  });

  it("finishes the current assignment before going away and resumes automatic assignment when active", async () => {
    const eventId = await seedQueue(2);
    await registerDevice("KITCHEN-FINISH-AWAY", "KITCHEN");
    const assignment = await nextOrder(eventId, "KITCHEN-FINISH-AWAY");
    expect(assignment).not.toBeNull();

    const leaving = await requestJson<{ away: boolean; assignment: Assignment }>("/api/kitchen/presence", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-FINISH-AWAY"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-FINISH-AWAY", away: true, mode: "FINISH_CURRENT", operationId: crypto.randomUUID() }),
    });
    expect(leaving.data.away).toBe(true);
    expect(leaving.data.assignment.id).toBe(assignment!.id);
    await completeCooking(assignment!);
    expect(await nextOrder(eventId, "KITCHEN-FINISH-AWAY")).toBeNull();

    const resumed = await requestJson<{ away: boolean }>("/api/kitchen/presence", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-FINISH-AWAY"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-FINISH-AWAY", away: false, operationId: crypto.randomUUID() }),
    });
    expect(resumed.data.away).toBe(false);
    expect(await nextOrder(eventId, "KITCHEN-FINISH-AWAY")).not.toBeNull();
  });

  it("prefers the idle kitchen with the oldest cooking completion", async () => {
    const eventId = await seedQueue(3);
    await registerDevice("KITCHEN-FAIR-01", "KITCHEN");
    await registerDevice("KITCHEN-FAIR-02", "KITCHEN");

    await requestJson(`/api/kitchen/state?eventId=${eventId}&deviceId=KITCHEN-FAIR-01`, { headers: deviceHeaders("KITCHEN-FAIR-01") });
    await requestJson(`/api/kitchen/state?eventId=${eventId}&deviceId=KITCHEN-FAIR-02`, { headers: deviceHeaders("KITCHEN-FAIR-02") });

    const first = await nextOrder(eventId, "KITCHEN-FAIR-01");
    expect(first?.ticket_number).toBe("001");
    await completeCooking(first!);

    expect(await nextOrder(eventId, "KITCHEN-FAIR-01")).toBeNull();
    const second = await nextOrder(eventId, "KITCHEN-FAIR-02");
    expect(second?.ticket_number).toBe("002");
    await completeCooking(second!);

    const third = await nextOrder(eventId, "KITCHEN-FAIR-01");
    expect(third?.ticket_number).toBe("003");
  });

  it("returns only minimal public status and queue counts for the current business day", async () => {
    await env.DB.prepare(`UPDATE events SET status = 'CLOSED' WHERE status = 'OPEN'`).run();
    await seedQueue(2);
    const status = await requestJson<{ order: Record<string, unknown> }>("/api/public/order-status?ticketNumber=002");
    expect(status.response.status).toBe(200);
    expect(status.response.headers.get("cache-control")).toBe("no-store");
    expect(status.data.order).toEqual({ ticketNumber: "002", status: "WAITING", ordersAhead: 1, itemsAhead: 1 });
    expect(status.data.order).not.toHaveProperty("id");
    expect(status.data.order).not.toHaveProperty("items");
  });

  it("uses covering relation indexes for polled order detail queries", async () => {
    const itemPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id, item_name, quantity, note
       FROM order_items WHERE order_id = ?1 ORDER BY rowid ASC`,
    ).bind("order-id").all<{ detail: string }>();
    expect(itemPlan.results.some(({ detail }) => detail.includes("order_items_order_id_idx"))).toBe(true);

    const optionPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT oio.order_item_id, oio.group_name, oio.option_name, oio.required
       FROM order_item_options oio
       JOIN order_items oi ON oi.id = oio.order_item_id
       WHERE oi.order_id IN (?1)
       ORDER BY oio.rowid ASC`,
    ).bind("order-id").all<{ detail: string }>();
    expect(optionPlan.results.some(({ detail }) => detail.includes("order_items_order_id_idx"))).toBe(true);
    expect(optionPlan.results.some(({ detail }) => detail.includes("order_item_options_order_item_id_idx"))).toBe(true);

    const ticketPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id, event_id, ticket_number, status, accepted_at
       FROM orders WHERE event_id = ?1 AND ticket_number = ?2
       ORDER BY created_at DESC LIMIT 1`,
    ).bind("event-id", "100").all<{ detail: string }>();
    expect(ticketPlan.results.some(({ detail }) => detail.includes("orders_ticket_idx"))).toBe(true);

    const kitchenPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id, ticket_number, status, assigned_device_id
       FROM orders
       WHERE event_id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING'
       ORDER BY cooking_started_at ASC, id ASC LIMIT 1`,
    ).bind("event-id", "device-id").all<{ detail: string }>();
    expect(kitchenPlan.results.some(({ detail }) => detail.includes("orders_kitchen_assignment_idx"))).toBe(true);

    const itemSummaryPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT COALESCE(SUM(order_items.quantity), 0)
       FROM orders
       JOIN order_items ON order_items.order_id = orders.id
       WHERE orders.event_id = ?1 AND orders.status <> 'CANCELLED'`,
    ).bind("event-id").all<{ detail: string }>();
    expect(itemSummaryPlan.results.some(({ detail }) => detail.includes("orders_queue_idx"))).toBe(true);
    expect(itemSummaryPlan.results.some(({ detail }) => detail.includes("order_items_order_id_idx"))).toBe(true);
  });

  it("assigns 100 queued orders to five kitchens without duplicates or gaps", async () => {
    const eventId = await seedQueue(100);
    const devices = ["KITCHEN-01", "KITCHEN-02", "KITCHEN-03", "KITCHEN-04", "KITCHEN-05"];
    await Promise.all(devices.map((deviceId) => registerDevice(deviceId, "KITCHEN")));
    const assignedNumbers: string[] = [];

    for (let round = 0; round < 20; round += 1) {
      const assignments = new Map<string, Assignment>();
      for (let attempt = 0; attempt < devices.length && assignments.size < devices.length; attempt += 1) {
        const pendingDevices = devices.filter((deviceId) => !assignments.has(deviceId));
        const results = await Promise.all(pendingDevices.map(async (deviceId) => ({ deviceId, assignment: await nextOrder(eventId, deviceId) })));
        for (const { deviceId, assignment } of results) {
          if (assignment) assignments.set(deviceId, assignment);
        }
      }
      expect(assignments.size).toBe(devices.length);
      const activeAssignments = [...assignments.values()];
      const roundNumbers = activeAssignments.map((assignment) => assignment.ticket_number).sort();
      const expectedRoundNumbers = Array.from(
        { length: devices.length },
        (_, index) => String((round * devices.length) + index + 1).padStart(3, "0"),
      );
      expect(roundNumbers).toEqual(expectedRoundNumbers);
      assignedNumbers.push(...roundNumbers);
      await Promise.all(activeAssignments.map(completeCooking));
    }

    expect(new Set(assignedNumbers).size).toBe(100);
    expect(assignedNumbers).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1).padStart(3, "0")));
    expect(await nextOrder(eventId, "KITCHEN-01")).toBeNull();
  }, 20_000);

  it("shows item details only on delivery and protected admin outputs", async () => {
    const eventId = await seedQueue(2);
    await registerDevice("KITCHEN-01", "KITCHEN");
    await registerDevice("DELIVERY-01", "DELIVERY");
    await registerDevice("DISPLAY-01", "DISPLAY");
    const assignment = await nextOrder(eventId, "KITCHEN-01");
    expect(assignment).not.toBeNull();
    await completeCooking(assignment!);

    const delivery = await requestJson<{ orders: DetailedOrder[] }>(`/api/delivery/ready?eventId=${eventId}`, { headers: deviceHeaders("DELIVERY-01") });
    expect(delivery.response.status).toBe(200);
    expect(delivery.data.orders[0].items[0]).toMatchObject({
      item_name: "焼きそば",
      quantity: 1,
      options: [{ group_name: "味付け", option_name: "ソース" }],
    });

    const display = await requestJson<{ orders: Array<Record<string, unknown>> }>(`/api/display/ready?eventId=${eventId}`, { headers: deviceHeaders("DISPLAY-01") });
    expect(display.response.status).toBe(200);
    expect(display.data.orders[0]).not.toHaveProperty("items");

    const displaced = await nextOrder(eventId, "KITCHEN-01");
    expect(displaced?.ticket_number).toBe("002");
    const reworkOperationId = crypto.randomUUID();
    const reworked = await requestJson<{ order: { id: string; status: string; assignedDeviceId: string }; displacedOrderId: string }>(`/api/delivery/orders/${assignment!.id}/rework`, {
      method: "POST",
      headers: deviceHeaders("DELIVERY-01"),
      body: JSON.stringify({ deviceId: "DELIVERY-01", operationId: reworkOperationId }),
    });
    expect(reworked.response.status).toBe(200);
    expect(reworked.data).toMatchObject({
      order: { id: assignment!.id, status: "COOKING", assignedDeviceId: "KITCHEN-01" },
      displacedOrderId: displaced!.id,
    });
    const reworkStates = await env.DB.prepare(
      `SELECT id, status, assigned_device_id, ready_at FROM orders WHERE id IN (?1, ?2) ORDER BY ticket_number`,
    ).bind(assignment!.id, displaced!.id).all<{ id: string; status: string; assigned_device_id: string | null; ready_at: string | null }>();
    expect(reworkStates.results[0]).toMatchObject({ id: assignment!.id, status: "COOKING", assigned_device_id: "KITCHEN-01", ready_at: null });
    expect(reworkStates.results[1]).toMatchObject({ id: displaced!.id, status: "WAITING", assigned_device_id: null });
    expect((await nextOrder(eventId, "KITCHEN-01"))?.id).toBe(assignment!.id);
    const replayedRework = await requestJson<{ replayed: boolean }>(`/api/delivery/orders/${assignment!.id}/rework`, {
      method: "POST",
      headers: deviceHeaders("DELIVERY-01"),
      body: JSON.stringify({ deviceId: "DELIVERY-01", operationId: reworkOperationId }),
    });
    expect(replayedRework.data.replayed).toBe(true);
    const undoRework = await requestJson<{ undone: boolean }>(`/api/operations/${reworkOperationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("DELIVERY-01"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(undoRework.response.status).toBe(200);
    const undoneReworkStates = await env.DB.prepare(
      `SELECT id, status, assigned_device_id FROM orders WHERE id IN (?1, ?2) ORDER BY ticket_number`,
    ).bind(assignment!.id, displaced!.id).all<{ id: string; status: string; assigned_device_id: string | null }>();
    expect(undoneReworkStates.results[0]).toMatchObject({ id: assignment!.id, status: "READY", assigned_device_id: "KITCHEN-01" });
    expect(undoneReworkStates.results[1]).toMatchObject({ id: displaced!.id, status: "COOKING", assigned_device_id: "KITCHEN-01" });

    const unauthenticated = await exports.default.fetch(new Request(`https://example.test/api/admin/orders?eventId=${eventId}`));
    expect(unauthenticated.status).toBe(401);
    const setupAvailable = await requestJson<{ available: boolean }>("/api/auth/setup-status");
    expect(setupAvailable.response.headers.get("cache-control")).toBe("no-store");
    expect(setupAvailable.data).toEqual({ available: true });
    const setupWithoutToken = await requestJson<{ error: string }>("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "integration-admin", password: "integration-password" }),
    });
    expect(setupWithoutToken.response.status).toBe(400);
    const setupWithWrongToken = await requestJson<{ error: string }>("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "integration-admin", password: "integration-password", setupToken: "wrong-token" }),
    });
    expect(setupWithWrongToken.response.status).toBe(403);
    expect(setupWithWrongToken.data).toEqual({ error: "INVALID_SETUP_TOKEN" });
    for (const invalidSetupBody of [
      { loginName: {}, password: "integration-password", setupToken: "test-admin-setup-token-32-characters" },
      { loginName: "integration-admin", password: [], setupToken: "test-admin-setup-token-32-characters" },
      { loginName: "A".repeat(65), password: "integration-password", setupToken: "test-admin-setup-token-32-characters" },
      { loginName: "integration-admin", password: "P".repeat(257), setupToken: "test-admin-setup-token-32-characters" },
    ]) {
      const invalidSetup = await requestJson<{ error: string }>("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidSetupBody),
      });
      expect(invalidSetup.response.status).toBe(400);
      expect(invalidSetup.data.error).toBe("INVALID_REQUEST");
    }
    const setup = await requestJson("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: " integration-admin ", password: "integration-password", setupToken: "test-admin-setup-token-32-characters" }),
    });
    expect(setup.response.status).toBe(201);
    const setupCompleted = await requestJson<{ available: boolean }>("/api/auth/setup-status");
    expect(setupCompleted.data).toEqual({ available: false });
    const repeatedSetup = await requestJson<{ error: string }>("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "other-admin", password: "another-password", setupToken: "wrong-token" }),
    });
    expect(repeatedSetup.response.status).toBe(409);
    expect(repeatedSetup.data).toEqual({ error: "SETUP_ALREADY_COMPLETED" });
    for (const invalidLoginBody of [
      { loginName: {}, password: "integration-password" },
      { loginName: "integration-admin", password: [] },
      { loginName: "A".repeat(65), password: "integration-password" },
      { loginName: "integration-admin", password: "P".repeat(257) },
    ]) {
      const invalidLogin = await requestJson<{ error: string }>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify(invalidLoginBody),
      });
      expect(invalidLogin.response.status).toBe(400);
      expect(invalidLogin.data.error).toBe("INVALID_REQUEST");
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await requestJson<{ error: string }>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
        body: JSON.stringify({ loginName: "integration-admin", password: "wrong-password" }),
      });
      expect(failedLogin.response.status).toBe(401);
    }
    const limitedLogin = await requestJson<{ error: string; retryAfter: number }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
      body: JSON.stringify({ loginName: "integration-admin", password: "integration-password" }),
    });
    expect(limitedLogin.response.status).toBe(429);
    expect(limitedLogin.response.headers.get("Retry-After")).toBeTruthy();
    expect(limitedLogin.data.error).toBe("RATE_LIMITED");
    const login = await requestJson<{ token: string }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.11" },
      body: JSON.stringify({ loginName: " integration-admin ", password: "integration-password" }),
    });
    expect(login.response.status).toBe(200);
    const headers = { Authorization: `Bearer ${login.data.token}` };
    const admin = await requestJson<{ orders: DetailedOrder[] }>(`/api/admin/orders?eventId=${eventId}`, { headers });
    expect(admin.data.orders[0].items[0].options[0]).toMatchObject({ group_name: "味付け", option_name: "ソース" });

    for (const invalidDevice of [
      { id: "UNTRUSTED-ROLE", role: "SUPERUSER", displayName: "不正な役割" },
      { id: "INVALID DEVICE", role: "DELIVERY", displayName: "不正なID" },
      { id: "EMPTY-NAME", role: "DELIVERY", displayName: "   " },
      { id: "A".repeat(65), role: "DELIVERY", displayName: "長すぎるID" },
      { id: "LONG-NAME", role: "DELIVERY", displayName: "長".repeat(101) },
    ]) {
      const invalidCreate = await requestJson<{ error: string }>("/api/admin/devices", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(invalidDevice),
      });
      expect(invalidCreate.response.status).toBe(400);
      expect(invalidCreate.data.error).toBe("INVALID_REQUEST");
    }

    const createdDevice = await requestJson<{ device: { id: string }; deviceKey: string }>("/api/admin/devices", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: "DELIVERY-PROVISIONED", role: "DELIVERY", displayName: "受け渡し確認端末" }),
    });
    expect(createdDevice.response.status).toBe(201);
    expect(createdDevice.data.deviceKey).toMatch(/^[0-9a-f]{48}$/);
    const provisionedSession = await requestJson<{ device: { id: string; role: string }; authenticatedAt: string; reauthGraceMinutes: number; reauthGraceExpiresAt: string }>("/api/device/session", {
      headers: deviceHeaders("DELIVERY-PROVISIONED", createdDevice.data.deviceKey),
    });
    expect(provisionedSession.data.device).toMatchObject({ id: "DELIVERY-PROVISIONED", role: "DELIVERY" });
    expect(provisionedSession.data.reauthGraceMinutes).toBe(30);
    expect(Date.parse(provisionedSession.data.reauthGraceExpiresAt) - Date.parse(provisionedSession.data.authenticatedAt)).toBe(30 * 60_000);
    for (const invalidUpdate of [
      { role: "SUPERUSER" },
      { displayName: "" },
      { active: "false" },
      { rotateKey: "true" },
    ]) {
      const rejectedUpdate = await requestJson<{ error: string }>("/api/admin/devices/DELIVERY-PROVISIONED", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(invalidUpdate),
      });
      expect(rejectedUpdate.response.status).toBe(400);
      expect(rejectedUpdate.data.error).toBe("INVALID_REQUEST");
    }
    const unchangedDevice = await env.DB.prepare(`SELECT role, display_name, active FROM devices WHERE id = 'DELIVERY-PROVISIONED'`).first<{ role: string; display_name: string; active: number }>();
    expect(unchangedDevice).toEqual({ role: "DELIVERY", display_name: "受け渡し確認端末", active: 1 });
    const rotatedDevice = await requestJson<{ deviceKey: string }>("/api/admin/devices/DELIVERY-PROVISIONED", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ rotateKey: true }),
    });
    expect(rotatedDevice.data.deviceKey).not.toBe(createdDevice.data.deviceKey);
    const oldKeySession = await exports.default.fetch(new Request("https://example.test/api/device/session", {
      headers: deviceHeaders("DELIVERY-PROVISIONED", createdDevice.data.deviceKey),
    }));
    expect(oldKeySession.status).toBe(401);
    await requestJson("/api/admin/devices/DELIVERY-PROVISIONED", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    const disabledDevice = await exports.default.fetch(new Request("https://example.test/api/device/session", {
      headers: deviceHeaders("DELIVERY-PROVISIONED", rotatedDevice.data.deviceKey),
    }));
    expect(disabledDevice.status).toBe(401);
    await requestJson("/api/admin/devices/DELIVERY-PROVISIONED", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ active: true }),
    });

    const recoveryEventId = await seedQueue(1);
    await registerDevice("KITCHEN-RECOVERY-01", "KITCHEN");
    await registerDevice("KITCHEN-RECOVERY-02", "KITCHEN");
    const strandedOrder = await nextOrder(recoveryEventId, "KITCHEN-RECOVERY-01");
    expect(strandedOrder).not.toBeNull();
    const assignmentHistory = await env.DB.prepare(
      `SELECT operation_id FROM order_status_history WHERE order_id = ?1 AND to_status = 'COOKING' ORDER BY rowid DESC LIMIT 1`,
    ).bind(strandedOrder!.id).first<{ operation_id: string }>();
    const conflictingRequeue = await requestJson<{ error: string }>(`/api/admin/orders/${strandedOrder!.id}/requeue`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: assignmentHistory!.operation_id }),
    });
    expect(conflictingRequeue.response.status).toBe(409);
    expect(conflictingRequeue.data.error).toBe("IDEMPOTENCY_CONFLICT");
    const requeueOperationId = crypto.randomUUID();
    const requeued = await requestJson<{ order: { id: string; status: string }; replayed?: boolean }>(`/api/admin/orders/${strandedOrder!.id}/requeue`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: requeueOperationId }),
    });
    expect(requeued.response.status).toBe(200);
    expect(requeued.data.order).toMatchObject({ id: strandedOrder!.id, status: "WAITING" });
    const recoveryRow = await env.DB.prepare(`SELECT status, assigned_device_id, cooking_started_at FROM orders WHERE id = ?1`).bind(strandedOrder!.id).first<{ status: string; assigned_device_id: string | null; cooking_started_at: string | null }>();
    expect(recoveryRow).toEqual({ status: "WAITING", assigned_device_id: null, cooking_started_at: null });
    const recoveryHistory = await env.DB.prepare(`SELECT device_id, metadata_json FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2`).bind(strandedOrder!.id, requeueOperationId).first<{ device_id: string; metadata_json: string }>();
    expect(recoveryHistory?.device_id).toMatch(/^ADMIN:/);
    expect(JSON.parse(recoveryHistory!.metadata_json)).toEqual({ reason: "MANUAL_REQUEUE" });
    const pausedRecoveryDevice = await env.DB.prepare(`SELECT kitchen_away FROM devices WHERE id = 'KITCHEN-RECOVERY-01'`).first<{ kitchen_away: number }>();
    expect(pausedRecoveryDevice?.kitchen_away).toBe(1);
    expect(await nextOrder(recoveryEventId, "KITCHEN-RECOVERY-01")).toBeNull();
    const replayedRequeue = await requestJson<{ order: { id: string; status: string }; replayed: boolean }>(`/api/admin/orders/${strandedOrder!.id}/requeue`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: requeueOperationId }),
    });
    expect(replayedRequeue.response.status).toBe(200);
    expect(replayedRequeue.data).toMatchObject({ order: { id: strandedOrder!.id, status: "WAITING" }, replayed: true });
    const reassignedOrder = await nextOrder(recoveryEventId, "KITCHEN-RECOVERY-02");
    expect(reassignedOrder?.id).toBe(strandedOrder!.id);
    const invalidReadyBody = await requestJson<{ error: string }>(`/api/orders/${strandedOrder!.id}/ready`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-RECOVERY-02"),
      body: "null",
    });
    expect(invalidReadyBody.response.status).toBe(400);
    expect(invalidReadyBody.data.error).toBe("INVALID_REQUEST");
    const readyOperationId = crypto.randomUUID();
    const ready = await requestJson<{ order: { id: string; status: string }; replayed?: boolean }>(`/api/orders/${strandedOrder!.id}/ready`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-RECOVERY-02"),
      body: JSON.stringify({ deviceId: "KITCHEN-RECOVERY-02", operationId: readyOperationId }),
    });
    expect(ready.response.status).toBe(200);
    expect(ready.data.order.status).toBe("READY");
    const replayedReady = await requestJson<{ order: { id: string; status: string }; replayed: boolean }>(`/api/orders/${strandedOrder!.id}/ready`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-RECOVERY-02"),
      body: JSON.stringify({ deviceId: "KITCHEN-RECOVERY-02", operationId: readyOperationId }),
    });
    expect(replayedReady.response.status).toBe(200);
    expect(replayedReady.data.replayed).toBe(true);
    const conflictingReady = await requestJson<{ error: string }>(`/api/orders/${strandedOrder!.id}/ready`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-RECOVERY-02"),
      body: JSON.stringify({ deviceId: "KITCHEN-RECOVERY-02", operationId: crypto.randomUUID() }),
    });
    expect(conflictingReady.response.status).toBe(409);
    expect(conflictingReady.data.error).toBe("INVALID_STATE_TRANSITION");
    const staleKitchenAfterReady = await requestJson<{ error: string }>(`/api/orders/${strandedOrder!.id}/ready`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-RECOVERY-01"),
      body: JSON.stringify({ deviceId: "KITCHEN-RECOVERY-01", operationId: crypto.randomUUID() }),
    });
    expect(staleKitchenAfterReady.response.status).toBe(409);
    expect(staleKitchenAfterReady.data.error).toBe("INVALID_STATE_TRANSITION");
    const readyHistoryCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM order_status_history WHERE order_id = ?1 AND to_status = 'READY'`,
    ).bind(strandedOrder!.id).first<{ count: number }>();
    expect(readyHistoryCount?.count).toBe(1);

    const raceEventId = await seedQueue(1);
    await registerDevice("KITCHEN-RACE-01", "KITCHEN");
    const racingOrder = await nextOrder(raceEventId, "KITCHEN-RACE-01");
    expect(racingOrder).not.toBeNull();
    const [racingRequeue, racingReady] = await Promise.all([
      requestJson<{ order?: { status: string }; error?: string }>(`/api/admin/orders/${racingOrder!.id}/requeue`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      }),
      requestJson<{ order?: { status: string }; error?: string }>(`/api/orders/${racingOrder!.id}/ready`, {
        method: "POST",
        headers: deviceHeaders("KITCHEN-RACE-01"),
        body: JSON.stringify({ deviceId: "KITCHEN-RACE-01", operationId: crypto.randomUUID() }),
      }),
    ]);
    expect([racingRequeue.response.status, racingReady.response.status].sort()).toEqual([200, 409]);
    const racingState = await env.DB.prepare(`SELECT status FROM orders WHERE id = ?1`).bind(racingOrder!.id).first<{ status: string }>();
    expect(["WAITING", "READY"]).toContain(racingState?.status);
    const racingTransitions = await env.DB.prepare(
      `SELECT to_status FROM order_status_history
       WHERE order_id = ?1 AND from_status = 'COOKING' AND to_status IN ('WAITING', 'READY')`,
    ).bind(racingOrder!.id).all<{ to_status: string }>();
    expect(racingTransitions.results).toHaveLength(1);
    expect(racingTransitions.results[0].to_status).toBe(racingState?.status);

    const cancellationEventId = await seedQueue(2);
    const cancellableOrders = await env.DB.prepare(
      `SELECT id, ticket_number FROM orders WHERE event_id = ?1 ORDER BY accepted_at ASC, id ASC`,
    ).bind(cancellationEventId).all<{ id: string; ticket_number: string }>();
    const orderToCancel = cancellableOrders.results[0];
    const unauthenticatedCancel = await requestJson<{ error: string }>(`/api/admin/orders/${orderToCancel.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: crypto.randomUUID(), reason: "認証なし" }),
    });
    expect(unauthenticatedCancel.response.status).toBe(401);
    const unauthenticatedHistory = await requestJson<{ error: string }>(`/api/admin/orders/${orderToCancel.id}/history`);
    expect(unauthenticatedHistory.response.status).toBe(401);

    const cancelOperationId = crypto.randomUUID();
    const cancelled = await requestJson<{ order: { id: string; status: string }; replayed?: boolean }>(`/api/admin/orders/${orderToCancel.id}/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: cancelOperationId, reason: "受付内容の誤り" }),
    });
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.data.order).toEqual({ id: orderToCancel.id, status: "CANCELLED" });
    const replayedCancellation = await requestJson<{ order: { id: string; status: string }; replayed: boolean }>(`/api/admin/orders/${orderToCancel.id}/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: cancelOperationId, reason: "受付内容の誤り" }),
    });
    expect(replayedCancellation.data).toMatchObject({ order: { id: orderToCancel.id, status: "CANCELLED" }, replayed: true });
    const cancellationHistory = await env.DB.prepare(
      `SELECT device_id, metadata_json FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2`,
    ).bind(orderToCancel.id, cancelOperationId).first<{ device_id: string; metadata_json: string }>();
    expect(cancellationHistory?.device_id).toMatch(/^ADMIN:/);
    expect(JSON.parse(cancellationHistory!.metadata_json)).toEqual({ reason: "MANUAL_CANCEL", note: "受付内容の誤り" });
    const auditTrail = await requestJson<{
      order: { id: string; ticket_number: string; status: string };
      history: Array<{ from_status: string | null; to_status: string; device_id: string | null; operation_id: string; metadata: Record<string, unknown> | null }>;
    }>(`/api/admin/orders/${orderToCancel.id}/history`, { headers });
    expect(auditTrail.response.headers.get("cache-control")).toBe("no-store");
    expect(auditTrail.data.order).toMatchObject({ id: orderToCancel.id, status: "CANCELLED" });
    expect(auditTrail.data.history.at(-1)).toMatchObject({
      from_status: "WAITING",
      to_status: "CANCELLED",
      operation_id: cancelOperationId,
      metadata: { reason: "MANUAL_CANCEL", note: "受付内容の誤り" },
    });
    expect(auditTrail.data.history.at(-1)?.device_id).toMatch(/^ADMIN:/);
    const missingAuditTrail = await requestJson<{ error: string }>(`/api/admin/orders/${crypto.randomUUID()}/history`, { headers });
    expect(missingAuditTrail.response.status).toBe(404);
    expect(missingAuditTrail.data.error).toBe("ORDER_NOT_FOUND");

    const receptionCancellationEventId = await seedQueue(3);
    await registerDevice("RECEPTION-CANCEL-01", "RECEPTION");
    await registerDevice("KITCHEN-CANCEL-02", "KITCHEN");
    await registerDevice("DELIVERY-CANCEL-01", "DELIVERY");
    const receptionLookup = await requestJson<{ order: DetailedOrder }>(`/api/reception/orders/lookup?eventId=${receptionCancellationEventId}&ticketNumber=001`, {
      headers: deviceHeaders("RECEPTION-CANCEL-01"),
    });
    expect(receptionLookup.response.status).toBe(200);
    expect(receptionLookup.response.headers.get("cache-control")).toBe("no-store");
    expect(receptionLookup.data.order).toMatchObject({ ticket_number: "001", status: "WAITING" });
    expect(receptionLookup.data.order.items[0].options[0]).toMatchObject({ group_name: "味付け", option_name: "ソース", required: 1 });
    const receptionCancel = await requestJson<{ order: { status: string } }>(`/api/reception/orders/${receptionLookup.data.order.id}/cancel`, {
      method: "POST",
      headers: deviceHeaders("RECEPTION-CANCEL-01"),
      body: JSON.stringify({ operationId: crypto.randomUUID(), reason: "お客様からの申出" }),
    });
    expect(receptionCancel.response.status).toBe(200);
    expect(receptionCancel.data.order.status).toBe("CANCELLED");
    const receptionHistory = await env.DB.prepare(
      `SELECT from_status, device_id FROM order_status_history WHERE order_id = ?1 AND to_status = 'CANCELLED'`,
    ).bind(receptionLookup.data.order.id).first<{ from_status: string; device_id: string }>();
    expect(receptionHistory).toEqual({ from_status: "WAITING", device_id: "RECEPTION:RECEPTION-CANCEL-01" });

    const readyToCancel = await nextOrder(receptionCancellationEventId, "KITCHEN-CANCEL-02");
    await completeCooking(readyToCancel!);
    const readyCancel = await requestJson<{ order: { status: string } }>(`/api/reception/orders/${readyToCancel!.id}/cancel`, {
      method: "POST",
      headers: deviceHeaders("RECEPTION-CANCEL-01"),
      body: JSON.stringify({ operationId: crypto.randomUUID(), reason: "受け渡し前の取消" }),
    });
    expect(readyCancel.response.status).toBe(200);
    const readyCancelHistory = await env.DB.prepare(
      `SELECT from_status FROM order_status_history WHERE order_id = ?1 AND to_status = 'CANCELLED'`,
    ).bind(readyToCancel!.id).first<{ from_status: string }>();
    expect(readyCancelHistory?.from_status).toBe("READY");

    const completedToCancel = await nextOrder(receptionCancellationEventId, "KITCHEN-CANCEL-02");
    await completeCooking(completedToCancel!);
    const completed = await requestJson<{ order: { status: string } }>(`/api/orders/${completedToCancel!.id}/complete`, {
      method: "POST",
      headers: deviceHeaders("DELIVERY-CANCEL-01"),
      body: JSON.stringify({ deviceId: "DELIVERY-CANCEL-01", operationId: crypto.randomUUID() }),
    });
    expect(completed.response.status).toBe(200);
    const completedCancel = await requestJson<{ order: { status: string } }>(`/api/reception/orders/${completedToCancel!.id}/cancel`, {
      method: "POST",
      headers: deviceHeaders("RECEPTION-CANCEL-01"),
      body: JSON.stringify({ operationId: crypto.randomUUID(), reason: "提供後の記録訂正" }),
    });
    expect(completedCancel.response.status).toBe(200);
    const completedCancelHistory = await env.DB.prepare(
      `SELECT from_status FROM order_status_history WHERE order_id = ?1 AND to_status = 'CANCELLED'`,
    ).bind(completedToCancel!.id).first<{ from_status: string }>();
    expect(completedCancelHistory?.from_status).toBe("COMPLETED");

    await registerDevice("KITCHEN-CANCEL-01", "KITCHEN");
    const assignmentAfterCancellation = await nextOrder(cancellationEventId, "KITCHEN-CANCEL-01");
    expect(assignmentAfterCancellation?.ticket_number).toBe("002");
    const cancelCooking = await requestJson<{ error: string }>(`/api/admin/orders/${assignmentAfterCancellation!.id}/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: crypto.randomUUID(), reason: "調理中は直接取消不可" }),
    });
    expect(cancelCooking.response.status).toBe(409);
    expect(cancelCooking.data.error).toBe("COOKING_CANCEL_CONFIRMATION_REQUIRED");
    const wrongCookingConfirmation = await requestJson<{ error: string }>(`/api/admin/orders/${assignmentAfterCancellation!.id}/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: crypto.randomUUID(), reason: "注文内容の誤り", forceCooking: true, confirmedTicketNumber: "WRONG" }),
    });
    expect(wrongCookingConfirmation.response.status).toBe(409);
    expect(wrongCookingConfirmation.data.error).toBe("COOKING_CANCEL_CONFIRMATION_REQUIRED");
    const forceCancelOperationId = crypto.randomUUID();
    const forcedCookingCancellation = await requestJson<{ order: { status: string } }>(`/api/admin/orders/${assignmentAfterCancellation!.id}/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: forceCancelOperationId, reason: "注文内容の誤り", forceCooking: true, confirmedTicketNumber: assignmentAfterCancellation!.ticket_number }),
    });
    expect(forcedCookingCancellation.response.status).toBe(200);
    expect(forcedCookingCancellation.data.order.status).toBe("CANCELLED");
    const forceCancelHistory = await env.DB.prepare(
      `SELECT from_status, device_id, metadata_json FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2`,
    ).bind(assignmentAfterCancellation!.id, forceCancelOperationId).first<{ from_status: string; device_id: string; metadata_json: string }>();
    expect(forceCancelHistory?.from_status).toBe("COOKING");
    expect(forceCancelHistory?.device_id).toMatch(/^ADMIN:/);
    expect(JSON.parse(forceCancelHistory!.metadata_json)).toEqual({ reason: "ADMIN_FORCE_CANCEL", note: "注文内容の誤り" });
    const cancellationSummary = await requestJson<{
      summary: Record<string, number>;
      itemTotal: number;
      productCounts: Array<{ item_code: string; item_name: string; order_count: number; quantity: number; cancelled_quantity: number; total_quantity: number }>;
    }>(`/api/admin/summary?eventId=${cancellationEventId}`, { headers });
    expect(cancellationSummary.data.summary).toMatchObject({ CANCELLED: 2, COOKING: 0 });
    expect(cancellationSummary.data.itemTotal).toBe(0);
    expect(cancellationSummary.response.headers.get("cache-control")).toBe("no-store");
    expect(cancellationSummary.data.productCounts).toEqual([
      expect.objectContaining({ item_code: "FOOD", order_count: 0, quantity: 0, cancelled_quantity: 2, total_quantity: 2 }),
    ]);
    const lightweightSummary = await requestJson<{
      summary: Record<string, number>;
      total: number;
      itemTotal?: number;
      productCounts?: unknown[];
    }>(`/api/admin/summary?eventId=${cancellationEventId}&includeProducts=false`, { headers });
    expect(lightweightSummary.data.summary).toMatchObject({ CANCELLED: 2, COOKING: 0 });
    expect(lightweightSummary.data.total).toBe(2);
    expect(lightweightSummary.data).not.toHaveProperty("itemTotal");
    expect(lightweightSummary.data).not.toHaveProperty("productCounts");
    const receptionProductSummary = await requestJson<{ itemTotal: number; productCounts: Array<{ quantity: number }> }>(`/api/reception/product-summary?eventId=${cancellationEventId}`, {
      headers: deviceHeaders("RECEPTION-CANCEL-01"),
    });
    expect(receptionProductSummary.response.status).toBe(200);
    expect(receptionProductSummary.response.headers.get("cache-control")).toBe("no-store");
    expect(receptionProductSummary.data.itemTotal).toBe(0);
    expect(receptionProductSummary.data.productCounts).toEqual([]);
    const forbiddenProductSummary = await requestJson<{ error: string }>(`/api/reception/product-summary?eventId=${cancellationEventId}`, { headers: deviceHeaders("KITCHEN-CANCEL-01") });
    expect(forbiddenProductSummary.response.status).toBe(403);
    expect(forbiddenProductSummary.data.error).toBe("DEVICE_ROLE_FORBIDDEN");
    await env.DB.prepare(`UPDATE events SET status = 'CLOSED' WHERE id = ?1`).bind(cancellationEventId).run();
    const closedProductSummary = await requestJson<{ error: string }>(`/api/reception/product-summary?eventId=${cancellationEventId}`, { headers: deviceHeaders("RECEPTION-CANCEL-01") });
    expect(closedProductSummary.response.status).toBe(409);
    expect(closedProductSummary.data.error).toBe("EVENT_NOT_OPEN");
    const cancellationCsvResponse = await exports.default.fetch(new Request(`https://example.test/api/admin/export.csv?eventId=${cancellationEventId}`, { headers }));
    const cancellationCsv = await cancellationCsvResponse.text();
    expect(cancellationCsvResponse.status).toBe(200);
    expect(cancellationCsv).toContain("CANCELLED");

    const csvResponse = await exports.default.fetch(new Request(`https://example.test/api/admin/export.csv?eventId=${eventId}`, { headers }));
    const csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
    const csv = new TextDecoder().decode(csvBytes);
    expect(csvResponse.status).toBe(200);
    expect(Array.from(csvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.startsWith("ticket_number,status,items,")).toBe(true);
    expect(csv).toContain("焼きそば（味付け：ソース）×1");
    expect(csv).toContain("\r\n");
    const productCsvResponse = await exports.default.fetch(new Request(`https://example.test/api/admin/product-summary.csv?eventId=${eventId}`, { headers }));
    const productCsvBytes = new Uint8Array(await productCsvResponse.arrayBuffer());
    const productCsv = new TextDecoder().decode(productCsvBytes);
    expect(productCsvResponse.status).toBe(200);
    expect(Array.from(productCsvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(productCsv.startsWith("item_code,item_name,order_count,quantity,cancelled_quantity,total_quantity\r\n")).toBe(true);
    expect(productCsv).toContain('"FOOD","焼きそば"');
    expect(productCsv).not.toContain("味付け");

    const usedMenu = await requestJson<{ item: { id: string } }>("/api/admin/menu/items", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "履歴保持用" }),
    });
    const existingOrder = await env.DB.prepare(`SELECT id FROM orders WHERE event_id = ?1 LIMIT 1`).bind(eventId).first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO order_items (id, order_id, item_code, item_name, quantity, created_at)
       VALUES (?1, ?2, ?3, '履歴保持用', 1, ?4)`,
    ).bind(crypto.randomUUID(), existingOrder!.id, usedMenu.data.item.id, new Date().toISOString()).run();
    const softDeletedMenu = await requestJson<{ ok: boolean }>(`/api/admin/menu/items/${usedMenu.data.item.id}`, { method: "DELETE", headers });
    expect(softDeletedMenu.response.status).toBe(200);
    const retainedMenu = await requestJson<{ error: string }>(`/api/admin/menu/items/${usedMenu.data.item.id}`, { method: "DELETE", headers });
    expect(retainedMenu.response.status).toBe(409);
    expect(retainedMenu.data.error).toBe("MENU_ITEM_HAS_ORDERS");
    const disposableMenu = await requestJson<{ item: { id: string } }>("/api/admin/menu/items", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "削除確認用" }),
    });
    await requestJson(`/api/admin/menu/items/${disposableMenu.data.item.id}`, { method: "DELETE", headers });
    const purgedMenu = await requestJson<{ purged: boolean }>(`/api/admin/menu/items/${disposableMenu.data.item.id}`, { method: "DELETE", headers });
    expect(purgedMenu.response.status).toBe(200);
    expect(purgedMenu.data.purged).toBe(true);

    const disposableDevice = await requestJson<{ device: { id: string } }>("/api/admin/devices", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: "REMOVE-ME", role: "DISPLAY", displayName: "削除確認端末" }),
    });
    const removedDevice = await requestJson<{ ok: boolean }>(`/api/admin/devices/${disposableDevice.data.device.id}`, { method: "DELETE", headers });
    expect(removedDevice.response.status).toBe(200);

    const disposableEvent = await requestJson<{ event: { id: string } }>("/api/admin/events", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "削除確認営業日", businessDate: "2026-08-30" }),
    });
    const removedEvent = await requestJson<{ ok: boolean }>(`/api/admin/events/${disposableEvent.data.event.id}`, { method: "DELETE", headers });
    expect(removedEvent.response.status).toBe(200);
    await env.DB.prepare(`UPDATE order_number_settings SET online_next_number = 345, offline_next_number = 1234 WHERE id = 'default'`).run();
    const renamedOpenEvent = await requestJson<{ numbersReset: boolean }>(`/api/admin/events/${eventId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "名称変更後の営業日" }),
    });
    expect(renamedOpenEvent.response.status).toBe(200);
    expect(renamedOpenEvent.data.numbersReset).toBe(true);
    const resetNumbers = await env.DB.prepare(
      `SELECT online_start_number, online_next_number, offline_start_number, offline_next_number FROM order_number_settings WHERE id = 'default'`,
    ).first<{ online_start_number: number; online_next_number: number; offline_start_number: number; offline_next_number: number }>();
    expect(resetNumbers?.online_next_number).toBe(resetNumbers?.online_start_number);
    expect(resetNumbers?.offline_next_number).toBe(resetNumbers?.offline_start_number);
    const retainedEvent = await requestJson<{ error: string }>(`/api/admin/events/${eventId}`, { method: "DELETE", headers });
    expect(retainedEvent.response.status).toBe(409);
    expect(retainedEvent.data.error).toBe("EVENT_IS_OPEN");
    await requestJson(`/api/admin/events/${eventId}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ status: "CLOSED" }) });
    const closedRetainedEvent = await requestJson<{ error: string }>(`/api/admin/events/${eventId}`, { method: "DELETE", headers });
    expect(closedRetainedEvent.response.status).toBe(409);
    expect(closedRetainedEvent.data.error).toBe("EVENT_HAS_ORDERS");

    await env.DB.prepare(
      `UPDATE events SET online_next_number = 345, offline_next_number = 1234 WHERE id = ?1`,
    ).bind(eventId).run();
    await env.DB.prepare(
      `UPDATE order_number_settings SET online_next_number = online_start_number, offline_next_number = offline_start_number WHERE id = 'default'`,
    ).run();
    const reopenedEvent = await requestJson<{ numbersReset: boolean; numbersRestored: boolean }>(`/api/admin/events/${eventId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "OPEN" }),
    });
    expect(reopenedEvent.data).toMatchObject({ numbersReset: false, numbersRestored: true });
    const restoredNumbers = await env.DB.prepare(
      `SELECT online_next_number, offline_next_number FROM order_number_settings WHERE id = 'default'`,
    ).first<{ online_next_number: number; offline_next_number: number }>();
    expect(restoredNumbers).toEqual({ online_next_number: 345, offline_next_number: 1234 });

    await requestJson(`/api/admin/events/${eventId}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ status: "CLOSED" }) });
    await env.DB.prepare(`UPDATE events SET online_next_number = 501 WHERE id = ?1`).bind(eventId).run();
    const wrappedEvent = await requestJson<{ numbersReset: boolean; numbersRestored: boolean }>(`/api/admin/events/${eventId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "OPEN" }),
    });
    expect(wrappedEvent.data).toMatchObject({ numbersReset: true, numbersRestored: false });
    const wrappedNumber = await env.DB.prepare(
      `SELECT online_start_number, online_next_number FROM order_number_settings WHERE id = 'default'`,
    ).first<{ online_start_number: number; online_next_number: number }>();
    expect(wrappedNumber?.online_next_number).toBe(wrappedNumber?.online_start_number);
    await requestJson(`/api/admin/events/${eventId}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ status: "CLOSED" }) });

    const forcedEventId = await seedQueue(1);
    const forceDeletedEvent = await requestJson<{ ok: boolean; purged: boolean }>(`/api/admin/events/${forcedEventId}?force=true`, {
      method: "DELETE",
      headers: { ...headers, "X-Danger-Confirm": "DELETE-EVENT" },
    });
    expect(forceDeletedEvent.response.status).toBe(200);
    expect(forceDeletedEvent.data).toEqual({ ok: true, purged: true });
    const forcedEventOrders = await env.DB.prepare(`SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1`).bind(forcedEventId).first<{ count: number }>();
    expect(forcedEventOrders?.count).toBe(0);

    const logout = await exports.default.fetch(new Request("https://example.test/api/auth/logout", { method: "POST", headers }));
    expect(logout.status).toBe(200);
    const revokedSession = await exports.default.fetch(new Request(`https://example.test/api/admin/orders?eventId=${eventId}`, { headers }));
    expect(revokedSession.status).toBe(401);

    const invalidRecovery = await requestJson<{ error: string }>("/api/auth/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "recovered-admin", password: "recovered-password", recoveryToken: "wrong-token" }),
    });
    expect(invalidRecovery.response.status).toBe(403);
    expect(invalidRecovery.data.error).toBe("INVALID_RECOVERY_TOKEN");

    const recovered = await requestJson<{ ok: boolean }>("/api/auth/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "recovered-admin", password: "recovered-password", recoveryToken: "test-admin-recovery-token-32-characters" }),
    });
    expect(recovered.response.status).toBe(200);
    expect(recovered.data).toEqual({ ok: true });

    const oldCredentials = await requestJson<{ error: string }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.12" },
      body: JSON.stringify({ loginName: "integration-admin", password: "integration-password" }),
    });
    expect(oldCredentials.response.status).toBe(401);
    const recoveredLogin = await requestJson<{ token: string }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.12" },
      body: JSON.stringify({ loginName: "recovered-admin", password: "recovered-password" }),
    });
    expect(recoveredLogin.response.status).toBe(200);
    const retainedOrders = await requestJson<{ orders: DetailedOrder[] }>(`/api/admin/orders?eventId=${eventId}`, {
      headers: { Authorization: `Bearer ${recoveredLogin.data.token}` },
    });
    expect(retainedOrders.response.status).toBe(200);
    expect(retainedOrders.data.orders).not.toHaveLength(0);
  }, 15_000);

  it("enforces device credentials and roles on operational APIs", async () => {
    const eventId = await seedQueue(1);
    await registerDevice("RECEPTION-01", "RECEPTION");
    await registerDevice("KITCHEN-AUTH", "KITCHEN");
    await registerDevice("DELIVERY-AUTH", "DELIVERY");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO menu_items (id, name, sort_order, active, created_at, updated_at)
         VALUES ('MENU-FOOD', '正規の焼きそば', 0, 1, ?1, ?1)`,
      ).bind(new Date().toISOString()),
      env.DB.prepare(
        `INSERT INTO menu_option_groups (id, menu_item_id, name, selection_type, required, active)
         VALUES ('GROUP-FLAVOR', 'MENU-FOOD', '味付け', 'SINGLE', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO menu_options (id, group_id, name, sort_order, active)
         VALUES ('OPTION-SAUCE', 'GROUP-FLAVOR', 'ソース', 0, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO menu_options (id, group_id, name, sort_order, active)
         VALUES ('OPTION-SALT', 'GROUP-FLAVOR', '塩', 1, 1)`,
      ),
    ]);

    const orderPayload = {
      eventId,
      mode: "ONLINE",
      acceptedAt: "2020-01-01T00:00:00.000Z",
      requestId: crypto.randomUUID(),
      items: [{ itemCode: "MENU-FOOD", itemName: "クライアントが偽装した商品名", quantity: 1, options: [{ groupName: "味付け", optionName: "ソース" }] }],
    };
    const unauthorizedOrder = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-AUTH"),
      body: JSON.stringify(orderPayload),
    }));
    expect(unauthorizedOrder.status).toBe(403);
    const authorizedOrder = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify(orderPayload),
    }));
    expect(authorizedOrder.status).toBe(201);
    const createdOrder = await authorizedOrder.json<{ order: { id: string; ticket_number: string } }>();
    const savedTimes = await env.DB.prepare(
      `SELECT accepted_at, created_at FROM orders WHERE id = ?1`,
    ).bind(createdOrder.order.id).first<{ accepted_at: string; created_at: string }>();
    expect(savedTimes?.accepted_at).toBe(savedTimes?.created_at);
    expect(savedTimes?.accepted_at).not.toBe(orderPayload.acceptedAt);
    const savedItem = await env.DB.prepare(`SELECT item_name FROM order_items WHERE order_id = ?1`).bind(createdOrder.order.id).first<{ item_name: string }>();
    expect(savedItem?.item_name).toBe("正規の焼きそば");
    const savedOption = await env.DB.prepare(`SELECT required FROM order_item_options WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?1)`).bind(createdOrder.order.id).first<{ required: number }>();
    expect(savedOption?.required).toBe(1);
    const nextAfterCreate = await env.DB.prepare(`SELECT online_next_number FROM order_number_settings WHERE id = 'default'`).first<{ online_next_number: number }>();
    const replay = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify(orderPayload),
    }));
    expect(replay.status).toBe(200);
    expect(await replay.json<{ replayed: boolean; order: { ticket_number: string } }>()).toMatchObject({ replayed: true, order: { ticket_number: createdOrder.order.ticket_number } });
    const nextAfterReplay = await env.DB.prepare(`SELECT online_next_number FROM order_number_settings WHERE id = 'default'`).first<{ online_next_number: number }>();
    expect(nextAfterReplay?.online_next_number).toBe(nextAfterCreate?.online_next_number);

    const concurrentPayload = { ...orderPayload, requestId: crypto.randomUUID() };
    const nextBeforeConcurrentReplay = await env.DB.prepare(`SELECT online_next_number FROM order_number_settings WHERE id = 'default'`).first<{ online_next_number: number }>();
    const concurrentResponses = await Promise.all(Array.from({ length: 4 }, () => exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify(concurrentPayload),
    }))));
    expect(concurrentResponses.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
    const concurrentOrders = await Promise.all(concurrentResponses.map((response) => response.json<{ order: { id: string; ticket_number: string } }>()));
    expect(new Set(concurrentOrders.map(({ order }) => order.id)).size).toBe(1);
    expect(new Set(concurrentOrders.map(({ order }) => order.ticket_number)).size).toBe(1);
    const nextAfterConcurrentReplay = await env.DB.prepare(`SELECT online_next_number FROM order_number_settings WHERE id = 'default'`).first<{ online_next_number: number }>();
    expect(nextAfterConcurrentReplay?.online_next_number).toBe((nextBeforeConcurrentReplay?.online_next_number ?? 0) + 1);

    await env.DB.prepare(`UPDATE order_number_settings SET online_end_number = online_next_number - 1 WHERE id = 'default'`).run();
    const exhaustedOrder = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({ ...orderPayload, requestId: crypto.randomUUID() }),
    }));
    expect(exhaustedOrder.status).toBe(409);
    expect(await exhaustedOrder.json<{ error: string }>()).toEqual({ error: "ONLINE_NUMBER_EXHAUSTED" });
    const nextAfterExhaustion = await env.DB.prepare(`SELECT online_next_number FROM order_number_settings WHERE id = 'default'`).first<{ online_next_number: number }>();
    expect(nextAfterExhaustion?.online_next_number).toBe(nextAfterConcurrentReplay?.online_next_number);
    await env.DB.prepare(`UPDATE order_number_settings SET online_end_number = 500 WHERE id = 'default'`).run();

    const invalidSelection = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({ ...orderPayload, requestId: crypto.randomUUID(), items: [{ ...orderPayload.items[0], options: [{ groupName: "味付け", optionName: "存在しない味" }] }] }),
    }));
    expect(invalidSelection.status).toBe(400);
    expect(await invalidSelection.json<{ error: string }>()).toEqual({ error: "INVALID_MENU_SELECTION" });

    const missingRequiredSelection = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({ ...orderPayload, requestId: crypto.randomUUID(), items: [{ ...orderPayload.items[0], options: [] }] }),
    }));
    expect(missingRequiredSelection.status).toBe(400);
    expect(await missingRequiredSelection.json<{ error: string }>()).toEqual({ error: "INVALID_MENU_SELECTION" });

    const multipleSingleSelections = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({
        ...orderPayload,
        requestId: crypto.randomUUID(),
        items: [{
          ...orderPayload.items[0],
          options: [
            { groupName: "味付け", optionName: "ソース" },
            { groupName: "味付け", optionName: "塩" },
          ],
        }],
      }),
    }));
    expect(multipleSingleSelections.status).toBe(400);
    expect(await multipleSingleSelections.json<{ error: string }>()).toEqual({ error: "INVALID_MENU_SELECTION" });

    await env.DB.batch([
      env.DB.prepare(`UPDATE menu_items SET active = 0 WHERE id = 'MENU-FOOD'`),
      env.DB.prepare(`UPDATE menu_option_groups SET active = 0 WHERE id = 'GROUP-FLAVOR'`),
      env.DB.prepare(`UPDATE menu_options SET active = 0 WHERE id = 'OPTION-SAUCE'`),
    ]);
    const inactiveOnline = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({ ...orderPayload, requestId: crypto.randomUUID() }),
    }));
    expect(inactiveOnline.status).toBe(400);
    const queuedOffline = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({ ...orderPayload, mode: "OFFLINE", ticketNumber: "OFF-1001", requestId: crypto.randomUUID() }),
    }));
    expect(queuedOffline.status).toBe(201);
    const malformedOfflineNumber = await exports.default.fetch(new Request("https://example.test/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-01"),
      body: JSON.stringify({ ...orderPayload, mode: "OFFLINE", ticketNumber: "1001", requestId: crypto.randomUUID() }),
    }));
    expect(malformedOfflineNumber.status).toBe(400);
    expect(await malformedOfflineNumber.json<{ error: string }>()).toEqual({ error: "INVALID_TICKET_NUMBER" });

    const missing = await exports.default.fetch(new Request("https://example.test/api/kitchen/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-AUTH", operationId: crypto.randomUUID() }),
    }));
    expect(missing.status).toBe(401);
    expect(await missing.json<{ error: string }>()).toEqual({ error: "DEVICE_AUTH_REQUIRED" });

    const wrongKey = await exports.default.fetch(new Request("https://example.test/api/device/session", {
      headers: deviceHeaders("KITCHEN-AUTH", "wrong-key"),
    }));
    expect(wrongKey.status).toBe(401);

    const wrongRole = await exports.default.fetch(new Request("https://example.test/api/kitchen/next", {
      method: "POST",
      headers: deviceHeaders("DELIVERY-AUTH"),
      body: JSON.stringify({ eventId, deviceId: "DELIVERY-AUTH", operationId: crypto.randomUUID() }),
    }));
    expect(wrongRole.status).toBe(403);
    expect(await wrongRole.json<{ error: string }>()).toEqual({ error: "DEVICE_ROLE_FORBIDDEN" });

    const mismatchedId = await exports.default.fetch(new Request("https://example.test/api/kitchen/next", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-AUTH"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-OTHER", operationId: crypto.randomUUID() }),
    }));
    expect(mismatchedId.status).toBe(403);
    expect(await mismatchedId.json<{ error: string }>()).toEqual({ error: "DEVICE_MISMATCH" });

    const protectedDisplay = await exports.default.fetch(new Request(`https://example.test/api/display/ready?eventId=${eventId}`));
    expect(protectedDisplay.status).toBe(401);
  });

  it("undoes kitchen completion and safely requeues the automatically assigned next order", async () => {
    const eventId = await seedQueue(2);
    await registerDevice("KITCHEN-UNDO", "KITCHEN");
    const first = await nextOrder(eventId, "KITCHEN-UNDO");
    expect(first).not.toBeNull();
    const operationId = crypto.randomUUID();
    const completed = await requestJson<{ undoOperationId: string }>(`/api/orders/${first!.id}/ready`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-UNDO"),
      body: JSON.stringify({ deviceId: "KITCHEN-UNDO", operationId }),
    });
    expect(completed.response.status).toBe(200);
    const second = await nextOrder(eventId, "KITCHEN-UNDO");
    expect(second?.id).not.toBe(first!.id);

    const undone = await requestJson<{ undone: boolean }>(`/api/operations/${operationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-UNDO"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(undone.response.status).toBe(200);
    expect(undone.data.undone).toBe(true);
    const rows = await env.DB.prepare(
      `SELECT id, status, assigned_device_id FROM orders WHERE id IN (?1, ?2) ORDER BY id`,
    ).bind(first!.id, second!.id).all<{ id: string; status: string; assigned_device_id: string | null }>();
    expect(rows.results.find((row) => row.id === first!.id)).toMatchObject({ status: "COOKING", assigned_device_id: "KITCHEN-UNDO" });
    expect(rows.results.find((row) => row.id === second!.id)).toMatchObject({ status: "WAITING", assigned_device_id: null });
  });

  it("undoes reception order creation and cancellation from the originating terminal", async () => {
    const eventId = await seedQueue(0);
    await registerDevice("RECEPTION-UNDO", "RECEPTION");
    const now = new Date().toISOString();
    const menuId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO menu_items (id, name, sort_order, active, created_at, updated_at)
       VALUES (?1, 'たこ焼き', 0, 1, ?2, ?2)`,
    ).bind(menuId, now).run();
    const requestId = crypto.randomUUID();
    const created = await requestJson<{ order: { id: string; status: string }; undoOperationId: string }>("/api/orders", {
      method: "POST",
      headers: deviceHeaders("RECEPTION-UNDO"),
      body: JSON.stringify({
        eventId,
        mode: "ONLINE",
        acceptedAt: now,
        requestId,
        items: [{ itemCode: menuId, itemName: "たこ焼き", quantity: 1, options: [] }],
      }),
    });
    expect(created.response.status).toBe(201);
    const undoCreate = await requestJson<{ undone: boolean }>(`/api/operations/${requestId}/undo`, {
      method: "POST",
      headers: deviceHeaders("RECEPTION-UNDO"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(undoCreate.response.status).toBe(200);
    expect((await env.DB.prepare(`SELECT status FROM orders WHERE id = ?1`).bind(created.data.order.id).first<{ status: string }>())?.status).toBe("CANCELLED");

    const [waitingOrder] = (await env.DB.prepare(
      `SELECT id FROM orders WHERE event_id = ?1 AND status = 'WAITING' LIMIT 1`,
    ).bind(eventId).all<{ id: string }>()).results;
    if (!waitingOrder) {
      const seededId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO orders (id, event_id, ticket_number, status, accepted_at, created_at, updated_at, request_id)
         VALUES (?1, ?2, 'CANCEL-UNDO', 'WAITING', ?3, ?3, ?3, ?4)`,
      ).bind(seededId, eventId, now, crypto.randomUUID()).run();
    }
    const cancellable = await env.DB.prepare(`SELECT id FROM orders WHERE event_id = ?1 AND status = 'WAITING' LIMIT 1`).bind(eventId).first<{ id: string }>();
    const cancelOperationId = crypto.randomUUID();
    const cancelled = await requestJson<{ undoOperationId: string }>(`/api/reception/orders/${cancellable!.id}/cancel`, {
      method: "POST",
      headers: deviceHeaders("RECEPTION-UNDO"),
      body: JSON.stringify({ operationId: cancelOperationId, reason: "入力訂正" }),
    });
    expect(cancelled.response.status).toBe(200);
    const undoCancel = await requestJson<{ undone: boolean }>(`/api/operations/${cancelOperationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("RECEPTION-UNDO"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(undoCancel.response.status).toBe(200);
    expect((await env.DB.prepare(`SELECT status FROM orders WHERE id = ?1`).bind(cancellable!.id).first<{ status: string }>())?.status).toBe("WAITING");
  });

  it("undoes delivery completion and restores the order to the ready list", async () => {
    const eventId = await seedQueue(1);
    await registerDevice("KITCHEN-DELIVERY-UNDO", "KITCHEN");
    await registerDevice("DELIVERY-UNDO", "DELIVERY");
    const order = await nextOrder(eventId, "KITCHEN-DELIVERY-UNDO");
    await completeCooking(order!);
    const operationId = crypto.randomUUID();
    const completed = await requestJson<{ undoOperationId: string }>(`/api/orders/${order!.id}/complete`, {
      method: "POST",
      headers: deviceHeaders("DELIVERY-UNDO"),
      body: JSON.stringify({ deviceId: "DELIVERY-UNDO", operationId }),
    });
    expect(completed.response.status).toBe(200);
    const undone = await requestJson<{ undone: boolean }>(`/api/operations/${operationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("DELIVERY-UNDO"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(undone.response.status).toBe(200);
    expect((await env.DB.prepare(`SELECT status, completed_at FROM orders WHERE id = ?1`).bind(order!.id).first<{ status: string; completed_at: string | null }>())).toEqual({ status: "READY", completed_at: null });
  });

  it("undoes a kitchen presence change only from the same device within ten seconds", async () => {
    const eventId = await seedQueue(0);
    await registerDevice("KITCHEN-PRESENCE-UNDO", "KITCHEN");
    await registerDevice("KITCHEN-PRESENCE-OTHER", "KITCHEN");
    const operationId = crypto.randomUUID();
    const away = await requestJson<{ away: boolean; undoExpiresAt: string }>("/api/kitchen/presence", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-PRESENCE-UNDO"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-PRESENCE-UNDO", away: true, operationId }),
    });
    expect(away.response.status).toBe(200);
    expect(Date.parse(away.data.undoExpiresAt)).toBeGreaterThan(Date.now());
    const wrongActor = await requestJson<{ error: string }>(`/api/operations/${operationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-PRESENCE-OTHER"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(wrongActor.response.status).toBe(403);
    expect(wrongActor.data.error).toBe("UNDO_ACTOR_MISMATCH");

    const undone = await requestJson<{ undone: boolean }>(`/api/operations/${operationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-PRESENCE-UNDO"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(undone.response.status).toBe(200);
    expect((await env.DB.prepare(`SELECT kitchen_away FROM devices WHERE id = 'KITCHEN-PRESENCE-UNDO'`).first<{ kitchen_away: number }>())?.kitchen_away).toBe(0);

    const expiredOperationId = crypto.randomUUID();
    await requestJson("/api/kitchen/presence", {
      method: "POST",
      headers: deviceHeaders("KITCHEN-PRESENCE-OTHER"),
      body: JSON.stringify({ eventId, deviceId: "KITCHEN-PRESENCE-OTHER", away: true, operationId: expiredOperationId }),
    });
    await env.DB.prepare(`UPDATE undoable_operations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE operation_id = ?1`).bind(expiredOperationId).run();
    const expired = await requestJson<{ error: string }>(`/api/operations/${expiredOperationId}/undo`, {
      method: "POST",
      headers: deviceHeaders("KITCHEN-PRESENCE-OTHER"),
      body: JSON.stringify({ eventId, undoOperationId: crypto.randomUUID() }),
    });
    expect(expired.response.status).toBe(409);
    expect(expired.data.error).toBe("UNDO_EXPIRED");
  });
});
