import { OrderQueue } from "./queue/order-queue";
import type { OrderStatus } from "./domain/order";
import { getAdminSetupAvailability, loginAdmin, logoutAdmin, recoverAdmin, requireAdmin, setupAdmin } from "./auth";
import { generateDeviceKey, hashDeviceKey, requireDevice, type AuthenticatedDevice } from "./device-auth";
import { normalizeAcceptedAt } from "./domain/order-time";

export { OrderQueue };

const REQUIRED_SCHEMA_OBJECTS = [
  "events",
  "orders",
  "order_items",
  "order_items_order_id_idx",
  "order_item_options",
  "order_item_options_order_item_id_idx",
  "devices",
  "order_status_history",
  "order_status_history_order_created_idx",
  "undoable_operations",
  "undoable_operations_event_expires_idx",
  "orders_kitchen_assignment_idx",
  "orders_kitchen_fairness_idx",
  "queue_operations",
  "menu_items",
  "menu_option_groups",
  "menu_options",
  "admins",
  "admin_sessions",
  "order_number_settings",
  "app_settings",
  "admin_login_limits",
  "allocate_online_order_number",
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return checkReadiness(env.DB);
    }

    if ((url.pathname === "/api/current-business-day" || url.pathname === "/api/events/current") && (request.method === "GET" || request.method === "POST")) {
      const event = await env.DB.prepare(
        `SELECT id, name, business_date, status
         FROM events WHERE status = 'OPEN' ORDER BY business_date DESC LIMIT 1`,
      ).first();
      return Response.json({ event: event ?? null }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/admin/events") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "GET") return listEvents(env.DB);
      if (request.method === "POST") return createEvent(request, env.DB);
    }

    const eventAdminMatch = url.pathname.match(/^\/api\/admin\/events\/([^/]+)$/);
    if (eventAdminMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "PATCH") return updateEvent(eventAdminMatch[1], request, env.DB);
      const force = url.searchParams.get("force") === "true" && request.headers.get("X-Danger-Confirm") === "DELETE-EVENT";
      return deleteEvent(eventAdminMatch[1], env.DB, force);
    }

    if (url.pathname === "/api/menu" && request.method === "GET") {
      return getMenu(env.DB, true);
    }

    if (url.pathname === "/api/reception-settings" && request.method === "GET") {
      return getReceptionSettings(env.DB);
    }

    if (url.pathname === "/api/public/order-status" && request.method === "GET") {
      return getPublicOrderStatus(env.DB, url.searchParams.get("ticketNumber"));
    }

    if (url.pathname === "/api/auth/setup" && request.method === "POST") {
      const input = await readJson<{ loginName?: unknown; password?: unknown; setupToken?: unknown }>(request);
      if (
        !input ||
        typeof input.loginName !== "string" ||
        typeof input.password !== "string" ||
        typeof input.setupToken !== "string" ||
        input.loginName.trim().length === 0 ||
        input.password.length === 0 ||
        input.setupToken.length === 0 ||
        input.loginName.trim().length > 64 ||
        input.password.length > 256 ||
        input.setupToken.length > 512
      ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      const configuredSetupToken = (env as Env & { ADMIN_SETUP_TOKEN?: string }).ADMIN_SETUP_TOKEN;
      return setupAdmin(env.DB, input.loginName, input.password, input.setupToken, configuredSetupToken);
    }

    if (url.pathname === "/api/auth/setup-status" && request.method === "GET") {
      const configuredSetupToken = (env as Env & { ADMIN_SETUP_TOKEN?: string }).ADMIN_SETUP_TOKEN;
      return getAdminSetupAvailability(env.DB, configuredSetupToken);
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const input = await readJson<{ loginName?: unknown; password?: unknown }>(request);
      if (
        !input ||
        typeof input.loginName !== "string" ||
        typeof input.password !== "string" ||
        input.loginName.trim().length === 0 ||
        input.password.length === 0 ||
        input.loginName.trim().length > 64 ||
        input.password.length > 256
      ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      return loginAdmin(request, env.DB, input.loginName, input.password);
    }

    if (url.pathname === "/api/auth/recover" && request.method === "POST") {
      const input = await readJson<{ loginName?: unknown; password?: unknown; recoveryToken?: unknown }>(request);
      if (
        !input ||
        typeof input.loginName !== "string" ||
        typeof input.password !== "string" ||
        typeof input.recoveryToken !== "string" ||
        input.loginName.trim().length === 0 ||
        input.password.length === 0 ||
        input.recoveryToken.length === 0 ||
        input.loginName.trim().length > 64 ||
        input.password.length > 256 ||
        input.recoveryToken.length > 512
      ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      const configuredRecoveryToken = (env as Env & { ADMIN_RECOVERY_TOKEN?: string }).ADMIN_RECOVERY_TOKEN;
      return recoverAdmin(env.DB, input.loginName, input.password, input.recoveryToken, configuredRecoveryToken);
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return logoutAdmin(request, env.DB);
    }

    if (url.pathname === "/api/device/session" && request.method === "GET") {
      const device = await requireDevice(request, env.DB, ["RECEPTION", "KITCHEN", "DELIVERY", "DISPLAY", "ADMIN"]);
      if (device instanceof Response) return device;
      const settings = await env.DB.prepare(`SELECT reauth_grace_minutes FROM app_settings WHERE id = 'default'`).first<{ reauth_grace_minutes: number }>();
      const authenticatedAt = new Date();
      const reauthGraceMinutes = settings?.reauth_grace_minutes ?? 30;
      return Response.json({
        device,
        authenticatedAt: authenticatedAt.toISOString(),
        reauthGraceMinutes,
        reauthGraceExpiresAt: new Date(authenticatedAt.getTime() + reauthGraceMinutes * 60_000).toISOString(),
      });
    }

    if (url.pathname === "/api/admin/order-number-settings") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "GET") return getOrderNumberSettings(env.DB);
      if (request.method === "PATCH") return updateOrderNumberSettings(request, env.DB);
    }

    if (url.pathname === "/api/admin/settings/session") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "GET") return getSessionSettings(env.DB);
      if (request.method === "PATCH") return updateSessionSettings(request, env.DB);
    }

    if (url.pathname === "/api/admin/settings/reception") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "GET") return getReceptionSettings(env.DB);
      if (request.method === "PATCH") return updateReceptionSettings(request, env.DB);
    }

    if (url.pathname === "/api/admin/devices") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "GET") return listDevices(env.DB);
      if (request.method === "POST") return createDevice(request, env.DB);
    }

    const deviceAdminMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)$/);
    if (deviceAdminMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      if (request.method === "PATCH") return updateDevice(deviceAdminMatch[1], request, env.DB);
      return deleteDevice(deviceAdminMatch[1], env.DB);
    }

    if (url.pathname === "/api/admin/menu" && request.method === "GET") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return getMenu(env.DB, false);
    }

    if ((url.pathname === "/api/admin/orders" || url.pathname === "/api/admin/summary" || url.pathname === "/api/admin/export.csv" || url.pathname === "/api/admin/product-summary.csv") && request.method === "GET") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      const eventId = url.searchParams.get("eventId") || await getCurrentEventId(env.DB);
      if (!eventId) return Response.json({ error: "EVENT_ID_REQUIRED" }, { status: 400 });
      if (url.pathname === "/api/admin/orders") return listAdminOrders(env.DB, eventId, url.searchParams.get("status"));
      if (url.pathname === "/api/admin/summary") return summarizeOrders(env.DB, eventId, url.searchParams.get("includeProducts") !== "false");
      if (url.pathname === "/api/admin/product-summary.csv") return exportProductSummaryCsv(env.DB, eventId);
      return exportOrdersCsv(env.DB, eventId);
    }

    const requeueOrderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/requeue$/);
    if (requeueOrderMatch && request.method === "POST") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return requeueOrder(request, env, requeueOrderMatch[1], admin.admin_id);
    }

    const orderHistoryMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/history$/);
    if (orderHistoryMatch && request.method === "GET") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return getOrderHistory(env.DB, orderHistoryMatch[1]);
    }

    const cancelOrderMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/cancel$/);
    if (cancelOrderMatch && request.method === "POST") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return cancelOrder(request, env, cancelOrderMatch[1], admin.admin_id, "ADMIN");
    }

    const deliveryReworkMatch = url.pathname.match(/^\/api\/delivery\/orders\/([^/]+)\/rework$/);
    if (deliveryReworkMatch && request.method === "POST") {
      const device = await requireDevice(request, env.DB, ["DELIVERY"]);
      if (device instanceof Response) return device;
      return returnDeliveryOrderToKitchen(request, env, deliveryReworkMatch[1], device);
    }

    if (url.pathname === "/api/admin/menu/items" && request.method === "POST") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return createMenuItem(request, env.DB);
    }

    const menuItemMatch = url.pathname.match(/^\/api\/admin\/menu\/items\/([^/]+)$/);
    if (menuItemMatch && request.method === "PATCH") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return updateMenuItem(menuItemMatch[1], request, env.DB);
    }
    if (menuItemMatch && request.method === "DELETE") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return deleteMenuItem(menuItemMatch[1], env.DB);
    }

    const optionGroupMatch = url.pathname.match(/^\/api\/admin\/menu\/items\/([^/]+)\/option-groups$/);
    if (optionGroupMatch && request.method === "POST") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return createOptionGroup(optionGroupMatch[1], request, env.DB);
    }

    const optionGroupIdMatch = url.pathname.match(/^\/api\/admin\/menu\/option-groups\/([^/]+)$/);
    if (optionGroupIdMatch && request.method === "PATCH") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return updateOptionGroup(optionGroupIdMatch[1], request, env.DB);
    }

    const optionMatch = url.pathname.match(/^\/api\/admin\/menu\/option-groups\/([^/]+)\/options$/);
    if (optionMatch && request.method === "POST") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return createMenuOption(optionMatch[1], request, env.DB);
    }

    const optionGroupAdminMatch = url.pathname.match(/^\/api\/admin\/menu\/option-groups\/([^/]+)$/);
    if (optionGroupAdminMatch && request.method === "DELETE") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return deleteOptionGroup(optionGroupAdminMatch[1], env.DB);
    }

    const optionAdminMatch = url.pathname.match(/^\/api\/admin\/menu\/option-groups\/([^/]+)\/options\/([^/]+)$/);
    if (optionAdminMatch && request.method === "PATCH") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return updateMenuOption(optionAdminMatch[1], optionAdminMatch[2], request, env.DB);
    }
    if (optionAdminMatch && request.method === "DELETE") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return deleteMenuOption(optionAdminMatch[1], optionAdminMatch[2], env.DB);
    }

    if (url.pathname === "/api/orders" && request.method === "POST") {
      const device = await requireDevice(request, env.DB, ["RECEPTION"]);
      if (device instanceof Response) return device;
      return createOrder(request, env, device.id);
    }

    if (url.pathname === "/api/reception/orders/lookup" && request.method === "GET") {
      const device = await requireDevice(request, env.DB, ["RECEPTION"]);
      if (device instanceof Response) return device;
      return lookupReceptionOrder(env.DB, url.searchParams.get("eventId"), url.searchParams.get("ticketNumber"));
    }

    if (url.pathname === "/api/reception/product-summary" && request.method === "GET") {
      const device = await requireDevice(request, env.DB, ["RECEPTION"]);
      if (device instanceof Response) return device;
      const eventId = url.searchParams.get("eventId") || await getCurrentEventId(env.DB);
      if (!eventId) return Response.json({ error: "EVENT_ID_REQUIRED" }, { status: 400 });
      const event = await env.DB.prepare(`SELECT status FROM events WHERE id = ?1`).bind(eventId).first<{ status: string }>();
      if (!event) return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
      if (event.status !== "OPEN") return Response.json({ error: "EVENT_NOT_OPEN" }, { status: 409 });
      const productCounts = await getProductCounts(env.DB, eventId);
      const activeProductCounts = productCounts
        .filter((product) => product.quantity > 0)
        .map(({ item_code, item_name, order_count, quantity }) => ({ item_code, item_name, order_count, quantity }));
      return Response.json({
        productCounts: activeProductCounts,
        itemTotal: productCounts.reduce((sum, product) => sum + product.quantity, 0),
      }, { headers: { "cache-control": "no-store" } });
    }

    const receptionCancelMatch = url.pathname.match(/^\/api\/reception\/orders\/([^/]+)\/cancel$/);
    if (receptionCancelMatch && request.method === "POST") {
      const device = await requireDevice(request, env.DB, ["RECEPTION"]);
      if (device instanceof Response) return device;
      return cancelOrder(request, env, receptionCancelMatch[1], device.id, "RECEPTION");
    }

    if ((url.pathname === "/api/delivery/ready" || url.pathname === "/api/display/ready" || url.pathname === "/api/display/cooking") && request.method === "GET") {
      const eventId = url.searchParams.get("eventId");
      const status = url.pathname.endsWith("/cooking") ? "COOKING" : "READY";
      if (url.pathname === "/api/delivery/ready") {
        const device = await requireDevice(request, env.DB, ["DELIVERY"]);
        if (device instanceof Response) return device;
        return listDeliveryOrders(env.DB, eventId);
      }
      const device = await requireDevice(request, env.DB, ["DISPLAY"]);
      if (device instanceof Response) return device;
      return listOrdersByStatus(env.DB, eventId, status);
    }

    if (url.pathname === "/api/realtime" && request.method === "GET") {
      const eventId = url.searchParams.get("eventId");
      if (!eventId) return Response.json({ error: "EVENT_ID_REQUIRED" }, { status: 400 });
      const event = await env.DB.prepare(
        `SELECT status FROM events WHERE id = ?1`,
      ).bind(eventId).first<{ status: string }>();
      if (!event) return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
      if (event.status !== "OPEN") return Response.json({ error: "EVENT_NOT_OPEN" }, { status: 409 });
      const id = env.ORDER_QUEUE.idFromName(eventId);
      const stub = env.ORDER_QUEUE.get(id);
      return stub.fetch(new Request("https://order-queue/websocket", request));
    }

    if (url.pathname === "/api/kitchen/next" && request.method === "POST") {
      const device = await requireDevice(request, env.DB, ["KITCHEN"]);
      if (device instanceof Response) return device;
      let input: { eventId?: string; deviceId?: string; operationId?: string; knownOrderId?: string };
      try {
        input = (await request.json()) as typeof input;
      } catch {
        return Response.json({ error: "INVALID_JSON" }, { status: 400 });
      }

      if (!input.eventId || !input.deviceId || !input.operationId || (input.knownOrderId !== undefined && (typeof input.knownOrderId !== "string" || input.knownOrderId.length > 128))) {
        return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      if (input.deviceId !== device.id) return Response.json({ error: "DEVICE_MISMATCH" }, { status: 403 });
      await recordKitchenHeartbeat(env.DB, input.deviceId, input.eventId);

      const id = env.ORDER_QUEUE.idFromName(input.eventId);
      const stub = env.ORDER_QUEUE.get(id);
      return stub.fetch("https://order-queue/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: input.eventId,
          deviceId: input.deviceId,
          operationId: input.operationId,
          knownOrderId: input.knownOrderId,
        }),
      });
    }

    if (url.pathname === "/api/kitchen/state" && request.method === "GET") {
      const device = await requireDevice(request, env.DB, ["KITCHEN"]);
      if (device instanceof Response) return device;
      const eventId = url.searchParams.get("eventId");
      const deviceId = url.searchParams.get("deviceId");
      if (!eventId || !deviceId) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      if (deviceId !== device.id) return Response.json({ error: "DEVICE_MISMATCH" }, { status: 403 });
      await recordKitchenHeartbeat(env.DB, deviceId, eventId);
      return getKitchenState(env.DB, eventId, deviceId);
    }

    if (url.pathname === "/api/kitchen/presence" && request.method === "POST") {
      const device = await requireDevice(request, env.DB, ["KITCHEN"]);
      if (device instanceof Response) return device;
      const input = await readJson<{ eventId?: unknown; deviceId?: unknown; away?: unknown; operationId?: unknown; mode?: unknown; confirmedUnstarted?: unknown }>(request);
      if (
        !input || typeof input.eventId !== "string" || typeof input.deviceId !== "string" ||
        typeof input.away !== "boolean" || typeof input.operationId !== "string" ||
        !input.eventId || !input.operationId || input.operationId.length > 128 ||
        (input.mode !== undefined && input.mode !== "REQUEUE_UNSTARTED" && input.mode !== "FINISH_CURRENT") ||
        (input.confirmedUnstarted !== undefined && typeof input.confirmedUnstarted !== "boolean")
      ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
      if (input.deviceId !== device.id) return Response.json({ error: "DEVICE_MISMATCH" }, { status: 403 });
      await recordKitchenHeartbeat(env.DB, input.deviceId, input.eventId);
      const id = env.ORDER_QUEUE.idFromName(input.eventId);
      return env.ORDER_QUEUE.get(id).fetch("https://order-queue/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    }

    const stateMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/(ready|complete)$/);
    if (stateMatch && request.method === "POST") {
      const target = stateMatch[2] === "ready" ? "READY" : "COMPLETED";
      const device = await requireDevice(request, env.DB, [target === "READY" ? "KITCHEN" : "DELIVERY"]);
      if (device instanceof Response) return device;
      return transitionOrder(request, env, stateMatch[1], target, device);
    }

    const undoMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/undo$/);
    if (undoMatch && request.method === "POST") {
      const device = await requireDevice(request, env.DB, ["RECEPTION", "KITCHEN", "DELIVERY"]);
      if (device instanceof Response) return device;
      return undoOperation(request, env, undoMatch[1], device.role as "RECEPTION" | "KITCHEN" | "DELIVERY", device.id);
    }

    const adminUndoMatch = url.pathname.match(/^\/api\/admin\/operations\/([^/]+)\/undo$/);
    if (adminUndoMatch && request.method === "POST") {
      const admin = await requireAdmin(request, env.DB);
      if (admin instanceof Response) return admin;
      return undoOperation(request, env, adminUndoMatch[1], "ADMIN", admin.admin_id);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "API_NOT_FOUND" }, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};

