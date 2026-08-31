PRAGMA foreign_keys = ON;

CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  ticket_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING', 'COOKING', 'READY', 'COMPLETED', 'CANCELLED')),
  accepted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cooking_started_at TEXT,
  ready_at TEXT,
  completed_at TEXT,
  assigned_device_id TEXT,
  updated_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  UNIQUE (event_id, request_id)
);

CREATE INDEX orders_queue_idx
  ON orders (event_id, status, accepted_at, id);

CREATE INDEX orders_ticket_idx
  ON orders (event_id, ticket_number, created_at);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  device_key_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('RECEPTION', 'KITCHEN', 'DELIVERY', 'DISPLAY', 'ADMIN')),
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE order_status_history (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  device_id TEXT,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE queue_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE menu_items (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE menu_option_groups (
  id TEXT PRIMARY KEY NOT NULL,
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,
  selection_type TEXT NOT NULL CHECK (selection_type IN ('SINGLE', 'MULTIPLE')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE menu_options (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES menu_option_groups(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE admins (
  id TEXT PRIMARY KEY NOT NULL,
  login_name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  admin_id TEXT NOT NULL REFERENCES admins(id),
  device_id TEXT,
  issued_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reauth_grace_expires_at TEXT NOT NULL,
  revoked_at TEXT
);
