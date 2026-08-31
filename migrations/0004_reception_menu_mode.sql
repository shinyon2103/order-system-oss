ALTER TABLE app_settings
  ADD COLUMN reception_menu_mode TEXT NOT NULL DEFAULT 'DIRECT'
  CHECK (reception_menu_mode IN ('DIRECT', 'CART'));