async function checkReadiness(db: D1Database): Promise<Response> {
  try {
    const placeholders = REQUIRED_SCHEMA_OBJECTS.map((_, index) => `?${index + 1}`).join(", ");
    const [objects, settings, deviceColumns, eventColumns] = await Promise.all([
      db.prepare(
        `SELECT name FROM sqlite_master
         WHERE name IN (${placeholders}) AND type IN ('table', 'trigger', 'index')`,
      ).bind(...REQUIRED_SCHEMA_OBJECTS).all<{ name: string }>(),
      db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM app_settings WHERE id = 'default') AS app_settings_count,
           (SELECT COUNT(*) FROM order_number_settings WHERE id = 'default') AS number_settings_count`,
      ).first<{ app_settings_count: number; number_settings_count: number }>(),
      db.prepare(`PRAGMA table_info(devices)`).all<{ name: string }>(),
      db.prepare(`PRAGMA table_info(events)`).all<{ name: string }>(),
    ]);
    const found = new Set(objects.results.map(({ name }) => name));
    const missing = REQUIRED_SCHEMA_OBJECTS.filter((name) => !found.has(name));
    const settingsReady = settings?.app_settings_count === 1 && settings.number_settings_count === 1;
    const deviceColumnNames = new Set(deviceColumns.results.map(({ name }) => name));
    const kitchenPresenceReady = deviceColumnNames.has("kitchen_away") && deviceColumnNames.has("kitchen_away_updated_at");
    const kitchenFairnessReady = deviceColumnNames.has("kitchen_heartbeat_at") && deviceColumnNames.has("kitchen_heartbeat_event_id");
    const eventColumnNames = new Set(eventColumns.results.map(({ name }) => name));
    const eventNumbersReady = eventColumnNames.has("online_next_number") && eventColumnNames.has("offline_next_number");
    if (missing.length || !settingsReady || !kitchenPresenceReady || !kitchenFairnessReady || !eventNumbersReady) {
      return Response.json({ ok: false, error: "DATABASE_SCHEMA_NOT_READY" }, {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    return Response.json({ ok: true, service: "order-system", database: "ready", schemaVersion: 12 }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Readiness check failed", error);
    return Response.json({ ok: false, error: "DATABASE_UNAVAILABLE" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}

async function recordKitchenHeartbeat(db: D1Database, deviceId: string, eventId: string): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 8_000).toISOString();
  await db.prepare(
    `UPDATE devices
     SET kitchen_heartbeat_at = ?1, kitchen_heartbeat_event_id = ?2
     WHERE id = ?3 AND role = 'KITCHEN' AND active = 1
       AND (kitchen_heartbeat_at IS NULL OR kitchen_heartbeat_at < ?4
            OR kitchen_heartbeat_event_id IS NULL OR kitchen_heartbeat_event_id <> ?2)`,
  ).bind(now.toISOString(), eventId, deviceId, staleBefore).run();
}

async function createOrder(request: Request, env: Env, receptionDeviceId: string): Promise<Response> {
  type SubmittedItem = {
    itemCode?: string;
    itemName?: string;
    quantity?: number;
    note?: string;
    options?: Array<{ groupName?: string; optionName?: string }>;
  };
  let input: {
    eventId?: string;
    ticketNumber?: string;
    mode?: "ONLINE" | "OFFLINE";
    acceptedAt?: string;
    requestId?: string;
    items?: SubmittedItem[];
  };

  try {
    input = (await request.json()) as typeof input;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (
    !input.eventId ||
    !input.requestId ||
    input.requestId.length > 128 ||
    (input.mode !== "ONLINE" && input.mode !== "OFFLINE") ||
    !input.acceptedAt ||
    !Number.isFinite(Date.parse(input.acceptedAt)) ||
    !input.items?.length ||
    input.items.length > 100 ||
    input.items.some(
      (item) =>
        !item.itemCode ||
        item.itemCode.length > 128 ||
        item.quantity === undefined ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 999 ||
        (item.note?.length ?? 0) > 500 ||
        (item.options?.length ?? 0) > 20 ||
        item.options?.some((option) => !option.groupName || !option.optionName || option.groupName.length > 100 || option.optionName.length > 100),
    )
  ) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const existing = await env.DB.prepare(
    `SELECT id, ticket_number, status FROM orders WHERE event_id = ?1 AND request_id = ?2`,
  ).bind(input.eventId, input.requestId).first<{ id: string; ticket_number: string; status: string }>();
  if (existing) return Response.json({ order: existing, replayed: true });

  const event = await env.DB.prepare(
    `SELECT id FROM events WHERE id = ?1 AND status = 'OPEN'`,
  )
    .bind(input.eventId)
    .first();
  if (!event) {
    return Response.json({ error: "EVENT_NOT_OPEN" }, { status: 409 });
  }

  const normalizedItems = await normalizeOrderItems(env.DB, input.items, input.mode);
  if (!normalizedItems) return Response.json({ error: "INVALID_MENU_SELECTION" }, { status: 400 });
  if (input.mode === "OFFLINE" && !await isValidOfflineTicketNumber(env.DB, input.ticketNumber)) {
    return Response.json({ error: "INVALID_TICKET_NUMBER" }, { status: 400 });
  }

  let ticketNumber = input.ticketNumber;
  if (input.mode !== "OFFLINE") {
    ticketNumber = "__ONLINE__";
  }
  if (!ticketNumber) return Response.json({ error: "INVALID_TICKET_NUMBER" }, { status: 400 });
  if (ticketNumber.length > 64) return Response.json({ error: "INVALID_TICKET_NUMBER" }, { status: 400 });

  const orderId = crypto.randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const acceptedAt = normalizeAcceptedAt(input.mode, input.acceptedAt, nowMs);
  const undoExpiresAt = new Date(nowMs + 10_000).toISOString();
  const statements = [
    env.DB.prepare(
      `INSERT INTO orders
         (id, event_id, ticket_number, status, accepted_at, created_at, updated_at, request_id)
       VALUES (?1, ?2, ?3, 'WAITING', ?4, ?5, ?5, ?6)`,
    ).bind(orderId, input.eventId, ticketNumber, acceptedAt, now, input.requestId),
    env.DB.prepare(
      `INSERT INTO order_status_history
         (id, order_id, from_status, to_status, operation_id, created_at)
       VALUES (?1, ?2, NULL, 'WAITING', ?3, ?4)`,
    ).bind(crypto.randomUUID(), orderId, input.requestId, now),
    env.DB.prepare(
      `INSERT INTO undoable_operations
         (operation_id, event_id, order_id, actor_type, actor_id, action_type, payload_json, created_at, expires_at)
       VALUES (?1, ?2, ?3, 'RECEPTION', ?4, 'ORDER_CREATE', '{}', ?5, ?6)`,
    ).bind(input.requestId, input.eventId, orderId, receptionDeviceId, now, undoExpiresAt),
    ...normalizedItems.flatMap((item) => {
      const itemId = crypto.randomUUID();
      const itemStatements = [env.DB.prepare(
        `INSERT INTO order_items (id, order_id, item_code, item_name, quantity, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(itemId, orderId, item.itemCode, item.itemName, item.quantity, item.note ?? null, now)];
      for (const option of item.options || []) {
        if (option.groupName && option.optionName) itemStatements.push(env.DB.prepare(
          `INSERT INTO order_item_options (id, order_item_id, group_name, option_name, required, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(crypto.randomUUID(), itemId, option.groupName, option.optionName, option.required ? 1 : 0, now));
      }
      return itemStatements;
    }),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const replay = await env.DB.prepare(
      `SELECT id, ticket_number, status FROM orders WHERE event_id = ?1 AND request_id = ?2`,
    ).bind(input.eventId, input.requestId).first<{ id: string; ticket_number: string; status: string }>();
    if (replay) return Response.json({ order: replay, replayed: true });
    if (String(error).includes("ONLINE_NUMBER_EXHAUSTED")) {
      return Response.json({ error: "ONLINE_NUMBER_EXHAUSTED" }, { status: 409 });
    }
    throw error;
  }
  const createdOrder = await env.DB.prepare(
    `SELECT id, ticket_number, status FROM orders WHERE id = ?1`,
  ).bind(orderId).first<{ id: string; ticket_number: string; status: string }>();
  if (!createdOrder) throw new Error("ORDER_CREATE_FAILED");
  await notifyEvent(env, input.eventId, "order.created", orderId);
  return Response.json({ order: createdOrder, undoOperationId: input.requestId, undoExpiresAt }, { status: 201 });
}

async function isValidOfflineTicketNumber(db: D1Database, ticketNumber: string | undefined): Promise<boolean> {
  if (!ticketNumber || ticketNumber.length > 64) return false;
  const settings = await db.prepare(
    `SELECT offline_prefix, offline_start_number FROM order_number_settings WHERE id = 'default'`,
  ).first<{ offline_prefix: string; offline_start_number: number }>();
  if (!settings || !ticketNumber.startsWith(settings.offline_prefix)) return false;
  const suffix = ticketNumber.slice(settings.offline_prefix.length);
  if (!/^\d+$/.test(suffix)) return false;
  const number = Number(suffix);
  return Number.isSafeInteger(number) && number >= settings.offline_start_number;
}

type NormalizedOrderItem = {
  itemCode: string;
  itemName: string;
  quantity: number;
  note?: string;
  options: Array<{ groupName: string; optionName: string; required: boolean }>;
};

async function normalizeOrderItems(
  db: D1Database,
  items: Array<{ itemCode?: string; quantity?: number; note?: string; options?: Array<{ groupName?: string; optionName?: string }> }>,
  mode: "ONLINE" | "OFFLINE",
): Promise<NormalizedOrderItem[] | null> {
  const itemCodes = [...new Set(items.map((item) => item.itemCode!))];
  const placeholders = itemCodes.map((_, index) => `?${index + 1}`).join(", ");
  const [menuResult, groupResult, optionResult] = await Promise.all([
    db.prepare(`SELECT id, name, active FROM menu_items WHERE id IN (${placeholders})`).bind(...itemCodes).all<{ id: string; name: string; active: number }>(),
    db.prepare(
      `SELECT id, menu_item_id, name, selection_type, required, active
       FROM menu_option_groups WHERE menu_item_id IN (${placeholders})`,
    ).bind(...itemCodes).all<{ id: string; menu_item_id: string; name: string; selection_type: "SINGLE" | "MULTIPLE"; required: number; active: number }>(),
    db.prepare(
      `SELECT mog.id AS group_id, mog.menu_item_id, mog.name AS group_name, mog.required AS group_required, mog.active AS group_active,
              mo.name AS option_name, mo.active AS option_active
       FROM menu_option_groups mog
       JOIN menu_options mo ON mo.group_id = mog.id
       WHERE mog.menu_item_id IN (${placeholders})`,
    ).bind(...itemCodes).all<{ group_id: string; menu_item_id: string; group_name: string; group_required: number; group_active: number; option_name: string; option_active: number }>(),
  ]);
  const menuById = new Map(menuResult.results.map((item) => [item.id, item]));
  const groupsByItem = new Map<string, typeof groupResult.results>();
  for (const group of groupResult.results) {
    const groups = groupsByItem.get(group.menu_item_id) ?? [];
    groups.push(group);
    groupsByItem.set(group.menu_item_id, groups);
  }
  const optionByKey = new Map(optionResult.results.map((option) => [
    `${option.menu_item_id}\u0000${option.group_name}\u0000${option.option_name}`,
    option,
  ]));
  const normalized: NormalizedOrderItem[] = [];
  for (const item of items) {
    const menuItem = menuById.get(item.itemCode!);
    if (!menuItem || (mode === "ONLINE" && !menuItem.active)) return null;
    const options: NormalizedOrderItem["options"] = [];
    const selectedOptionKeys = new Set<string>();
    const selectionCountByGroup = new Map<string, number>();
    for (const option of item.options ?? []) {
      const key = `${menuItem.id}\u0000${option.groupName}\u0000${option.optionName}`;
      const menuOption = optionByKey.get(key);
      if (!menuOption || selectedOptionKeys.has(key) || (mode === "ONLINE" && (!menuOption.group_active || !menuOption.option_active))) return null;
      selectedOptionKeys.add(key);
      selectionCountByGroup.set(menuOption.group_id, (selectionCountByGroup.get(menuOption.group_id) ?? 0) + 1);
      options.push({ groupName: option.groupName!, optionName: option.optionName!, required: Boolean(menuOption.group_required) });
    }
    for (const group of groupsByItem.get(menuItem.id) ?? []) {
      if (mode === "ONLINE" && !group.active) continue;
      const selectionCount = selectionCountByGroup.get(group.id) ?? 0;
      if ((group.required && selectionCount === 0) || (group.selection_type === "SINGLE" && selectionCount > 1)) return null;
    }
    normalized.push({ itemCode: menuItem.id, itemName: menuItem.name, quantity: item.quantity!, note: item.note, options });
  }
  return normalized;
}

async function listOrdersByStatus(db: D1Database, eventId: string | null, status: "COOKING" | "READY"): Promise<Response> {
  if (!eventId) return Response.json({ error: "EVENT_ID_REQUIRED" }, { status: 400 });
  const orders = await db.prepare(
    `SELECT id, ticket_number, status, accepted_at, ready_at
     FROM orders WHERE event_id = ?1 AND status = ?2
     ORDER BY accepted_at ASC, id ASC`,
  ).bind(eventId, status).all();
  return Response.json({ orders: orders.results });
}

async function getKitchenState(db: D1Database, eventId: string, deviceId: string): Promise<Response> {
  const [device, order, waiting] = await Promise.all([
    db.prepare(`SELECT kitchen_away FROM devices WHERE id = ?1 AND role = 'KITCHEN' AND active = 1`).bind(deviceId).first<{ kitchen_away: number }>(),
    db.prepare(
      `SELECT id, ticket_number, status, accepted_at, ready_at
       FROM orders WHERE event_id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING'
       ORDER BY cooking_started_at ASC, id ASC LIMIT 1`,
    ).bind(eventId, deviceId).first<{ id: string; ticket_number: string; status: string; accepted_at: string; ready_at: string | null }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1 AND status = 'WAITING'`).bind(eventId).first<{ count: number }>(),
  ]);
  if (!device) return Response.json({ error: "INVALID_DEVICE_CREDENTIALS" }, { status: 401 });
  const assignments = order ? await attachOrderItems(db, [order]) : [];
  return Response.json({ away: Boolean(device.kitchen_away), assignment: assignments[0] ?? null, waitingCount: waiting?.count ?? 0 }, { headers: { "cache-control": "no-store" } });
}

async function getPublicOrderStatus(db: D1Database, ticketNumber: string | null): Promise<Response> {
  const normalizedTicketNumber = ticketNumber?.trim();
  if (!normalizedTicketNumber || normalizedTicketNumber.length > 64) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const eventId = await getCurrentEventId(db);
  if (!eventId) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404, headers: { "cache-control": "no-store" } });
  const order = await db.prepare(
    `SELECT id, event_id, ticket_number, status, accepted_at
     FROM orders
     WHERE event_id = ?1 AND ticket_number = ?2
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(eventId, normalizedTicketNumber).first<{ id: string; event_id: string; ticket_number: string; status: string; accepted_at: string }>();
  if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404, headers: { "cache-control": "no-store" } });

  let ordersAhead = 0;
  let itemsAhead = 0;
  if (order.status === "WAITING") {
    const ahead = await db.prepare(
      `SELECT COUNT(DISTINCT preceding.id) AS order_count,
              COALESCE(SUM(items.quantity), 0) AS item_count
       FROM orders preceding
       LEFT JOIN order_items items ON items.order_id = preceding.id
       WHERE preceding.event_id = ?1 AND preceding.status = 'WAITING'
         AND (preceding.accepted_at < ?2 OR (preceding.accepted_at = ?2 AND preceding.id < ?3))`,
    ).bind(order.event_id, order.accepted_at, order.id).first<{ order_count: number; item_count: number }>();
    ordersAhead = ahead?.order_count ?? 0;
    itemsAhead = ahead?.item_count ?? 0;
  }
  return Response.json({
    order: {
      ticketNumber: order.ticket_number,
      status: order.status,
      ordersAhead,
      itemsAhead,
    },
  }, { headers: { "cache-control": "no-store" } });
}

type OrderItemOption = {
  order_item_id: string;
  group_name: string;
  option_name: string;
  required: number;
};

type OrderItemDetail = {
  id: string;
  order_id: string;
  item_name: string;
  quantity: number;
  note: string | null;
  options: OrderItemOption[];
};

type AdminOrderRow = {
  id: string;
  ticket_number: string;
  status: string;
  accepted_at: string;
  created_at: string;
  cooking_started_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  assigned_device_id: string | null;
};

async function attachOrderItems<T extends { id: string }>(
  db: D1Database,
  orders: T[],
): Promise<Array<T & { items: OrderItemDetail[] }>> {
  if (orders.length === 0) return [];
  const chunks: string[][] = [];
  const orderIds = orders.map((order) => order.id);
  for (let index = 0; index < orderIds.length; index += 90) chunks.push(orderIds.slice(index, index + 90));
  const itemStatements = chunks.map((ids) => {
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
    return db.prepare(
      `SELECT id, order_id, item_name, quantity, note
       FROM order_items
       WHERE order_id IN (${placeholders})
       ORDER BY rowid ASC`,
    ).bind(...ids);
  });
  const optionStatements = chunks.map((ids) => {
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
    return db.prepare(
      `SELECT oio.order_item_id, oio.group_name, oio.option_name, oio.required
       FROM order_item_options oio
       JOIN order_items oi ON oi.id = oio.order_item_id
       WHERE oi.order_id IN (${placeholders})
       ORDER BY oio.rowid ASC`,
    ).bind(...ids);
  });
  const results = await db.batch([...itemStatements, ...optionStatements]);
  const items = results.slice(0, itemStatements.length).flatMap((result) => result.results as Array<Omit<OrderItemDetail, "options">>);
  const options = results.slice(itemStatements.length).flatMap((result) => result.results as OrderItemOption[]);
  const optionsByItem = new Map<string, OrderItemOption[]>();
  for (const option of options) {
    const options = optionsByItem.get(option.order_item_id) ?? [];
    options.push(option);
    optionsByItem.set(option.order_item_id, options);
  }
  const itemsByOrder = new Map<string, OrderItemDetail[]>();
  for (const item of items) {
    const items = itemsByOrder.get(item.order_id) ?? [];
    items.push({ ...item, options: optionsByItem.get(item.id) ?? [] });
    itemsByOrder.set(item.order_id, items);
  }
  return orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) ?? [] }));
}

async function listDeliveryOrders(db: D1Database, eventId: string | null): Promise<Response> {
  if (!eventId) return Response.json({ error: "EVENT_ID_REQUIRED" }, { status: 400 });
  const orders = await db.prepare(
    `SELECT id, ticket_number, status, accepted_at, ready_at
     FROM orders WHERE event_id = ?1 AND status = 'READY'
     ORDER BY ready_at ASC, id ASC`,
  ).bind(eventId).all<{ id: string; ticket_number: string; status: string; accepted_at: string; ready_at: string | null }>();
  return Response.json({ orders: await attachOrderItems(db, orders.results) });
}

async function getCurrentEventId(db: D1Database): Promise<string | null> {
  const event = await db.prepare(`SELECT id FROM events WHERE status = 'OPEN' ORDER BY business_date DESC LIMIT 1`).first<{ id: string }>();
  return event?.id ?? null;
}

async function listAdminOrders(db: D1Database, eventId: string, status: string | null): Promise<Response> {
  const orders = await db.prepare(
    `SELECT id, ticket_number, status, accepted_at, created_at, cooking_started_at,
            ready_at, completed_at, assigned_device_id
     FROM orders WHERE event_id = ?1 AND (?2 IS NULL OR status = ?2)
     ORDER BY accepted_at ASC, id ASC`,
  ).bind(eventId, status).all<AdminOrderRow>();
  return Response.json({ orders: await attachOrderItems(db, orders.results) });
}

async function lookupReceptionOrder(db: D1Database, eventId: string | null, ticketNumber: string | null): Promise<Response> {
  const normalizedTicketNumber = ticketNumber?.trim();
  if (!eventId || !normalizedTicketNumber || normalizedTicketNumber.length > 64) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const order = await db.prepare(
    `SELECT id, ticket_number, status, accepted_at, created_at, cooking_started_at,
            ready_at, completed_at, assigned_device_id
     FROM orders WHERE event_id = ?1 AND ticket_number = ?2
       AND EXISTS (SELECT 1 FROM events WHERE events.id = orders.event_id AND events.status = 'OPEN')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(eventId, normalizedTicketNumber).first<AdminOrderRow>();
  if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
  const [detailed] = await attachOrderItems(db, [order]);
  return Response.json({ order: detailed }, { headers: { "cache-control": "no-store" } });
}

type OrderHistoryRow = {
  id: string;
  from_status: string | null;
  to_status: string;
  device_id: string | null;
  operation_id: string;
  created_at: string;
  metadata_json: string | null;
};

async function getOrderHistory(db: D1Database, orderId: string): Promise<Response> {
  const order = await db.prepare(
    `SELECT id, ticket_number, status FROM orders WHERE id = ?1`,
  ).bind(orderId).first<{ id: string; ticket_number: string; status: string }>();
  if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });

  const result = await db.prepare(
    `SELECT id, from_status, to_status, device_id, operation_id, created_at, metadata_json
     FROM order_status_history
     WHERE order_id = ?1
     ORDER BY created_at ASC, rowid ASC`,
  ).bind(orderId).all<OrderHistoryRow>();
  const history = result.results.map(({ metadata_json, ...entry }) => ({
    ...entry,
    metadata: parseHistoryMetadata(metadata_json),
  }));
  return Response.json({ order, history }, { headers: { "cache-control": "no-store" } });
}

function parseHistoryMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function summarizeOrders(db: D1Database, eventId: string, includeProducts = true): Promise<Response> {
  const rowsQuery = db.prepare(`SELECT status, COUNT(*) AS count FROM orders WHERE event_id = ?1 GROUP BY status`).bind(eventId).all<{ status: string; count: number }>();
  const [rows, productCounts] = await Promise.all([
    rowsQuery,
    includeProducts ? getProductCounts(db, eventId) : Promise.resolve(null),
  ]);
  const summary: Record<string, number> = { WAITING: 0, COOKING: 0, READY: 0, COMPLETED: 0, CANCELLED: 0 };
  for (const row of rows.results) summary[row.status] = row.count;
  const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
  if (!productCounts) {
    return Response.json({ summary, total }, { headers: { "cache-control": "no-store" } });
  }
  return Response.json({
    summary,
    total,
    itemTotal: productCounts.reduce((sum, product) => sum + product.quantity, 0),
    productCounts,
  }, { headers: { "cache-control": "no-store" } });
}

type ProductCount = {
  item_code: string;
  item_name: string;
  order_count: number;
  quantity: number;
  cancelled_quantity: number;
  total_quantity: number;
};

async function getProductCounts(db: D1Database, eventId: string): Promise<ProductCount[]> {
  const result = await db.prepare(
    `SELECT order_items.item_code,
            order_items.item_name,
            COUNT(DISTINCT CASE WHEN orders.status <> 'CANCELLED' THEN orders.id END) AS order_count,
            COALESCE(SUM(CASE WHEN orders.status <> 'CANCELLED' THEN order_items.quantity ELSE 0 END), 0) AS quantity,
            COALESCE(SUM(CASE WHEN orders.status = 'CANCELLED' THEN order_items.quantity ELSE 0 END), 0) AS cancelled_quantity,
            COALESCE(SUM(order_items.quantity), 0) AS total_quantity
     FROM orders
     JOIN order_items ON order_items.order_id = orders.id
     WHERE orders.event_id = ?1
     GROUP BY order_items.item_code, order_items.item_name
     ORDER BY quantity DESC, order_items.item_name ASC, order_items.item_code ASC`,
  ).bind(eventId).all<ProductCount>();
  return result.results;
}

