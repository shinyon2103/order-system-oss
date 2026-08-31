CREATE INDEX IF NOT EXISTS order_status_history_order_created_idx
  ON order_status_history(order_id, created_at);
