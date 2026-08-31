ALTER TABLE events
  ADD COLUMN online_next_number INTEGER;

ALTER TABLE events
  ADD COLUMN offline_next_number INTEGER;

ALTER TABLE devices
  ADD COLUMN kitchen_heartbeat_at TEXT;

ALTER TABLE devices
  ADD COLUMN kitchen_heartbeat_event_id TEXT;

UPDATE events
SET online_next_number = COALESCE(
      (
        SELECT MAX(CAST(orders.ticket_number AS INTEGER)) + 1
        FROM orders
        WHERE orders.event_id = events.id
          AND orders.ticket_number <> ''
          AND orders.ticket_number NOT GLOB '*[^0-9]*'
          AND CAST(orders.ticket_number AS INTEGER) BETWEEN
              (SELECT online_start_number FROM order_number_settings WHERE id = 'default') AND
              (SELECT online_end_number FROM order_number_settings WHERE id = 'default')
      ),
      (SELECT online_start_number FROM order_number_settings WHERE id = 'default')
    ),
    offline_next_number = (SELECT offline_start_number FROM order_number_settings WHERE id = 'default');

UPDATE events
SET online_next_number = (SELECT online_next_number FROM order_number_settings WHERE id = 'default'),
    offline_next_number = (SELECT offline_next_number FROM order_number_settings WHERE id = 'default')
WHERE status = 'OPEN';

DROP TRIGGER allocate_online_order_number;

CREATE TRIGGER allocate_online_order_number
AFTER INSERT ON orders
WHEN NEW.ticket_number = '__ONLINE__'
BEGIN
  SELECT (CASE
    WHEN (SELECT online_next_number > online_end_number
          FROM order_number_settings WHERE id = 'default')
    THEN RAISE(ABORT, 'ONLINE_NUMBER_EXHAUSTED')
  END);

  UPDATE orders
  SET ticket_number = CAST((SELECT online_next_number
                            FROM order_number_settings WHERE id = 'default') AS TEXT)
  WHERE id = NEW.id;

  UPDATE order_number_settings
  SET online_next_number = online_next_number + 1
  WHERE id = 'default';

  UPDATE events
  SET online_next_number = (SELECT online_next_number
                            FROM order_number_settings WHERE id = 'default')
  WHERE id = NEW.event_id;
END;