async function requeueOrder(request: Request, env: Env, orderId: string, adminId: string): Promise<Response> {
  const input = await readJson<{ operationId?: unknown }>(request);
  if (!input || typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 128) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const order = await env.DB.prepare(
    `SELECT event_id FROM orders WHERE id = ?1`,
  ).bind(orderId).first<{ event_id: string }>();
  if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
  const id = env.ORDER_QUEUE.idFromName(order.event_id);
  return env.ORDER_QUEUE.get(id).fetch("https://order-queue/requeue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: order.event_id, orderId, adminId, operationId: input.operationId }),
  });
}

async function cancelOrder(request: Request, env: Env, orderId: string, actorId: string, actorType: "ADMIN" | "RECEPTION"): Promise<Response> {
  const input = await readJson<{ operationId?: string; reason?: string; forceCooking?: boolean; confirmedTicketNumber?: string }>(request);
  const reason = input?.reason?.trim();
  if (!input?.operationId || input.operationId.length > 128 || !reason || reason.length > 200) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const order = await env.DB.prepare(
    `SELECT orders.event_id, events.status AS event_status
     FROM orders JOIN events ON events.id = orders.event_id WHERE orders.id = ?1`,
  ).bind(orderId).first<{ event_id: string; event_status: string }>();
  if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
  if (actorType === "RECEPTION" && order.event_status !== "OPEN") return Response.json({ error: "EVENT_NOT_OPEN" }, { status: 409 });

  const id = env.ORDER_QUEUE.idFromName(order.event_id);
  const stub = env.ORDER_QUEUE.get(id);
  return stub.fetch("https://order-queue/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: order.event_id,
      orderId,
      actorId,
      actorType,
      operationId: input.operationId,
      reason,
      forceCooking: actorType === "ADMIN" ? input.forceCooking : false,
      confirmedTicketNumber: actorType === "ADMIN" ? input.confirmedTicketNumber : undefined,
    }),
  });
}

