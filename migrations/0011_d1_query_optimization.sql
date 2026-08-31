CREATE INDEX IF NOT EXISTS order_items_order_id_idx
  ON order_items (order_id);

CREATE INDEX IF NOT EXISTS order_item_options_order_item_id_idx
  ON order_item_options (order_item_id);

CREATE INDEX IF NOT EXISTS orders_kitchen_assignment_idx
  ON orders (event_id, status, assigned_device_id, cooking_started_at, id);

CREATE INDEX IF NOT EXISTS orders_kitchen_fairness_idx
  ON orders (event_id, assigned_device_id, ready_at);
