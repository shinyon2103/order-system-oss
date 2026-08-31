CREATE TABLE undoable_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  order_id TEXT REFERENCES orders(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('RECEPTION', 'KITCHEN', 'DELIVERY', 'ADMIN')),
  actor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  undone_at TEXT,
  undo_operation_id TEXT
);

CREATE INDEX undoable_operations_event_expires_idx
  ON undoable_operations (event_id, expires_at);