async function returnDeliveryOrderToKitchen(request: Request, env: Env, orderId: string, device: AuthenticatedDevice): Promise<Response> {
  const input = await readJson<{ deviceId?: unknown; operationId?: unknown }>(request);
  if (
    !input || typeof input.deviceId !== "string" || typeof input.operationId !== "string" ||
    !input.deviceId || !input.operationId || input.operationId.length > 128
  ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  if (input.deviceId !== device.id) return Response.json({ error: "DEVICE_MISMATCH" }, { status: 403 });
  const order = await env.DB.prepare(`SELECT event_id FROM orders WHERE id = ?1`).bind(orderId).first<{ event_id: string }>();
  if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
  const id = env.ORDER_QUEUE.idFromName(order.event_id);
  return env.ORDER_QUEUE.get(id).fetch("https://order-queue/delivery-rework", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: order.event_id, orderId, deliveryDeviceId: device.id, operationId: input.operationId }),
  });
}

async function exportOrdersCsv(db: D1Database, eventId: string): Promise<Response> {
  const orders = await db.prepare(
    `SELECT id, ticket_number, status, accepted_at, created_at, cooking_started_at,
            ready_at, completed_at, assigned_device_id
     FROM orders WHERE event_id = ?1 ORDER BY accepted_at ASC, id ASC`,
  ).bind(eventId).all<{ id: string } & Record<string, string | null>>();
  const detailedOrders = await attachOrderItems(db, orders.results);
  const columns = ["ticket_number", "status", "items", "accepted_at", "created_at", "cooking_started_at", "ready_at", "completed_at", "assigned_device_id"];
  const escapeCsv = (value: string | null | undefined) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const formatItems = (items: OrderItemDetail[]) => items.map((item) => {
    const options = item.options.map((option) => `${option.group_name}：${option.option_name}`).join("、");
    const note = item.note ? `備考：${item.note}` : "";
    const details = [options, note].filter(Boolean).join("、");
    return `${item.item_name}${details ? `（${details}）` : ""}×${item.quantity}`;
  }).join(" / ");
  const csv = `\uFEFF${columns.join(",")}\r\n${detailedOrders.map((order) => columns.map((column) => escapeCsv(column === "items" ? formatItems(order.items) : order[column] as string | null)).join(",")).join("\r\n")}\r\n`;
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="orders-${eventId}.csv"` } });
}

async function exportProductSummaryCsv(db: D1Database, eventId: string): Promise<Response> {
  const productCounts = await getProductCounts(db, eventId);
  const columns: Array<{ heading: string; value: (product: ProductCount) => string | number }> = [
    { heading: "item_code", value: (product) => product.item_code },
    { heading: "item_name", value: (product) => product.item_name },
    { heading: "order_count", value: (product) => product.order_count },
    { heading: "quantity", value: (product) => product.quantity },
    { heading: "cancelled_quantity", value: (product) => product.cancelled_quantity },
    { heading: "total_quantity", value: (product) => product.total_quantity },
  ];
  const escapeCsv = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = `\uFEFF${columns.map((column) => column.heading).join(",")}\r\n${productCounts.map((product) => columns.map((column) => escapeCsv(column.value(product))).join(",")).join("\r\n")}\r\n`;
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="product-summary-${eventId}.csv"` } });
}

