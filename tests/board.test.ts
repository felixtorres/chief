import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Board, BoardConflictError, Card, STATUS_SEP, updateBoard } from "../src/board.js";
import { tmp } from "./helpers.js";

const EXAMPLE = readFileSync(new URL("../templates/board.example.md", import.meta.url), "utf8");

const BOARD = `---

kanban-plugin: board

---

## 📥 Backlog

- [ ] Idea one #repo/api
- [ ] Idea two
\tsecond line of notes


## ✅ Ready

- [ ] Fix date parsing #repo/web


## 🍳 Cooking



## Pass

**Complete**


%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`;

describe("Board.parse / render", () => {
  it("round-trips the starter board byte for byte", () => {
    expect(Board.parse(EXAMPLE).render()).toBe(EXAMPLE);
  });

  it("round-trips a board with emoji lanes, notes and a Complete marker", () => {
    expect(Board.parse(BOARD).render()).toBe(BOARD);
  });

  it("parses lanes, cards, notes and the settings trailer", () => {
    const b = Board.parse(BOARD);
    expect(b.lanes.map((l) => l.name)).toEqual(["📥 Backlog", "✅ Ready", "🍳 Cooking", "Pass"]);
    expect(b.lane("backlog")!.cards[1]!.notes).toEqual(["second line of notes"]);
    expect(b.lane("Pass")!.prefix).toEqual(["**Complete**"]);
    expect(b.trailer[0]).toBe("%% kanban:settings");
  });

  it("matches lane names ignoring emoji, case and punctuation", () => {
    const b = Board.parse(BOARD);
    expect(b.lane("Ready")?.name).toBe("✅ Ready");
    expect(b.lane("COOKING")?.name).toBe("🍳 Cooking");
    expect(b.lane("Served")).toBeUndefined();
  });

  it("is idempotent after moves", () => {
    const b = Board.parse(BOARD);
    b.move(b.lane("ready")!.cards[0]!, "cooking");
    const once = b.render();
    expect(Board.parse(once).render()).toBe(once);
    expect(Board.parse(once).lane("cooking")!.cards[0]!.cleanTitle).toBe("Fix date parsing");
    expect(Board.parse(once).lane("ready")!.cards).toHaveLength(0);
  });

  it("throws when moving to a lane that does not exist", () => {
    const b = Board.parse(BOARD);
    expect(() => b.move(b.lane("ready")!.cards[0]!, "Nowhere")).toThrow(/no lane/);
  });
});

describe("Card", () => {
  it("adds a stable id once and reads repo + clean title", () => {
    const c = new Card(false, "Fix date parsing #repo/web");
    const id = c.ensureId(() => "abc123");
    expect(id).toBe("abc123");
    expect(c.ensureId(() => "ffffff")).toBe("abc123");
    expect(c.text).toBe("Fix date parsing #repo/web #chief-abc123");
    expect(c.repo).toBe("web");
    expect(c.cleanTitle).toBe("Fix date parsing");
  });

  it("owns only the status suffix and replaces it on each update", () => {
    const c = new Card(false, "Task #chief-abc123");
    c.setStatus("🍳 cooking");
    c.setStatus("🔍 green\nmulti <br> line");
    expect(c.text).toBe(`Task #chief-abc123${STATUS_SEP}🔍 green multi   line`);
    expect(c.title).toBe("Task #chief-abc123");
    expect(c.id).toBe("abc123");
    c.setStatus("");
    expect(c.text).toBe("Task #chief-abc123");
  });

  it("drops old statuses that Obsidian moved onto their own lines", () => {
    const c = new Card(false, "Task #chief-abc123", ["\t🤖 🚧 PR step failed", "\tKeep this note", "\t<br>🤖 🍳 cooking"]);
    expect(c.notes).toEqual(["Keep this note"]);
    c.setStatus("🍳 cooking again");
    expect(c.render()).toEqual([`- [ ] Task #chief-abc123${STATUS_SEP}🍳 cooking again`, "\tKeep this note"]);
  });
});

describe("updateBoard", () => {
  it("writes changes atomically", () => {
    const path = join(tmp(), "board.md");
    writeFileSync(path, BOARD);
    updateBoard(path, (b) => b.move(b.lane("ready")!.cards[0]!, "pass"));
    expect(Board.parse(readFileSync(path, "utf8")).lane("pass")!.cards[0]!.cleanTitle).toBe("Fix date parsing");
  });

  it("re-reads instead of clobbering a concurrent edit", () => {
    const path = join(tmp(), "board.md");
    writeFileSync(path, BOARD);
    let calls = 0;
    updateBoard(path, (b) => {
      calls++;
      if (calls === 1) {
        // Simulate you adding a card in Obsidian while Chief is mid-update.
        writeFileSync(path, BOARD.replace("- [ ] Idea two", "- [ ] Added in Obsidian\n- [ ] Idea two"));
        const future = new Date(Date.now() + 5000);
        utimesSync(path, future, future);
      }
      b.move(b.lane("ready")!.cards[0]!, "cooking");
    });
    expect(calls).toBe(2);
    const final = readFileSync(path, "utf8");
    expect(final).toContain("Added in Obsidian");
    expect(Board.parse(final).lane("cooking")!.cards).toHaveLength(1);
  });

  it("gives up with a conflict error if the file never settles", () => {
    const path = join(tmp(), "board.md");
    writeFileSync(path, BOARD);
    let n = 0;
    expect(() =>
      updateBoard(path, (b) => {
        n++;
        const t = new Date(Date.now() + n * 10_000);
        utimesSync(path, t, t);
        b.move(b.lane("ready")!.cards[0] ?? b.lane("cooking")!.cards[0]!, "cooking");
      }, 2),
    ).toThrow(BoardConflictError);
  });
});
