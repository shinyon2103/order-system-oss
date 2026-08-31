import { DurableObject } from "cloudflare:workers";

type AssignRequest = {
  eventId: string;
  deviceId: string;
  operationId: string;
  knownOrderId?: string;
};

type CancelRequest = {
  eventId: string;
  orderId: string;
  actorId: string;
  actorType: "ADMIN" | "RECEPTION";
  operationId: string;
  reason: string;
  forceCooking?: boolean;
  confirmedTicketNumber?: string;
};

type TransitionRequest = {
  eventId: string;
  orderId: string;
  deviceId: string;
  operationId: string;
  target: "READY" | "COMPLETED";
};

type RequeueRequest = {
  eventId: string;
  orderId: string;
  adminId: string;
  operationId: string;
};

type DeliveryReworkRequest = {
  eventId: string;
  orderId: string;
  deliveryDeviceId: string;
  operationId: string;
};

type PresenceRequest = {
  eventId: string;
  deviceId: string;
  away: boolean;
  operationId: string;
  mode?: "REQUEUE_UNSTARTED" | "FINISH_CURRENT";
  confirmedUnstarted?: boolean;
};

type UndoRequest = {
  eventId: string;
  operationId: string;
  undoOperationId: string;
  actorType: "RECEPTION" | "KITCHEN" | "DELIVERY" | "ADMIN";
  actorId: string;
};

type UndoOperationRow = {
  event_id: string;
  order_id: string | null;
  actor_type: UndoRequest["actorType"];
  actor_id: string;
  action_type: string;
  payload_json: string;
  expires_at: string;
  undone_at: string | null;
  undo_operation_id: string | null;
};

const UNDO_WINDOW_MS = 10_000;

type OrderRow = {
  id: string;
  ticket_number: string;
  status: string;
  assigned_device_id: string | null;
  cooking_started_at?: string | null;
};

type OrderItemRow = {
  id: string;
  item_name: string;
  quantity: number;
  note: string | null;
};

type OrderOptionRow = {
  order_item_id: string;
  group_name: string;
  option_name: string;
  required: number;
};