async function listEvents(db: D1Database): Promise<Response> {
  const events = await db.prepare(
    `SELECT events.id, events.name, events.business_date, events.status, events.created_at, events.updated_at,
            COUNT(orders.id) AS order_count
     FROM events LEFT JOIN orders ON orders.event_id = events.id
     GROUP BY events.id
     ORDER BY events.business_date DESC, events.created_at DESC`,
  ).all();
  return Response.json({ events: events.results });
}

async function createEvent(request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; businessDate?: string }>(request);
  if (!input?.name || !input.businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO events (id, name, business_date, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'DRAFT', ?4, ?4)`,
  ).bind(eventId, input.name.trim(), input.businessDate, now).run();
  return Response.json({ event: { id: eventId, name: input.name.trim(), business_date: input.businessDate, status: "DRAFT" } }, { status: 201 });
}

async function updateEvent(eventId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; businessDate?: string; status?: "DRAFT" | "OPEN" | "CLOSED" }>(request);
  if (!input || (input.name === undefined && input.businessDate === undefined && input.status === undefined)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (input.businessDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    return Response.json({ error: "INVALID_BUSINESS_DATE" }, { status: 400 });
  }
  if (input.status && !["DRAFT", "OPEN", "CLOSED"].includes(input.status)) {
    return Response.json({ error: "INVALID_STATUS" }, { status: 400 });
  }
  const current = await db.prepare(
    `SELECT id, name, business_date, status, online_next_number, offline_next_number
     FROM events WHERE id = ?1`,
  ).bind(eventId).first<{
    id: string;
    name: string;
    business_date: string;
    status: string;
    online_next_number: number | null;
    offline_next_number: number | null;
  }>();
  if (!current) return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
  const nextStatus = input.status ?? current.status;
  const nextName = input.name?.trim() || current.name;
  const nextBusinessDate = input.businessDate || current.business_date;
  const opening = nextStatus === "OPEN" && current.status !== "OPEN";
  const changedWhileOpen = current.status === "OPEN" && (nextName !== current.name || nextBusinessDate !== current.business_date);
  const firstOpening = opening && current.online_next_number === null;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (nextStatus === "OPEN") statements.push(db.prepare(`UPDATE events SET status = 'CLOSED', updated_at = ?1 WHERE status = 'OPEN' AND id <> ?2`).bind(now, eventId));
  let eventOnlineNext: number | null = null;
  let eventOfflineNext: number | null = null;
  let numbersReset = false;
  let numbersRestored = false;
  if (firstOpening || changedWhileOpen || opening) {
    const settings = await db.prepare(
      `SELECT online_start_number, online_end_number, offline_start_number
       FROM order_number_settings WHERE id = 'default'`,
    ).first<{ online_start_number: number; online_end_number: number; offline_start_number: number }>();
    if (!settings) throw new Error("ORDER_NUMBER_SETTINGS_NOT_FOUND");

    if (firstOpening || changedWhileOpen) {
      eventOnlineNext = settings.online_start_number;
      eventOfflineNext = settings.offline_start_number;
      numbersReset = true;
    } else {
      const savedOnlineNext = Math.max(current.online_next_number ?? settings.online_start_number, settings.online_start_number);
      eventOnlineNext = savedOnlineNext > settings.online_end_number ? settings.online_start_number : savedOnlineNext;
      eventOfflineNext = Math.max(current.offline_next_number ?? settings.offline_start_number, settings.offline_start_number);
      numbersReset = savedOnlineNext > settings.online_end_number;
      numbersRestored = !numbersReset;
    }
    statements.push(db.prepare(
      `UPDATE order_number_settings
       SET online_next_number = ?1, offline_next_number = ?2
       WHERE id = 'default'`,
    ).bind(eventOnlineNext, eventOfflineNext));
  }
  statements.push(db.prepare(
    `UPDATE events
     SET name = ?1, business_date = ?2, status = ?3, updated_at = ?4,
         online_next_number = COALESCE(?6, online_next_number),
         offline_next_number = COALESCE(?7, offline_next_number)
     WHERE id = ?5`,
  ).bind(nextName, nextBusinessDate, nextStatus, now, eventId, eventOnlineNext, eventOfflineNext));
  await db.batch(statements);
  return Response.json({ event: { id: eventId, name: nextName, business_date: nextBusinessDate, status: nextStatus }, numbersReset, numbersRestored });
}

async function deleteEvent(eventId: string, db: D1Database, force = false): Promise<Response> {
  const event = await db.prepare(`SELECT status FROM events WHERE id = ?1`).bind(eventId).first<{ status: string }>();
  if (!event) return Response.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
  if (force) {
    await db.batch([
      db.prepare(`DELETE FROM order_item_options WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?1))`).bind(eventId),
      db.prepare(`DELETE FROM undoable_operations WHERE event_id = ?1`).bind(eventId),
      db.prepare(`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?1)`).bind(eventId),
      db.prepare(`DELETE FROM queue_operations WHERE event_id = ?1`).bind(eventId),
      db.prepare(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?1)`).bind(eventId),
      db.prepare(`DELETE FROM orders WHERE event_id = ?1`).bind(eventId),
      db.prepare(`DELETE FROM events WHERE id = ?1`).bind(eventId),
    ]);
    return Response.json({ ok: true, purged: true });
  }
  if (event.status === "OPEN") return Response.json({ error: "EVENT_IS_OPEN" }, { status: 409 });
  const orderCount = await db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1`).bind(eventId).first<{ count: number }>();
  if ((orderCount?.count ?? 0) > 0) return Response.json({ error: "EVENT_HAS_ORDERS" }, { status: 409 });
  await db.batch([
    db.prepare(`DELETE FROM undoable_operations WHERE event_id = ?1`).bind(eventId),
    db.prepare(`DELETE FROM events WHERE id = ?1`).bind(eventId),
  ]);
  return Response.json({ ok: true });
}

async function getMenu(db: D1Database, activeOnly: boolean): Promise<Response> {
  const items = await db.prepare(
    `SELECT id, name, description, sort_order, active
     FROM menu_items ${activeOnly ? "WHERE active = 1" : ""}
     ORDER BY sort_order ASC, name ASC`,
  ).all();
  const groups = await db.prepare(
    `SELECT id, menu_item_id, name, selection_type, required, sort_order, active
     FROM menu_option_groups ${activeOnly ? "WHERE active = 1" : ""}
     ORDER BY sort_order ASC, name ASC`,
  ).all();
  const options = await db.prepare(
    `SELECT id, group_id, name, sort_order, active
     FROM menu_options ${activeOnly ? "WHERE active = 1" : ""}
     ORDER BY sort_order ASC, name ASC`,
  ).all();
  const result = items.results.map((item) => ({
    ...item,
    option_groups: groups.results.filter((group) => group.menu_item_id === item.id).map((group) => ({
      ...group,
      options: options.results.filter((option) => option.group_id === group.id),
    })),
  }));
  return Response.json({ items: result });
}

async function getReceptionSettings(db: D1Database): Promise<Response> {
  const settings = await db.prepare(`SELECT reception_menu_mode FROM app_settings WHERE id = 'default'`).first<{ reception_menu_mode: "DIRECT" | "CART" }>();
  return Response.json({ mode: settings?.reception_menu_mode ?? "DIRECT" });
}

async function updateReceptionSettings(request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ mode?: "DIRECT" | "CART" }>(request);
  if (!input?.mode || !["DIRECT", "CART"].includes(input.mode)) return Response.json({ error: "INVALID_MODE" }, { status: 400 });
  await db.prepare(`UPDATE app_settings SET reception_menu_mode = ?1 WHERE id = 'default'`).bind(input.mode).run();
  return Response.json({ mode: input.mode });
}

async function createMenuItem(request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; description?: string; sortOrder?: number }>(request);
  if (!input?.name?.trim()) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO menu_items (id, name, description, sort_order, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)`,
  ).bind(id, input.name.trim(), input.description?.trim() || null, input.sortOrder ?? 0, now).run();
  return Response.json({ item: { id, name: input.name.trim(), active: 1 } }, { status: 201 });
}

