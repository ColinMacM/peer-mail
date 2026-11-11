import { expect, test } from "bun:test";
import { choosePane, herdrAgentName } from "../src/herdr";

test("the largest pane is split along its longer side, so successive agents fill the workspace as a grid", () => {
	const full = { pane: "w1:p1", width: 300, height: 80 };
	expect(choosePane([full], "auto")).toEqual({ pane: "w1:p1", direction: "right" });
	const halves = [{ pane: "w1:p1", width: 150, height: 80 }, { pane: "w1:p2", width: 150, height: 80 }];
	expect(choosePane(halves, "auto")).toEqual({ pane: "w1:p1", direction: "down" });
	expect(choosePane([{ pane: "w1:p1", width: 150, height: 40 }, { pane: "w1:p2", width: 150, height: 80 }], "auto")).toEqual({ pane: "w1:p2", direction: "down" });
});

test("a pane too small to halve sends the agent to a new tab; auto tries the other side first, an asked-for side doesn't", () => {
	// Wide but too narrow to halve into two usable columns: auto stacks instead.
	expect(choosePane([{ pane: "w1:p1", width: 110, height: 40 }], "auto")).toEqual({ pane: "w1:p1", direction: "down" });
	expect(choosePane([{ pane: "w1:p1", width: 110, height: 40 }], "vertical")).toBeUndefined();
	expect(choosePane([{ pane: "w1:p1", width: 100, height: 20 }], "auto")).toBeUndefined();
	expect(choosePane([], "auto")).toBeUndefined();
});

test("swarm names become valid herdr agent names, numbered when taken", () => {
	const valid = /^[a-z][a-z0-9_-]{0,31}$/;
	for (const name of ["reviewer", "3d-printer", "plan.v2", "a".repeat(48)]) {
		expect(herdrAgentName(name)).toMatch(valid);
		expect(herdrAgentName(name, 12)).toMatch(valid);
	}
	expect(herdrAgentName("plan.v2")).toBe("plan-v2");
	expect(herdrAgentName("reviewer", 2)).toBe("reviewer-2");
	expect(herdrAgentName("a".repeat(48), 2)).toBe(`${"a".repeat(30)}-2`);
});
