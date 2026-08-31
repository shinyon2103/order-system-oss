ALTER TABLE order_item_options ADD COLUMN required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1));
