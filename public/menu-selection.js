export function buildOrderLine(item, quantity, selectedOptionKeys = []) {
  if (!item?.id || !item.name || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return { ok: false, error: "INVALID_QUANTITY" };
  }

  const selected = new Set(selectedOptionKeys);
  const recognized = new Set();
  const options = [];

  for (const group of item.option_groups || []) {
    const groupSelections = [];
    for (const option of group.options || []) {
      const key = `${group.id}:${option.id}`;
      if (!selected.has(key)) continue;
      recognized.add(key);
      groupSelections.push(option);
    }
    if (group.required && groupSelections.length === 0) {
      return { ok: false, error: "REQUIRED_OPTION_MISSING", groupName: group.name };
    }
    if (group.selection_type === "SINGLE" && groupSelections.length > 1) {
      return { ok: false, error: "SINGLE_OPTION_EXCEEDED", groupName: group.name };
    }
    for (const option of groupSelections) options.push({ groupName: group.name, optionName: option.name });
  }

  if (recognized.size !== selected.size) return { ok: false, error: "UNKNOWN_OPTION" };
  return {
    ok: true,
    line: { itemCode: item.id, itemName: item.name, quantity, options },
  };
}