async function updateMenuItem(itemId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; description?: string; sortOrder?: number; active?: boolean }>(request);
  if (!input || (input.name === undefined && input.description === undefined && input.sortOrder === undefined && input.active === undefined)) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const current = await db.prepare(`SELECT name, description, sort_order, active FROM menu_items WHERE id = ?1`).bind(itemId).first<{ name: string; description: string | null; sort_order: number; active: number }>();
  if (!current) return Response.json({ error: "MENU_ITEM_NOT_FOUND" }, { status: 404 });
  await db.prepare(
    `UPDATE menu_items SET name = ?1, description = ?2, sort_order = ?3, active = ?4, updated_at = ?5 WHERE id = ?6`,
  ).bind(input.name?.trim() || current.name, input.description ?? current.description, input.sortOrder ?? current.sort_order, input.active === undefined ? current.active : (input.active ? 1 : 0), new Date().toISOString(), itemId).run();
  return Response.json({ ok: true });
}

async function deleteMenuItem(itemId: string, db: D1Database): Promise<Response> {
  const item = await db.prepare(`SELECT id, active FROM menu_items WHERE id = ?1`).bind(itemId).first<{ id: string; active: number }>();
  if (!item) return Response.json({ error: "MENU_ITEM_NOT_FOUND" }, { status: 404 });
  if (!item.active) {
    const orderCount = await db.prepare(`SELECT COUNT(*) AS count FROM order_items WHERE item_code = ?1`).bind(itemId).first<{ count: number }>();
    if ((orderCount?.count ?? 0) > 0) return Response.json({ error: "MENU_ITEM_HAS_ORDERS" }, { status: 409 });
    await db.batch([
      db.prepare(`DELETE FROM menu_options WHERE group_id IN (SELECT id FROM menu_option_groups WHERE menu_item_id = ?1)`).bind(itemId),
      db.prepare(`DELETE FROM menu_option_groups WHERE menu_item_id = ?1`).bind(itemId),
      db.prepare(`DELETE FROM menu_items WHERE id = ?1`).bind(itemId),
    ]);
    return Response.json({ ok: true, purged: true });
  }
  await db.batch([
    db.prepare(`UPDATE menu_items SET active = 0, updated_at = ?1 WHERE id = ?2`).bind(new Date().toISOString(), itemId),
    db.prepare(`UPDATE menu_option_groups SET active = 0 WHERE menu_item_id = ?1`).bind(itemId),
    db.prepare(`UPDATE menu_options SET active = 0 WHERE group_id IN (SELECT id FROM menu_option_groups WHERE menu_item_id = ?1)`).bind(itemId),
  ]);
  return Response.json({ ok: true });
}

async function createOptionGroup(itemId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; selectionType?: "SINGLE" | "MULTIPLE"; required?: boolean; sortOrder?: number }>(request);
  if (!input?.name?.trim() || !input.selectionType) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO menu_option_groups (id, menu_item_id, name, selection_type, required, sort_order, active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)`,
  ).bind(id, itemId, input.name.trim(), input.selectionType, input.required ? 1 : 0, input.sortOrder ?? 0).run();
  return Response.json({ group: { id, name: input.name.trim() } }, { status: 201 });
}

async function updateOptionGroup(groupId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; selectionType?: "SINGLE" | "MULTIPLE"; required?: boolean; sortOrder?: number; active?: boolean }>(request);
  if (!input || (input.name === undefined && input.selectionType === undefined && input.required === undefined && input.sortOrder === undefined && input.active === undefined)) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  if (input.selectionType !== undefined && !["SINGLE", "MULTIPLE"].includes(input.selectionType)) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const current = await db.prepare(`SELECT name, selection_type, required, sort_order, active FROM menu_option_groups WHERE id = ?1`).bind(groupId).first<{ name: string; selection_type: "SINGLE" | "MULTIPLE"; required: number; sort_order: number; active: number }>();
  if (!current) return Response.json({ error: "OPTION_GROUP_NOT_FOUND" }, { status: 404 });
  await db.prepare(
    `UPDATE menu_option_groups SET name = ?1, selection_type = ?2, required = ?3, sort_order = ?4, active = ?5 WHERE id = ?6`,
  ).bind(input.name?.trim() || current.name, input.selectionType || current.selection_type, input.required === undefined ? current.required : (input.required ? 1 : 0), input.sortOrder ?? current.sort_order, input.active === undefined ? current.active : (input.active ? 1 : 0), groupId).run();
  return Response.json({ ok: true });
}

async function createMenuOption(groupId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; sortOrder?: number }>(request);
  if (!input?.name?.trim()) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO menu_options (id, group_id, name, sort_order, active)
     VALUES (?1, ?2, ?3, ?4, 1)`,
  ).bind(id, groupId, input.name.trim(), input.sortOrder ?? 0).run();
  return Response.json({ option: { id, name: input.name.trim() } }, { status: 201 });
}

async function updateMenuOption(groupId: string, optionId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ name?: string; sortOrder?: number; active?: boolean }>(request);
  if (!input || (input.name === undefined && input.sortOrder === undefined && input.active === undefined)) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const current = await db.prepare(`SELECT name, sort_order, active FROM menu_options WHERE id = ?1 AND group_id = ?2`).bind(optionId, groupId).first<{ name: string; sort_order: number; active: number }>();
  if (!current) return Response.json({ error: "MENU_OPTION_NOT_FOUND" }, { status: 404 });
  await db.prepare(`UPDATE menu_options SET name = ?1, sort_order = ?2, active = ?3 WHERE id = ?4 AND group_id = ?5`).bind(input.name?.trim() || current.name, input.sortOrder ?? current.sort_order, input.active === undefined ? current.active : (input.active ? 1 : 0), optionId, groupId).run();
  return Response.json({ ok: true });
}

async function deleteOptionGroup(groupId: string, db: D1Database): Promise<Response> {
  const group = await db.prepare(`SELECT id FROM menu_option_groups WHERE id = ?1`).bind(groupId).first();
  if (!group) return Response.json({ error: "OPTION_GROUP_NOT_FOUND" }, { status: 404 });
  await db.batch([
    db.prepare(`UPDATE menu_option_groups SET active = 0 WHERE id = ?1`).bind(groupId),
    db.prepare(`UPDATE menu_options SET active = 0 WHERE group_id = ?1`).bind(groupId),
  ]);
  return Response.json({ ok: true });
}

async function deleteMenuOption(groupId: string, optionId: string, db: D1Database): Promise<Response> {
  const option = await db.prepare(`SELECT id FROM menu_options WHERE id = ?1 AND group_id = ?2`).bind(optionId, groupId).first();
  if (!option) return Response.json({ error: "MENU_OPTION_NOT_FOUND" }, { status: 404 });
  await db.prepare(`UPDATE menu_options SET active = 0 WHERE id = ?1 AND group_id = ?2`).bind(optionId, groupId).run();
  return Response.json({ ok: true });
}

async function getOrderNumberSettings(db: D1Database): Promise<Response> {
  const settings = await db.prepare(
    `SELECT online_start_number, online_end_number, online_next_number,
            offline_prefix, offline_start_number, offline_next_number
     FROM order_number_settings WHERE id = 'default'`,
  ).first();
  return Response.json({ settings });
}

