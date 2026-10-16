import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { autoChoice, type ModelOptions, requestedChoice, type Subscription } from "../src/models";

// The user's roles as configured on this machine: three subscriptions, plus chore roles.
const ROLES = [
	{ role: "smol", setting: "cursor/grok-4.7", provider: "cursor", model: "grok-4.7" },
	{ role: "vision", setting: "openai-codex/gpt-6-astra:high", provider: "openai-codex", model: "gpt-6-astra" },
	{ role: "slow", setting: "anthropic/claude-fable-5-1:high", provider: "anthropic", model: "claude-fable-5-1" },
	{ role: "plan", setting: "openai-codex/gpt-6.1-sol:high", provider: "openai-codex", model: "gpt-6.1-sol" },
	{ role: "commit", setting: "anthropic/claude-sonnet-5-5", provider: "anthropic", model: "claude-sonnet-5-5" },
	{ role: "tiny", setting: "cursor/grok-4.7:low", provider: "cursor", model: "grok-4.7" },
	{ role: "default", setting: "anthropic/claude-opus-5-5", provider: "anthropic", model: "claude-opus-5-5" },
];

// Test seam: autoChoice and requestedChoice read only ctx.models.
const ctx = {
	models: {
		current: () => ({ provider: "anthropic", id: "claude-opus-5-5" }),
		resolve: (spec: string) =>
			spec === "openai-codex/gpt-6.1-sol"
				? { provider: "openai-codex", id: "gpt-6.1-sol" }
				: spec === "@default"
					? { provider: "anthropic", id: "claude-opus-5-5" }
					: undefined,
	},
} as unknown as ExtensionContext;

function options(subscriptions: Partial<Subscription>[]): ModelOptions {
	return {
		subscriptions: subscriptions.map(item => ({ provider: "", agents: 0, exhausted: false, ...item })),
		roles: ROLES,
	};
}

test("with no model asked for, the agent goes to the subscription with the most room", () => {
	const choice = autoChoice(ctx, options([
		{ provider: "anthropic", used: 0.32 },
		{ provider: "openai-codex", used: 0.2 },
		{ provider: "cursor", used: 0.08 },
	]));
	expect(choice?.selector).toBe("@smol");
	expect(choice?.reason).toContain("cursor: 8% used");
});

test("agents already on a subscription count against it, so spawns spread out", () => {
	const choice = autoChoice(ctx, options([
		{ provider: "anthropic", used: 0.32 },
		{ provider: "openai-codex", used: 0.2 },
		{ provider: "cursor", used: 0.08, agents: 2 },
	]));
	expect(choice?.selector).toBe("@plan");
});

test("nearly full or exhausted subscriptions are passed over, and chore roles are never picked", () => {
	const choice = autoChoice(ctx, options([
		{ provider: "anthropic", used: 0.5 },
		{ provider: "openai-codex", used: 0.95 },
		{ provider: "cursor", exhausted: true },
	]));
	expect(choice?.selector).toBe("@default");
	expect(choice?.provider).toBe("anthropic");
});

test("on one subscription, auto prefers default over slow", () => {
	const choice = autoChoice(ctx, options([{ provider: "anthropic", used: 0.1 }]));
	expect(choice?.selector).toBe("@default");
});

test("a requested role or model is used as given; anything else is refused", () => {
	const opts = options([{ provider: "anthropic" }, { provider: "openai-codex" }]);
	expect(requestedChoice(ctx, opts, "slow").selector).toBe("@slow");
	expect(requestedChoice(ctx, opts, "@plan").model).toBe("gpt-6.1-sol");
	expect(requestedChoice(ctx, opts, "openai-codex/gpt-6.1-sol").selector).toBe("openai-codex/gpt-6.1-sol");
	expect(() => requestedChoice(ctx, opts, "nope")).toThrow(/No role or model matches "nope". Roles: @smol/);
});

test("@default works even when the user's settings don't list it, since omp always has it", () => {
	const opts = { ...options([{ provider: "anthropic" }]), roles: ROLES.filter(role => role.role !== "default") };
	expect(requestedChoice(ctx, opts, "@default")).toMatchObject({ selector: "@default", provider: "anthropic" });
});

test("an agent is launched by provider/model with its role's thinking level, never by @alias (omp's CLI matched @default to a Vertex model)", () => {
	const opts = options([{ provider: "anthropic" }, { provider: "openai-codex" }, { provider: "cursor" }]);
	expect(requestedChoice(ctx, opts, "@default").launch).toBe("anthropic/claude-opus-5-5");
	expect(requestedChoice(ctx, opts, "slow").launch).toBe("anthropic/claude-fable-5-1:high");
	expect(requestedChoice(ctx, opts, "openai-codex/gpt-6.1-sol").launch).toBe("openai-codex/gpt-6.1-sol");
	expect(autoChoice(ctx, options([{ provider: "cursor", used: 0.1 }, { provider: "anthropic", used: 0.5 }]))?.launch).toBe("cursor/grok-4.7");
});
