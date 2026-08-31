import { describe, expect, it } from "vitest";
import { buildOrderLine } from "../public/menu-selection.js";

const item = {
  id: "FOOD-1",
  name: "焼きそば",
  option_groups: [
    {
      id: "SIZE",
      name: "サイズ",
      selection_type: "SINGLE",
      required: 1,
      options: [{ id: "NORMAL", name: "普通" }, { id: "LARGE", name: "大盛り" }],
    },
    {
      id: "TOPPING",
      name: "トッピング",
      selection_type: "MULTIPLE",
      required: 0,
      options: [{ id: "EGG", name: "目玉焼き" }, { id: "CHEESE", name: "チーズ" }],
    },
  ],
};

describe("menu option selection", () => {
  it("builds one order line with selections from multiple groups", () => {
    expect(buildOrderLine(item, 2, ["SIZE:LARGE", "TOPPING:EGG", "TOPPING:CHEESE"])).toEqual({
      ok: true,
      line: {
        itemCode: "FOOD-1",
        itemName: "焼きそば",
        quantity: 2,
        options: [
          { groupName: "サイズ", optionName: "大盛り" },
          { groupName: "トッピング", optionName: "目玉焼き" },
          { groupName: "トッピング", optionName: "チーズ" },
        ],
      },
    });
  });

  it("requires required groups and enforces single selection", () => {
    expect(buildOrderLine(item, 1, [])).toMatchObject({ ok: false, error: "REQUIRED_OPTION_MISSING", groupName: "サイズ" });
    expect(buildOrderLine(item, 1, ["SIZE:NORMAL", "SIZE:LARGE"])).toMatchObject({ ok: false, error: "SINGLE_OPTION_EXCEEDED", groupName: "サイズ" });
  });

  it("rejects unknown choices and invalid quantities", () => {
    expect(buildOrderLine(item, 1, ["SIZE:NORMAL", "UNKNOWN:OPTION"])).toMatchObject({ ok: false, error: "UNKNOWN_OPTION" });
    expect(buildOrderLine(item, 0, ["SIZE:NORMAL"])).toMatchObject({ ok: false, error: "INVALID_QUANTITY" });
  });
});