export class OrderQueue extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/websocket") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "WEBSOCKET_UPGRADE_REQUIRED" }, { status: 426 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ connectedAt: new Date().toISOString() });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && pathname === "/cancel") {
      return this.cancelOrder(request);
    }

    if (request.method === "POST" && pathname === "/transition") {
      return this.transitionOrder(request);
    }

    if (request.method === "POST" && pathname === "/requeue") {
      return this.requeueOrder(request);
    }

    if (request.method === "POST" && pathname === "/delivery-rework") {
      return this.returnToKitchen(request);
    }

    if (request.method === "POST" && pathname === "/presence") {
      return this.updatePresence(request);
    }

    if (request.method === "POST" && pathname === "/undo") {
      return this.undoOperation(request);
    }

    if (request.method !== "POST" || pathname !== "/assign") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    let input: AssignRequest;
    try {
      input = (await request.json()) as AssignRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }

    if (!input.eventId || !input.deviceId || !input.operationId) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    return this.ctx.blockConcurrencyWhile(async () => {
      const kitchen = await this.env.DB.prepare(
        `SELECT kitchen_away FROM devices WHERE id = ?1 AND role = 'KITCHEN' AND active = 1`,
      ).bind(input.deviceId).first<{ kitchen_away: number }>();
      if (!kitchen) return Response.json({ error: "INVALID_DEVICE_CREDENTIALS" }, { status: 401 });

      const existing = await this.env.DB.prepare(
        `SELECT order_id, device_id FROM queue_operations WHERE operation_id = ?1`,
      )
        .bind(input.operationId)
        .first<{ order_id: string; device_id: string }>();

      if (existing) {
        if (existing.device_id !== input.deviceId) return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
        const order = await this.env.DB.prepare(
          `SELECT id, ticket_number, status, assigned_device_id
           FROM orders WHERE id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING'`,
        )
          .bind(existing.order_id, input.deviceId)
          .first<OrderRow>();
        return Response.json({ assignment: order ? await this.loadAssignment(order) : null, replayed: true, away: Boolean(kitchen.kitchen_away), waitingCount: await this.waitingCount(input.eventId) });
      }

      const assignedOrder = await this.env.DB.prepare(
        `SELECT id, ticket_number, status, assigned_device_id, cooking_started_at
         FROM orders
         WHERE event_id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING'
         ORDER BY cooking_started_at ASC, id ASC
         LIMIT 1`,
      )
        .bind(input.eventId, input.deviceId)
        .first<OrderRow>();

      if (assignedOrder) {
        const waiting = await this.env.DB.prepare(
          `SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1 AND status = 'WAITING'`,
        ).bind(input.eventId).first<{ count: number }>();
        if (input.knownOrderId === assignedOrder.id) {
          return Response.json({ assignment: null, assignmentUnchanged: true, assignmentId: assignedOrder.id, resumed: true, away: Boolean(kitchen.kitchen_away), waitingCount: waiting?.count ?? 0 });
        }
        return Response.json({ assignment: await this.loadAssignment(assignedOrder), resumed: true, away: Boolean(kitchen.kitchen_away), waitingCount: waiting?.count ?? 0 });
      }
      if (kitchen.kitchen_away) {
        const waiting = await this.waitingCount(input.eventId);
        return Response.json({ assignment: null, away: true, waitingCount: waiting });
      }

      const order = await this.env.DB.prepare(
        `SELECT id, ticket_number, status, assigned_device_id
         FROM orders
         WHERE event_id = ?1 AND status = 'WAITING'
         ORDER BY accepted_at ASC, id ASC
         LIMIT 1`,
      )
        .bind(input.eventId)
        .first<OrderRow>();

      if (!order) {
        return Response.json({ assignment: null, waitingCount: 0 });
      }

      const now = new Date().toISOString();
      const heartbeatCutoff = new Date(Date.now() - 15_000).toISOString();
      const nextKitchen = await this.env.DB.prepare(
        `SELECT d.id,
                (SELECT MAX(completed.ready_at)
                 FROM orders completed
                 WHERE completed.event_id = ?1
                   AND completed.assigned_device_id = d.id
                   AND completed.ready_at IS NOT NULL) AS last_completed_at
         FROM devices d
         WHERE d.role = 'KITCHEN'
           AND d.active = 1
           AND d.kitchen_away = 0
           AND d.kitchen_heartbeat_event_id = ?1
           AND d.kitchen_heartbeat_at >= ?2
           AND NOT EXISTS (
             SELECT 1 FROM orders active_order
             WHERE active_order.event_id = ?1
               AND active_order.assigned_device_id = d.id
               AND active_order.status = 'COOKING'
           )
         ORDER BY last_completed_at IS NOT NULL ASC, last_completed_at ASC, d.id ASC
         LIMIT 1`,
      ).bind(input.eventId, heartbeatCutoff).first<{ id: string; last_completed_at: string | null }>();

      if (!nextKitchen || nextKitchen.id !== input.deviceId) {
        return Response.json({ assignment: null, deferred: true, waitingCount: await this.waitingCount(input.eventId) });
      }

      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE orders
           SET status = 'COOKING', assigned_device_id = ?1,
               cooking_started_at = ?2, updated_at = ?2
           WHERE id = ?3 AND status = 'WAITING'`,
        ).bind(input.deviceId, now, order.id),
        this.env.DB.prepare(
          `INSERT INTO queue_operations (operation_id, event_id, order_id, device_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(input.operationId, input.eventId, order.id, input.deviceId, now),
        this.env.DB.prepare(
          `INSERT INTO order_status_history
             (id, order_id, from_status, to_status, device_id, operation_id, created_at)
           VALUES (?1, ?2, 'WAITING', 'COOKING', ?3, ?4, ?5)`,
        ).bind(crypto.randomUUID(), order.id, input.deviceId, input.operationId, now),
      ]);

      await this.notify({ type: "order.cooking", eventId: input.eventId, orderId: order.id });

      const waiting = await this.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1 AND status = 'WAITING'`,
      ).bind(input.eventId).first<{ count: number }>();

      return Response.json({
        assignment: await this.loadAssignment({
          ...order,
          status: "COOKING",
          assigned_device_id: input.deviceId,
        }),
        waitingCount: waiting?.count ?? 0,
      });
    });
  }

  private async updatePresence(request: Request): Promise<Response> {
    let input: PresenceRequest;
    try {
      input = (await request.json()) as PresenceRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }
    if (
      !input.eventId || !input.deviceId || typeof input.away !== "boolean" ||
      !input.operationId || input.operationId.length > 128 ||
      (input.mode !== undefined && !["REQUEUE_UNSTARTED", "FINISH_CURRENT"].includes(input.mode)) ||
      (input.confirmedUnstarted !== undefined && typeof input.confirmedUnstarted !== "boolean")
    ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });

    return this.ctx.blockConcurrencyWhile(async () => {
      const kitchen = await this.env.DB.prepare(
        `SELECT kitchen_away FROM devices WHERE id = ?1 AND role = 'KITCHEN' AND active = 1`,
      ).bind(input.deviceId).first<{ kitchen_away: number }>();
      if (!kitchen) return Response.json({ error: "INVALID_DEVICE_CREDENTIALS" }, { status: 401 });

      if (input.mode === "REQUEUE_UNSTARTED") {
        const existingOperation = await this.env.DB.prepare(
          `SELECT order_id, to_status, device_id, metadata_json
           FROM order_status_history WHERE operation_id = ?1 ORDER BY rowid DESC LIMIT 1`,
        ).bind(input.operationId).first<{ order_id: string; to_status: string; device_id: string | null; metadata_json: string | null }>();
        if (existingOperation) {
          let reason = "";
          try { reason = JSON.parse(existingOperation.metadata_json ?? "{}").reason ?? ""; } catch { reason = ""; }
          if (existingOperation.to_status !== "WAITING" || existingOperation.device_id !== input.deviceId || reason !== "KITCHEN_AWAY_BEFORE_START") {
            return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
          }
          return Response.json({ away: true, assignment: null, requeuedOrderId: existingOperation.order_id, replayed: true, waitingCount: await this.waitingCount(input.eventId) });
        }
      }

      const assignedOrder = await this.env.DB.prepare(
        `SELECT id, ticket_number, status, assigned_device_id, cooking_started_at
         FROM orders
         WHERE event_id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING'
         ORDER BY cooking_started_at ASC, id ASC LIMIT 1`,
      ).bind(input.eventId, input.deviceId).first<OrderRow>();
      const now = new Date().toISOString();

      if (!input.away) {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE devices SET kitchen_away = 0, kitchen_away_updated_at = ?1 WHERE id = ?2`,
          ).bind(now, input.deviceId),
          this.undoRecord(input.operationId, input.eventId, null, "KITCHEN", input.deviceId, "KITCHEN_PRESENCE", {
            previousAway: Boolean(kitchen.kitchen_away), appliedAway: false, appliedAt: now,
          }, now),
        ]);
        return Response.json({ away: false, assignment: assignedOrder ? await this.loadAssignment(assignedOrder) : null, waitingCount: await this.waitingCount(input.eventId), undoOperationId: input.operationId, undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString() });
      }

      if (assignedOrder && input.mode === "REQUEUE_UNSTARTED") {
        if (input.confirmedUnstarted !== true) return Response.json({ error: "KITCHEN_UNSTARTED_CONFIRMATION_REQUIRED" }, { status: 409 });
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE orders SET status = 'WAITING', assigned_device_id = NULL,
               cooking_started_at = NULL, updated_at = ?1
             WHERE id = ?2 AND event_id = ?3 AND assigned_device_id = ?4 AND status = 'COOKING'`,
          ).bind(now, assignedOrder.id, input.eventId, input.deviceId),
          this.env.DB.prepare(
            `INSERT INTO order_status_history
               (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
             SELECT ?1, ?2, 'COOKING', 'WAITING', ?3, ?4, ?5, ?6 WHERE changes() = 1`,
          ).bind(crypto.randomUUID(), assignedOrder.id, input.deviceId, input.operationId, now, JSON.stringify({ reason: "KITCHEN_AWAY_BEFORE_START" })),
          this.env.DB.prepare(
            `UPDATE devices SET kitchen_away = 1, kitchen_away_updated_at = ?1 WHERE id = ?2 AND changes() = 1`,
          ).bind(now, input.deviceId),
          this.undoRecord(input.operationId, input.eventId, assignedOrder.id, "KITCHEN", input.deviceId, "KITCHEN_PRESENCE_REQUEUE", {
            previousAway: Boolean(kitchen.kitchen_away), assignedDeviceId: input.deviceId,
            cookingStartedAt: assignedOrder.cooking_started_at ?? null,
            appliedAt: now,
          }, now),
        ]);
        const recorded = await this.env.DB.prepare(
          `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2`,
        ).bind(assignedOrder.id, input.operationId).first<{ to_status: string; device_id: string | null }>();
        if (recorded?.to_status !== "WAITING" || recorded.device_id !== input.deviceId) {
          return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
        }
        await this.notify({ type: "order.requeued", eventId: input.eventId, orderId: assignedOrder.id });
        return Response.json({ away: true, assignment: null, requeuedOrderId: assignedOrder.id, waitingCount: await this.waitingCount(input.eventId), undoOperationId: input.operationId, undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString() });
      }

      if (assignedOrder && input.mode !== "FINISH_CURRENT") {
        return Response.json({ error: "KITCHEN_AWAY_MODE_REQUIRED" }, { status: 409 });
      }

      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE devices SET kitchen_away = 1, kitchen_away_updated_at = ?1 WHERE id = ?2`,
        ).bind(now, input.deviceId),
        this.undoRecord(input.operationId, input.eventId, null, "KITCHEN", input.deviceId, "KITCHEN_PRESENCE", {
          previousAway: Boolean(kitchen.kitchen_away), appliedAway: true, appliedAt: now,
        }, now),
      ]);
      return Response.json({ away: true, assignment: assignedOrder ? await this.loadAssignment(assignedOrder) : null, waitingCount: await this.waitingCount(input.eventId), undoOperationId: input.operationId, undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString() });
    });
  }

  private undoRecord(
    operationId: string,
    eventId: string,
    orderId: string | null,
    actorType: UndoRequest["actorType"],
    actorId: string,
    actionType: string,
    payload: Record<string, unknown>,
    now: string,
  ): D1PreparedStatement {
    const expiresAt = new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString();
    return this.env.DB.prepare(
      `INSERT INTO undoable_operations
         (operation_id, event_id, order_id, actor_type, actor_id, action_type, payload_json, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(operationId, eventId, orderId, actorType, actorId, actionType, JSON.stringify(payload), now, expiresAt);
  }

  private async undoOperation(request: Request): Promise<Response> {
    let input: UndoRequest;
    try {
      input = (await request.json()) as UndoRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }
    if (
      !input.eventId || !input.operationId || !input.undoOperationId || !input.actorId ||
      input.operationId.length > 128 || input.undoOperationId.length > 128 ||
      !["RECEPTION", "KITCHEN", "DELIVERY", "ADMIN"].includes(input.actorType)
    ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });

    return this.ctx.blockConcurrencyWhile(async () => {
      const operation = await this.env.DB.prepare(
        `SELECT event_id, order_id, actor_type, actor_id, action_type, payload_json,
                expires_at, undone_at, undo_operation_id
         FROM undoable_operations WHERE operation_id = ?1`,
      ).bind(input.operationId).first<UndoOperationRow>();
      if (!operation) return Response.json({ error: "UNDO_NOT_AVAILABLE" }, { status: 404 });
      if (
        operation.event_id !== input.eventId || operation.actor_type !== input.actorType ||
        operation.actor_id !== input.actorId
      ) return Response.json({ error: "UNDO_ACTOR_MISMATCH" }, { status: 403 });
      if (operation.undone_at) {
        if (operation.undo_operation_id === input.undoOperationId) return Response.json({ undone: true, replayed: true });
        return Response.json({ error: "UNDO_ALREADY_USED" }, { status: 409 });
      }
      if (Date.now() > Date.parse(operation.expires_at)) return Response.json({ error: "UNDO_EXPIRED" }, { status: 409 });

      let payload: Record<string, unknown>;
      try { payload = JSON.parse(operation.payload_json) as Record<string, unknown>; }
      catch { return Response.json({ error: "UNDO_NOT_AVAILABLE" }, { status: 409 }); }
      const now = new Date().toISOString();
      const actor = `UNDO:${input.actorType}:${input.actorId}`;
      const statements: D1PreparedStatement[] = [];

      if (operation.action_type === "KITCHEN_PRESENCE") {
        const appliedAway = payload.appliedAway === true;
        const previousAway = payload.previousAway === true;
        const appliedAt = String(payload.appliedAt ?? "");
        const device = await this.env.DB.prepare(
          `SELECT kitchen_away, kitchen_away_updated_at FROM devices WHERE id = ?1 AND role = 'KITCHEN' AND active = 1`,
        ).bind(input.actorId).first<{ kitchen_away: number; kitchen_away_updated_at: string | null }>();
        if (!device || Boolean(device.kitchen_away) !== appliedAway || device.kitchen_away_updated_at !== appliedAt) {
          return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
        }
        statements.push(this.env.DB.prepare(
          `UPDATE devices SET kitchen_away = ?1, kitchen_away_updated_at = ?2 WHERE id = ?3`,
        ).bind(previousAway ? 1 : 0, now, input.actorId));
      } else {
        if (!operation.order_id) return Response.json({ error: "UNDO_NOT_AVAILABLE" }, { status: 409 });
        const order = await this.env.DB.prepare(
          `SELECT id, event_id, status, assigned_device_id, cooking_started_at, ready_at, completed_at
           FROM orders WHERE id = ?1`,
        ).bind(operation.order_id).first<{
          id: string; event_id: string; status: string; assigned_device_id: string | null;
          cooking_started_at: string | null; ready_at: string | null; completed_at: string | null;
        }>();
        if (!order || order.event_id !== input.eventId) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
        const latest = await this.env.DB.prepare(
          `SELECT operation_id FROM order_status_history WHERE order_id = ?1 ORDER BY rowid DESC LIMIT 1`,
        ).bind(order.id).first<{ operation_id: string }>();
        if (latest?.operation_id !== input.operationId) return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });

        const restoreCooking = async (expectedStatus: string, fromStatus: string): Promise<Response | null> => {
          if (order.status !== expectedStatus) return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
          const kitchenDeviceId = String(payload.assignedDeviceId ?? "");
          if (!kitchenDeviceId) return Response.json({ error: "UNDO_NOT_AVAILABLE" }, { status: 409 });
          const displaced = await this.env.DB.prepare(
            `SELECT id, cooking_started_at FROM orders
             WHERE event_id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING' AND id <> ?3
             ORDER BY cooking_started_at ASC, id ASC LIMIT 1`,
          ).bind(input.eventId, kitchenDeviceId, order.id).first<{ id: string; cooking_started_at: string | null }>();
          if (displaced) {
            statements.push(
              this.env.DB.prepare(
                `UPDATE orders SET status = 'WAITING', assigned_device_id = NULL, cooking_started_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'COOKING'`,
              ).bind(now, displaced.id),
              this.env.DB.prepare(
                `INSERT INTO order_status_history
                   (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
                 VALUES (?1, ?2, 'COOKING', 'WAITING', ?3, ?4, ?5, ?6)`,
              ).bind(crypto.randomUUID(), displaced.id, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO_DISPLACED", restoredOrderId: order.id })),
            );
          }
          statements.push(
            this.env.DB.prepare(
              `UPDATE orders SET status = 'COOKING', assigned_device_id = ?1, cooking_started_at = ?2,
                 ready_at = NULL, completed_at = NULL, updated_at = ?3 WHERE id = ?4 AND status = ?5`,
            ).bind(kitchenDeviceId, payload.cookingStartedAt ?? now, now, order.id, expectedStatus),
            this.env.DB.prepare(
              `INSERT INTO order_status_history
                 (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
               VALUES (?1, ?2, ?3, 'COOKING', ?4, ?5, ?6, ?7)`,
            ).bind(crypto.randomUUID(), order.id, fromStatus, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO", originalOperationId: input.operationId })),
          );
          return null;
        };

        if (operation.action_type === "ORDER_CREATE") {
          if (order.status !== "WAITING") return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
          statements.push(
            this.env.DB.prepare(`UPDATE orders SET status = 'CANCELLED', updated_at = ?1 WHERE id = ?2 AND status = 'WAITING'`).bind(now, order.id),
            this.env.DB.prepare(
              `INSERT INTO order_status_history (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
               VALUES (?1, ?2, 'WAITING', 'CANCELLED', ?3, ?4, ?5, ?6)`,
            ).bind(crypto.randomUUID(), order.id, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO_CREATE", originalOperationId: input.operationId })),
          );
        } else if (operation.action_type === "ORDER_READY") {
          const error = await restoreCooking("READY", "READY");
          if (error) return error;
        } else if (operation.action_type === "ORDER_COMPLETE") {
          if (order.status !== "COMPLETED") return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
          statements.push(
            this.env.DB.prepare(`UPDATE orders SET status = 'READY', completed_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'COMPLETED'`).bind(now, order.id),
            this.env.DB.prepare(
              `INSERT INTO order_status_history (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
               VALUES (?1, ?2, 'COMPLETED', 'READY', ?3, ?4, ?5, ?6)`,
            ).bind(crypto.randomUUID(), order.id, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO", originalOperationId: input.operationId })),
          );
        } else if (operation.action_type === "ORDER_CANCEL") {
          const previousStatus = String(payload.previousStatus ?? "");
          if (order.status !== "CANCELLED") return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
          if (previousStatus === "COOKING") {
            const error = await restoreCooking("CANCELLED", "CANCELLED");
            if (error) return error;
          } else if (["WAITING", "READY", "COMPLETED"].includes(previousStatus)) {
            statements.push(
              this.env.DB.prepare(
                `UPDATE orders SET status = ?1, assigned_device_id = ?2, cooking_started_at = ?3,
                   ready_at = ?4, completed_at = ?5, updated_at = ?6 WHERE id = ?7 AND status = 'CANCELLED'`,
              ).bind(previousStatus, payload.assignedDeviceId ?? null, payload.cookingStartedAt ?? null, payload.readyAt ?? null, payload.completedAt ?? null, now, order.id),
              this.env.DB.prepare(
                `INSERT INTO order_status_history (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
                 VALUES (?1, ?2, 'CANCELLED', ?3, ?4, ?5, ?6, ?7)`,
              ).bind(crypto.randomUUID(), order.id, previousStatus, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO", originalOperationId: input.operationId })),
            );
          } else return Response.json({ error: "UNDO_NOT_AVAILABLE" }, { status: 409 });
        } else if (["ADMIN_REQUEUE", "KITCHEN_PRESENCE_REQUEUE"].includes(operation.action_type)) {
          const error = await restoreCooking("WAITING", "WAITING");
          if (error) return error;
          const presence = await this.env.DB.prepare(
            `SELECT kitchen_away, kitchen_away_updated_at FROM devices WHERE id = ?1 AND role = 'KITCHEN'`,
          ).bind(payload.assignedDeviceId).first<{ kitchen_away: number; kitchen_away_updated_at: string | null }>();
          if (operation.action_type === "KITCHEN_PRESENCE_REQUEUE" && (
            !presence || !presence.kitchen_away || presence.kitchen_away_updated_at !== payload.appliedAt
          )) return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
          if (presence?.kitchen_away_updated_at === payload.appliedAt) {
            statements.push(this.env.DB.prepare(
              `UPDATE devices SET kitchen_away = ?1, kitchen_away_updated_at = ?2 WHERE id = ?3`,
            ).bind(payload.previousAway === true ? 1 : 0, now, payload.assignedDeviceId));
          }
        } else if (operation.action_type === "DELIVERY_REWORK") {
          if (order.status !== "COOKING" || order.assigned_device_id !== payload.assignedDeviceId) return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
          const displacedOrderId = typeof payload.displacedOrderId === "string" ? payload.displacedOrderId : null;
          if (displacedOrderId) {
            const displaced = await this.env.DB.prepare(`SELECT status FROM orders WHERE id = ?1`).bind(displacedOrderId).first<{ status: string }>();
            if (displaced?.status !== "WAITING") return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
            const displacedLatest = await this.env.DB.prepare(
              `SELECT metadata_json FROM order_status_history WHERE order_id = ?1 ORDER BY rowid DESC LIMIT 1`,
            ).bind(displacedOrderId).first<{ metadata_json: string | null }>();
            let displacedMetadata: Record<string, unknown> = {};
            try { displacedMetadata = JSON.parse(displacedLatest?.metadata_json ?? "{}") as Record<string, unknown>; } catch { displacedMetadata = {}; }
            if (displacedMetadata.reason !== "DELIVERY_REWORK_DISPLACED" || displacedMetadata.reworkOrderId !== order.id) {
              return Response.json({ error: "UNDO_STATE_CHANGED" }, { status: 409 });
            }
          }
          statements.push(
            this.env.DB.prepare(
              `UPDATE orders SET status = 'READY', cooking_started_at = ?1, ready_at = ?2, completed_at = NULL, updated_at = ?3
               WHERE id = ?4 AND status = 'COOKING'`,
            ).bind(payload.cookingStartedAt ?? null, payload.readyAt ?? now, now, order.id),
            this.env.DB.prepare(
              `INSERT INTO order_status_history (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
               VALUES (?1, ?2, 'COOKING', 'READY', ?3, ?4, ?5, ?6)`,
            ).bind(crypto.randomUUID(), order.id, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO", originalOperationId: input.operationId })),
          );
          if (displacedOrderId) {
            statements.push(
              this.env.DB.prepare(
                `UPDATE orders SET status = 'COOKING', assigned_device_id = ?1, cooking_started_at = ?2, updated_at = ?3
                 WHERE id = ?4 AND status = 'WAITING'`,
              ).bind(payload.assignedDeviceId, payload.displacedCookingStartedAt ?? now, now, displacedOrderId),
              this.env.DB.prepare(
                `INSERT INTO order_status_history (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
                 VALUES (?1, ?2, 'WAITING', 'COOKING', ?3, ?4, ?5, ?6)`,
              ).bind(crypto.randomUUID(), displacedOrderId, actor, input.undoOperationId, now, JSON.stringify({ reason: "UNDO_DISPLACEMENT", restoredOrderId: order.id })),
            );
          }
        } else return Response.json({ error: "UNDO_NOT_AVAILABLE" }, { status: 409 });
      }

      statements.push(this.env.DB.prepare(
        `UPDATE undoable_operations SET undone_at = ?1, undo_operation_id = ?2
         WHERE operation_id = ?3 AND undone_at IS NULL`,
      ).bind(now, input.undoOperationId, input.operationId));
      await this.env.DB.batch(statements);
      await this.notify({ type: "operation.undone", eventId: input.eventId, orderId: operation.order_id ?? undefined });
      return Response.json({ undone: true, orderId: operation.order_id });
    });
  }

  private async waitingCount(eventId: string): Promise<number> {
    const waiting = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM orders WHERE event_id = ?1 AND status = 'WAITING'`,
    ).bind(eventId).first<{ count: number }>();
    return waiting?.count ?? 0;
  }

  private async transitionOrder(request: Request): Promise<Response> {
    let input: TransitionRequest;
    try {
      input = (await request.json()) as TransitionRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }
    if (
      !input.eventId || !input.orderId || !input.deviceId || !input.operationId ||
      input.operationId.length > 128 || !["READY", "COMPLETED"].includes(input.target)
    ) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });

    return this.ctx.blockConcurrencyWhile(async () => {
      const existingOperation = await this.env.DB.prepare(
        `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null }>();
      if (existingOperation) {
        if (existingOperation.to_status !== input.target || existingOperation.device_id !== input.deviceId) {
          return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
        }
        return Response.json({ order: { id: input.orderId, status: input.target }, replayed: true });
      }

      const order = await this.env.DB.prepare(
        `SELECT event_id, status, assigned_device_id, cooking_started_at, ready_at, completed_at FROM orders WHERE id = ?1`,
      ).bind(input.orderId).first<{ event_id: string; status: string; assigned_device_id: string | null; cooking_started_at: string | null; ready_at: string | null; completed_at: string | null }>();
      if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
      if (order.event_id !== input.eventId) return Response.json({ error: "ORDER_EVENT_MISMATCH" }, { status: 409 });
      const expectedSource = input.target === "READY" ? "COOKING" : "READY";
      if (order.status !== expectedSource) return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
      if (input.target === "READY" && order.assigned_device_id !== input.deviceId) {
        return Response.json({ error: "DEVICE_MISMATCH" }, { status: 403 });
      }

      const now = new Date().toISOString();
      const timestampColumn = input.target === "READY" ? "ready_at" : "completed_at";
      const [updateResult] = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE orders SET status = ?1, ${timestampColumn} = ?2, updated_at = ?2
           WHERE id = ?3 AND event_id = ?4 AND status = ?5`,
        ).bind(input.target, now, input.orderId, input.eventId, expectedSource),
        this.env.DB.prepare(
          `INSERT INTO order_status_history
             (id, order_id, from_status, to_status, device_id, operation_id, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
        ).bind(crypto.randomUUID(), input.orderId, expectedSource, input.target, input.deviceId, input.operationId, now),
        this.undoRecord(
          input.operationId,
          input.eventId,
          input.orderId,
          input.target === "READY" ? "KITCHEN" : "DELIVERY",
          input.deviceId,
          input.target === "READY" ? "ORDER_READY" : "ORDER_COMPLETE",
          {
            assignedDeviceId: order.assigned_device_id,
            cookingStartedAt: order.cooking_started_at,
            readyAt: order.ready_at,
            completedAt: order.completed_at,
          },
          now,
        ),
      ]);
      const recorded = await this.env.DB.prepare(
        `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null }>();
      if (recorded?.to_status !== input.target || recorded.device_id !== input.deviceId) {
        return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
      }
      if (updateResult.meta.changes > 0) {
        await this.notify({ type: `order.${input.target.toLowerCase()}`, eventId: input.eventId, orderId: input.orderId });
      }
      return Response.json({ order: { id: input.orderId, status: input.target }, undoOperationId: input.operationId, undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString(), ...(updateResult.meta.changes === 0 ? { replayed: true } : {}) });
    });
  }

  private async requeueOrder(request: Request): Promise<Response> {
    let input: RequeueRequest;
    try {
      input = (await request.json()) as RequeueRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }
    if (!input.eventId || !input.orderId || !input.adminId || !input.operationId || input.operationId.length > 128) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    return this.ctx.blockConcurrencyWhile(async () => {
      const actor = `ADMIN:${input.adminId}`;
      const existingOperation = await this.env.DB.prepare(
        `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null }>();
      if (existingOperation) {
        if (existingOperation.to_status !== "WAITING" || existingOperation.device_id !== actor) {
          return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
        }
        return Response.json({ order: { id: input.orderId, status: "WAITING" }, replayed: true });
      }

      const order = await this.env.DB.prepare(
        `SELECT event_id, status, assigned_device_id, cooking_started_at FROM orders WHERE id = ?1`,
      ).bind(input.orderId).first<{ event_id: string; status: string; assigned_device_id: string | null; cooking_started_at: string | null }>();
      if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
      if (order.event_id !== input.eventId) return Response.json({ error: "ORDER_EVENT_MISMATCH" }, { status: 409 });
      if (order.status !== "COOKING") return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });

      const kitchen = order.assigned_device_id ? await this.env.DB.prepare(
        `SELECT kitchen_away FROM devices WHERE id = ?1 AND role = 'KITCHEN'`,
      ).bind(order.assigned_device_id).first<{ kitchen_away: number }>() : null;

      const now = new Date().toISOString();
      const [updateResult] = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE orders SET status = 'WAITING', assigned_device_id = NULL, cooking_started_at = NULL, updated_at = ?1
           WHERE id = ?2 AND event_id = ?3 AND status = 'COOKING'`,
        ).bind(now, input.orderId, input.eventId),
        this.env.DB.prepare(
          `INSERT INTO order_status_history
             (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
           SELECT ?1, ?2, 'COOKING', 'WAITING', ?3, ?4, ?5, ?6 WHERE changes() = 1`,
        ).bind(crypto.randomUUID(), input.orderId, actor, input.operationId, now, JSON.stringify({ reason: "MANUAL_REQUEUE" })),
        this.env.DB.prepare(
          `UPDATE devices SET kitchen_away = 1, kitchen_away_updated_at = ?1
           WHERE id = ?2 AND role = 'KITCHEN' AND changes() = 1`,
        ).bind(now, order.assigned_device_id),
        this.undoRecord(input.operationId, input.eventId, input.orderId, "ADMIN", input.adminId, "ADMIN_REQUEUE", {
          assignedDeviceId: order.assigned_device_id,
          cookingStartedAt: order.cooking_started_at,
          previousAway: Boolean(kitchen?.kitchen_away),
          appliedAt: now,
        }, now),
      ]);
      const recorded = await this.env.DB.prepare(
        `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null }>();
      if (recorded?.to_status !== "WAITING" || recorded.device_id !== actor) {
        return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
      }
      if (updateResult.meta.changes > 0) await this.notify({ type: "order.requeued", eventId: input.eventId, orderId: input.orderId });
      return Response.json({ order: { id: input.orderId, status: "WAITING" }, pausedDeviceId: order.assigned_device_id, undoOperationId: input.operationId, undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString(), ...(updateResult.meta.changes === 0 ? { replayed: true } : {}) });
    });
  }

  private async returnToKitchen(request: Request): Promise<Response> {
    let input: DeliveryReworkRequest;
    try {
      input = (await request.json()) as DeliveryReworkRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }
    if (!input.eventId || !input.orderId || !input.deliveryDeviceId || !input.operationId || input.operationId.length > 128) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    return this.ctx.blockConcurrencyWhile(async () => {
      const actor = `DELIVERY:${input.deliveryDeviceId}`;
      const existingOperation = await this.env.DB.prepare(
        `SELECT to_status, device_id, metadata_json FROM order_status_history
         WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null; metadata_json: string | null }>();
      if (existingOperation) {
        if (existingOperation.to_status !== "COOKING" || existingOperation.device_id !== actor) {
          return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
        }
        let displacedOrderId: string | null = null;
        try { displacedOrderId = JSON.parse(existingOperation.metadata_json ?? "{}").displacedOrderId ?? null; } catch { displacedOrderId = null; }
        return Response.json({ order: { id: input.orderId, status: "COOKING" }, displacedOrderId, replayed: true });
      }

      const order = await this.env.DB.prepare(
        `SELECT event_id, ticket_number, status, assigned_device_id, cooking_started_at, ready_at FROM orders WHERE id = ?1`,
      ).bind(input.orderId).first<{ event_id: string; ticket_number: string; status: string; assigned_device_id: string | null; cooking_started_at: string | null; ready_at: string | null }>();
      if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
      if (order.event_id !== input.eventId) return Response.json({ error: "ORDER_EVENT_MISMATCH" }, { status: 409 });
      if (order.status !== "READY") return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
      if (!order.assigned_device_id) return Response.json({ error: "PREVIOUS_KITCHEN_NOT_FOUND" }, { status: 409 });
      const kitchen = await this.env.DB.prepare(
        `SELECT id FROM devices WHERE id = ?1 AND role = 'KITCHEN' AND active = 1`,
      ).bind(order.assigned_device_id).first<{ id: string }>();
      if (!kitchen) return Response.json({ error: "PREVIOUS_KITCHEN_UNAVAILABLE" }, { status: 409 });

      const displaced = await this.env.DB.prepare(
        `SELECT id, cooking_started_at FROM orders
         WHERE event_id = ?1 AND assigned_device_id = ?2 AND status = 'COOKING'
         ORDER BY cooking_started_at ASC, id ASC LIMIT 1`,
      ).bind(input.eventId, order.assigned_device_id).first<{ id: string; cooking_started_at: string | null }>();
      const now = new Date().toISOString();
      const statements: D1PreparedStatement[] = [];
      if (displaced) {
        statements.push(
          this.env.DB.prepare(
            `UPDATE orders SET status = 'WAITING', assigned_device_id = NULL, cooking_started_at = NULL, updated_at = ?1
             WHERE id = ?2 AND event_id = ?3 AND status = 'COOKING'
               AND EXISTS (SELECT 1 FROM orders target WHERE target.id = ?4 AND target.event_id = ?3 AND target.status = 'READY')`,
          ).bind(now, displaced.id, input.eventId, input.orderId),
          this.env.DB.prepare(
            `INSERT INTO order_status_history
               (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
             SELECT ?1, ?2, 'COOKING', 'WAITING', ?3, ?4, ?5, ?6 WHERE changes() = 1`,
          ).bind(crypto.randomUUID(), displaced.id, actor, crypto.randomUUID(), now, JSON.stringify({ reason: "DELIVERY_REWORK_DISPLACED", reworkOrderId: input.orderId })),
        );
      }
      statements.push(
        this.env.DB.prepare(
          `UPDATE orders
           SET status = 'COOKING', cooking_started_at = ?1, ready_at = NULL, completed_at = NULL, updated_at = ?1
           WHERE id = ?2 AND event_id = ?3 AND status = 'READY' AND assigned_device_id = ?4`,
        ).bind(now, input.orderId, input.eventId, order.assigned_device_id),
        this.env.DB.prepare(
          `INSERT INTO order_status_history
             (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
           SELECT ?1, ?2, 'READY', 'COOKING', ?3, ?4, ?5, ?6 WHERE changes() = 1`,
        ).bind(crypto.randomUUID(), input.orderId, actor, input.operationId, now, JSON.stringify({ reason: "DELIVERY_REWORK", previousKitchenDeviceId: order.assigned_device_id, displacedOrderId: displaced?.id ?? null })),
        this.undoRecord(input.operationId, input.eventId, input.orderId, "DELIVERY", input.deliveryDeviceId, "DELIVERY_REWORK", {
          assignedDeviceId: order.assigned_device_id,
          cookingStartedAt: order.cooking_started_at,
          readyAt: order.ready_at,
          displacedOrderId: displaced?.id ?? null,
          displacedCookingStartedAt: displaced?.cooking_started_at ?? null,
        }, now),
      );
      await this.env.DB.batch(statements);
      const recorded = await this.env.DB.prepare(
        `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null }>();
      if (recorded?.to_status !== "COOKING" || recorded.device_id !== actor) {
        return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
      }
      if (displaced) await this.notify({ type: "order.requeued", eventId: input.eventId, orderId: displaced.id });
      await this.notify({ type: "order.cooking", eventId: input.eventId, orderId: input.orderId });
      return Response.json({
        order: { id: input.orderId, status: "COOKING", assignedDeviceId: order.assigned_device_id },
        displacedOrderId: displaced?.id ?? null,
        waitingCount: await this.waitingCount(input.eventId),
        undoOperationId: input.operationId,
        undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString(),
      });
    });
  }

  private async cancelOrder(request: Request): Promise<Response> {
    let input: CancelRequest;
    try {
      input = (await request.json()) as CancelRequest;
    } catch {
      return Response.json({ error: "INVALID_JSON" }, { status: 400 });
    }

    const reason = input.reason?.trim();
    if (
      !input.eventId || !input.orderId || !input.actorId || !["ADMIN", "RECEPTION"].includes(input.actorType) ||
      !input.operationId || input.operationId.length > 128 || !reason || reason.length > 200 ||
      (input.forceCooking !== undefined && typeof input.forceCooking !== "boolean") ||
      (input.confirmedTicketNumber !== undefined && typeof input.confirmedTicketNumber !== "string")
    ) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }

    return this.ctx.blockConcurrencyWhile(async () => {
      const existingOperation = await this.env.DB.prepare(
        `SELECT to_status, device_id FROM order_status_history WHERE order_id = ?1 AND operation_id = ?2 ORDER BY rowid DESC LIMIT 1`,
      ).bind(input.orderId, input.operationId).first<{ to_status: string; device_id: string | null }>();
      if (existingOperation) {
        if (existingOperation.to_status !== "CANCELLED" || existingOperation.device_id !== `${input.actorType}:${input.actorId}`) {
          return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
        }
        return Response.json({ order: { id: input.orderId, status: "CANCELLED" }, replayed: true });
      }

      const order = await this.env.DB.prepare(
        `SELECT event_id, ticket_number, status, assigned_device_id, cooking_started_at, ready_at, completed_at FROM orders WHERE id = ?1`,
      ).bind(input.orderId).first<{ event_id: string; ticket_number: string; status: string; assigned_device_id: string | null; cooking_started_at: string | null; ready_at: string | null; completed_at: string | null }>();
      if (!order) return Response.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
      if (order.event_id !== input.eventId) return Response.json({ error: "ORDER_EVENT_MISMATCH" }, { status: 409 });
      const forceCooking = order.status === "COOKING";
      if (forceCooking && (input.actorType !== "ADMIN" || input.forceCooking !== true || input.confirmedTicketNumber !== order.ticket_number)) {
        return Response.json({ error: "COOKING_CANCEL_CONFIRMATION_REQUIRED" }, { status: 409 });
      }
      if (!forceCooking && !["WAITING", "READY", "COMPLETED"].includes(order.status)) {
        return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });
      }

      const now = new Date().toISOString();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE orders SET status = 'CANCELLED', updated_at = ?1
           WHERE id = ?2 AND event_id = ?3 AND status = ?4`,
        ).bind(now, input.orderId, input.eventId, order.status),
        this.env.DB.prepare(
          `INSERT INTO order_status_history
             (id, order_id, from_status, to_status, device_id, operation_id, created_at, metadata_json)
           SELECT ?1, ?2, ?3, 'CANCELLED', ?4, ?5, ?6, ?7 WHERE changes() = 1`,
        ).bind(
          crypto.randomUUID(),
          input.orderId,
          order.status,
          `${input.actorType}:${input.actorId}`,
          input.operationId,
          now,
          JSON.stringify({ reason: forceCooking ? "ADMIN_FORCE_CANCEL" : "MANUAL_CANCEL", note: reason }),
        ),
        this.undoRecord(input.operationId, input.eventId, input.orderId, input.actorType, input.actorId, "ORDER_CANCEL", {
          previousStatus: order.status,
          assignedDeviceId: order.assigned_device_id,
          cookingStartedAt: order.cooking_started_at,
          readyAt: order.ready_at,
          completedAt: order.completed_at,
        }, now),
      ]);

      const updated = await this.env.DB.prepare(
        `SELECT status FROM orders WHERE id = ?1`,
      ).bind(input.orderId).first<{ status: string }>();
      if (updated?.status !== "CANCELLED") return Response.json({ error: "INVALID_STATE_TRANSITION" }, { status: 409 });

      await this.notify({ type: "order.cancelled", eventId: input.eventId, orderId: input.orderId });
      return Response.json({ order: { id: input.orderId, status: "CANCELLED" }, undoOperationId: input.operationId, undoExpiresAt: new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString() });
    });
  }

  private async loadAssignment(order: OrderRow): Promise<OrderRow & { items: Array<OrderItemRow & { options: OrderOptionRow[] }> }> {
    const [itemsResult, optionsResult] = await Promise.all([
      this.env.DB.prepare(
        `SELECT id, item_name, quantity, note
         FROM order_items WHERE order_id = ?1 ORDER BY rowid ASC`,
      ).bind(order.id).all<OrderItemRow>(),
      this.env.DB.prepare(
        `SELECT order_item_id, group_name, option_name, required
         FROM order_item_options
         WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?1)
         ORDER BY rowid ASC`,
      ).bind(order.id).all<OrderOptionRow>(),
    ]);
    const optionsByItem = new Map<string, OrderOptionRow[]>();
    for (const option of optionsResult.results) {
      const options = optionsByItem.get(option.order_item_id) ?? [];
      options.push(option);
      optionsByItem.set(option.order_item_id, options);
    }

    return {
      ...order,
      items: itemsResult.results.map((item) => ({
        ...item,
        options: optionsByItem.get(item.id) ?? [],
      })),
    };
  }

  async notify(message: { type: string; eventId: string; orderId?: string }): Promise<void> {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  webSocketMessage(): void {
    // The server sends notifications only. Client messages are ignored.
  }

  webSocketClose(): void {
    // The runtime removes closed sockets from getWebSockets().
  }
}
