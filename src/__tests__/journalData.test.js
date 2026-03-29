import { describe, expect, it } from "vitest";
import { JOURNAL_BY_ID, JOURNAL_ENTRIES, getJournalTotalCount } from "../journalData.js";

describe("journal data integrity", () => {
  it("has unique ids and ascending story order", () => {
    const ids = new Set();
    let lastOrder = 0;
    for (const entry of JOURNAL_ENTRIES) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.order).toBeGreaterThan(lastOrder);
      lastOrder = entry.order;
      expect(typeof entry.title).toBe("string");
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.text).toBe("string");
      expect(entry.text.length).toBeGreaterThan(0);
    }
  });

  it("keeps lookup map aligned with entries", () => {
    expect(Object.keys(JOURNAL_BY_ID).length).toBe(JOURNAL_ENTRIES.length);
    for (const entry of JOURNAL_ENTRIES) {
      expect(JOURNAL_BY_ID[entry.id]).toBeDefined();
      expect(JOURNAL_BY_ID[entry.id].order).toBe(entry.order);
    }
  });

  it("reports total count correctly", () => {
    expect(getJournalTotalCount()).toBe(JOURNAL_ENTRIES.length);
  });
});