async function updateOrderNumberSettings(request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{
    onlineStartNumber?: number;
    onlineEndNumber?: number;
    offlinePrefix?: string;
    offlineStartNumber?: number;
  }>(request);
  if (
    !input ||
    input.onlineStartNumber === undefined ||
    input.onlineEndNumber === undefined ||
    input.offlineStartNumber === undefined ||
    !Number.isInteger(input.onlineStartNumber) ||
    !Number.isInteger(input.onlineEndNumber) ||
    input.onlineStartNumber < 0 ||
    input.onlineEndNumber < input.onlineStartNumber ||
    !input.offlinePrefix ||
    input.offlinePrefix.length > 16 ||
    !Number.isInteger(input.offlineStartNumber) ||
    input.offlineStartNumber < 0
  ) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const onlineStartNumber = input.onlineStartNumber;
  const onlineEndNumber = input.onlineEndNumber;
  const offlineStartNumber = input.offlineStartNumber;

  const current = await db.prepare(
    `SELECT online_next_number, offline_next_number FROM order_number_settings WHERE id = 'default'`,
  ).first<{ online_next_number: number; offline_next_number: number }>();
  const onlineNext = Math.max(current?.online_next_number ?? onlineStartNumber, onlineStartNumber);
  const offlineNext = Math.max(current?.offline_next_number ?? offlineStartNumber, offlineStartNumber);
  await db.batch([
    db.prepare(
      `UPDATE order_number_settings
       SET online_start_number = ?1, online_end_number = ?2, online_next_number = ?3,
           offline_prefix = ?4, offline_start_number = ?5, offline_next_number = ?6
       WHERE id = 'default'`,
    ).bind(onlineStartNumber, onlineEndNumber, onlineNext, input.offlinePrefix, offlineStartNumber, offlineNext),
    db.prepare(
      `UPDATE events
       SET online_next_number = ?1, offline_next_number = ?2
       WHERE status = 'OPEN'`,
    ).bind(onlineNext, offlineNext),
  ]);
  return getOrderNumberSettings(db);
}

async function getSessionSettings(db: D1Database): Promise<Response> {
  const settings = await db.prepare(`SELECT session_duration_minutes, reauth_grace_minutes FROM app_settings WHERE id = 'default'`).first();
  return Response.json({ settings });
}

async function updateSessionSettings(request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ sessionDurationMinutes?: number; reauthGraceMinutes?: number }>(request);
  if (!input || input.sessionDurationMinutes === undefined || input.reauthGraceMinutes === undefined || !Number.isInteger(input.sessionDurationMinutes) || !Number.isInteger(input.reauthGraceMinutes) || input.sessionDurationMinutes < 1 || input.reauthGraceMinutes < 0) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const sessionDurationMinutes = input.sessionDurationMinutes;
  const reauthGraceMinutes = input.reauthGraceMinutes;
  await db.prepare(
    `UPDATE app_settings SET session_duration_minutes = ?1, reauth_grace_minutes = ?2 WHERE id = 'default'`,
  ).bind(sessionDurationMinutes, reauthGraceMinutes).run();
  return getSessionSettings(db);
}

async function listDevices(db: D1Database): Promise<Response> {
  const devices = await db.prepare(`SELECT id, role, display_name, active, last_seen_at, created_at, kitchen_away, kitchen_away_updated_at, device_key_hash IS NOT NULL AS key_configured FROM devices ORDER BY role ASC, id ASC`).all();
  return Response.json({ devices: devices.results });
}

const DEVICE_ROLES = ["RECEPTION", "KITCHEN", "DELIVERY", "DISPLAY", "ADMIN"] as const;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isDeviceRole(value: unknown): value is AuthenticatedDevice["role"] {
  return typeof value === "string" && DEVICE_ROLES.includes(value as AuthenticatedDevice["role"]);
}

function isValidDeviceDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;
}

async function createDevice(request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ id?: unknown; role?: unknown; displayName?: unknown }>(request);
  if (!input || typeof input.id !== "string" || !DEVICE_ID_PATTERN.test(input.id.trim()) || !isDeviceRole(input.role) || !isValidDeviceDisplayName(input.displayName)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const deviceId = input.id.trim();
  const displayName = input.displayName.trim();
  const now = new Date().toISOString();
  const deviceKey = generateDeviceKey();
  const deviceKeyHash = await hashDeviceKey(deviceKey);
  try {
    await db.prepare(`INSERT INTO devices (id, device_key_hash, role, display_name, active, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)`).bind(deviceId, deviceKeyHash, input.role, displayName, now).run();
  } catch {
    return Response.json({ error: "DEVICE_ALREADY_EXISTS" }, { status: 409 });
  }
  return Response.json({ device: { id: deviceId, role: input.role, display_name: displayName, active: 1 }, deviceKey }, { status: 201 });
}

async function updateDevice(deviceId: string, request: Request, db: D1Database): Promise<Response> {
  const input = await readJson<{ role?: unknown; displayName?: unknown; active?: unknown; rotateKey?: unknown }>(request);
  if (!input || (input.role === undefined && input.displayName === undefined && input.active === undefined && input.rotateKey !== true)) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  if (
    (input.role !== undefined && !isDeviceRole(input.role)) ||
    (input.displayName !== undefined && !isValidDeviceDisplayName(input.displayName)) ||
    (input.active !== undefined && typeof input.active !== "boolean") ||
    (input.rotateKey !== undefined && typeof input.rotateKey !== "boolean")
  ) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const current = await db.prepare(`SELECT role, display_name, active FROM devices WHERE id = ?1`).bind(deviceId).first<{ role: string; display_name: string; active: number }>();
  if (!current) return Response.json({ error: "DEVICE_NOT_FOUND" }, { status: 404 });
  await db.prepare(`UPDATE devices SET role = ?1, display_name = ?2, active = ?3 WHERE id = ?4`).bind(input.role || current.role, typeof input.displayName === "string" ? input.displayName.trim() : current.display_name, input.active === undefined ? current.active : (input.active ? 1 : 0), deviceId).run();
  if (!input.rotateKey) return Response.json({ ok: true });
  const deviceKey = generateDeviceKey();
  await db.prepare(`UPDATE devices SET device_key_hash = ?1 WHERE id = ?2`).bind(await hashDeviceKey(deviceKey), deviceId).run();
  return Response.json({ ok: true, deviceKey });
}

async function deleteDevice(deviceId: string, db: D1Database): Promise<Response> {
  const device = await db.prepare(`SELECT id FROM devices WHERE id = ?1`).bind(deviceId).first();
  if (!device) return Response.json({ error: "DEVICE_NOT_FOUND" }, { status: 404 });
  const activeAssignment = await db.prepare(
    `SELECT id FROM orders WHERE assigned_device_id = ?1 AND status = 'COOKING' LIMIT 1`,
  ).bind(deviceId).first();
  if (activeAssignment) return Response.json({ error: "DEVICE_HAS_ACTIVE_ASSIGNMENT" }, { status: 409 });
  await db.prepare(`DELETE FROM devices WHERE id = ?1`).bind(deviceId).run();
  return Response.json({ ok: true });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function transitionOrder(
  request: Request,
  env: Env,
  orderId: string,
  target: Extract<OrderStatus, "READY" | "COMPLETED">,
  authenticatedDevice: AuthenticatedDevice,
): Promise<Response> {
  let input: { deviceId?: unknown; operationId?: unknown } | null;
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (
    !input ||
    typeof input.deviceId !== "string" ||
    typeof input.operationId !== "string" ||
    !input.deviceId ||
    !input.operationId ||
    input.operationId.length > 128
  ) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (input.deviceId !== authenticatedDevice.id) return Response.json({ error: "DEVICE_MISMATCH" }, { status: 403 });

  const order = await env.DB.prepare(
    `SELECT event_id FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{ event_id: string }>();
  if (!order) {
    return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
  }

  const id = env.ORDER_QUEUE.idFromName(order.event_id);
  return env.ORDER_QUEUE.get(id).fetch("https://order-queue/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: order.event_id, orderId, deviceId: input.deviceId, operationId: input.operationId, target }),
  });
}

async function undoOperation(
  request: Request,
  env: Env,
  operationId: string,
  actorType: "RECEPTION" | "KITCHEN" | "DELIVERY" | "ADMIN",
  actorId: string,
): Promise<Response> {
  const input = await readJson<{ eventId?: unknown; undoOperationId?: unknown }>(request);
  if (
    !operationId || operationId.length > 128 || !input ||
    typeof input.eventId !== "string" || !input.eventId ||
    typeof input.undoOperationId !== "string" || !input.undoOperationId || input.undoOperationId.length > 128
  ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const id = env.ORDER_QUEUE.idFromName(input.eventId);
  return env.ORDER_QUEUE.get(id).fetch("https://order-queue/undo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: input.eventId,
      operationId,
      undoOperationId: input.undoOperationId,
      actorType,
      actorId,
    }),
  });
}

async function notifyEvent(env: Env, eventId: string, type: string, orderId: string): Promise<void> {
  const id = env.ORDER_QUEUE.idFromName(eventId);
  const stub = env.ORDER_QUEUE.get(id);
  await stub.notify({ type, eventId, orderId });
}
