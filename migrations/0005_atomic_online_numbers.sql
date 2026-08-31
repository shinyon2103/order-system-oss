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
END;
