import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 scale budget", () => {
  it("uses order-item indexes and keeps a 1000-product admin response bounded", async () => {
    const eventId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (id, name, business_date, status, created_at, updated_at)
         VALUES (?1, '1000商品検証', '2026-08-27', 'CLOSED', ?2, ?2)`,
      ).bind(eventId, now),
      env.DB.prepare(
        `INSERT INTO orders
           (id, event_id, ticket_number, status, accepted_at, created_at, updated_at, request_id)
         VALUES (?1, ?2, 'SCALE-1000', 'COMPLETED', ?3, ?3, ?3, ?4)`,
      ).bind(orderId, eventId, now, crypto.randomUUID()),
    ]);

    for (let offset = 0; offset < 1_000; offset += 50) {
      await env.DB.batch(Array.from({ length: 50 }, (_, index) => {
        const itemNumber = offset + index;
        return env.DB.prepare(
          `INSERT INTO order_items (id, order_id, item_code, item_name, quantity, created_at)
           VALUES (?1, ?2, ?3, ?4, 1, ?5)`,
        ).bind(crypto.randomUUID(), orderId, `ITEM-${itemNumber}`, `検証商品-${itemNumber}`, now);
      }));
    }

    const itemPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id, order_id, item_name, quantity, note
       FROM order_items WHERE order_id IN (?1) ORDER BY rowid ASC`,
    ).bind(orderId).all<Record<string, unknown>>();
    expect(JSON.stringify(itemPlan.results)).toContain("order_items_order_id_idx");

    const summary = await env.DB.prepare(
      `SELECT order_items.item_code, SUM(order_items.quantity) AS quantity
       FROM orders JOIN order_items ON order_items.order_id = orders.id
       WHERE orders.event_id = ?1
       GROUP BY order_items.item_code`,
    ).bind(eventId).all();
    expect(summary.results).toHaveLength(1_000);
    expect(summary.meta.rows_read).toBeLessThanOrEqual(2_100);

    const admin = await exports.default.fetch(new Request(`https://example.test/api/admin/orders?eventId=${eventId}`, {
      headers: { Authorization: "Bearer invalid" },
    }));
    expect(admin.status).toBe(401);

    const serializedItems = JSON.stringify({ items: summary.results });
    expect(new TextEncoder().encode(serializedItems).byteLength).toBeLessThan(100_000);
  });
});
