CREATE TABLE order_item_options (
  id TEXT PRIMARY KEY NOT NULL,
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  group_name TEXT NOT NULL,
  option_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
