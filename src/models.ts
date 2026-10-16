/**
 * Which model a spawned agent runs on. Choices come from the user's own omp model roles
 * (`modelRoles` in ~/.omp/agent/config.yml), or any authenticated model the hub names. With no
 * choice made, the spawn goes to the role whose subscription (provider) has the most room: the
 * lowest used fraction of its usage limits, counting agents already running on it, so a swarm
 * spreads across subscriptions instead of draining one.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Peer } from "./transport";

/** The host's settings, which role lookups read. */
export type HostSettings = ExtensionAPI["pi"]["settings"];

/** Roles for background chores (titles, memory, commits, images); auto never picks them for an agent. */
export const CHORE_ROLES: Record<string, true> = { tiny: true, memory: true, commit: true, vision: true };
/** Order auto prefers among roles on the same subscription. */
const ROLE_PREFERENCE = ["default", "slow", "plan", "smol"];
/** A subscription this full is only used when nothing else is available. */
export const NEARLY_FULL = 0.9;
/** How much each agent already running on a subscription counts against it, as a used fraction. */
const AGENT_WEIGHT = 0.1;
const USAGE_TIMEOUT_MS = 8_000;

export interface Subscription {
	provider: string;
	/** Highest used fraction across its usage limits (0..1, >1 is overage); undefined when unreported. */
	used?: number;
	/** Swarm members currently running on it. */
	agents: number;
	exhausted: boolean;
}

export interface RoleChoice {
	role: string;
	/** The role's setting, e.g. `anthropic/claude-fable-5-1:high`. */
	setting: string;
	provider: string;
	model: string;
}

export interface ModelChoice {
	/** How the choice reads to the user and the hub: `@role` or `provider/id`. */
	selector: string;
	/**
	 * What goes to `omp --model`: always `provider/id`, with the role's thinking level. Never a
	 * role alias: the CLI matches model ids before roles, so `@default` picks a Vertex model whose
	 * id ends in `@default`.
	 */
	launch: string;
	provider: string;
	model: string;
	role?: string;
	/** Why it was chosen, shown to the user and the hub. */
	reason: string;
}

/** `provider/model`, plus the thinking level `setting` (a role's configured value) gives that same model. */
function launchSpec(provider: string, model: string, setting?: string): string {
	const first = setting?.split(",")[0]?.trim();
	const level = first && first.replace(/:[a-z]+$/, "") === `${provider}/${model}` ? /:([a-z]+)$/.exec(first)?.[1] : undefined;
	return `${provider}/${model}${level ? `:${level}` : ""}`;
}

export interface ModelOptions {
	subscriptions: Subscription[];
	roles: RoleChoice[];
}

/**
 * Providers whose models can't run subagents in omp: Cursor's models start subagents through
 * Cursor's own protocol, which omp answers with "Subagents are not implemented by this client".
 */
const NO_SUBAGENTS: Record<string, true> = { cursor: true };

function settingOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter(item => typeof item === "string").join(",") || undefined;
	return undefined;
}

/** The user's configured model roles, resolved to the model each one runs today. */
export function configuredRoles(ctx: ExtensionContext, settings: HostSettings): RoleChoice[] {
	const raw = lookup("modelRoles")?.get(settings);
	if (!raw || typeof raw !== "object") return [];
	const roles: RoleChoice[] = [];
	for (const [role, value] of Object.entries(raw)) {
		const setting = settingOf(value);
		const model = setting ? ctx.models.resolve(`@${role}`) : undefined;
		if (setting && model) roles.push({ role, setting, provider: model.provider, model: model.id });
	}
	return roles;
}

/** Highest used fraction across a report's limits, from whichever amount fields it has. */
function usedFraction(limits: readonly { amount: { used?: number; limit?: number; usedFraction?: number; remainingFraction?: number; unit: string } }[]): number | undefined {
	let highest: number | undefined;
	for (const { amount } of limits) {
		const fraction =
			amount.usedFraction ??
			(amount.used !== undefined && amount.limit ? amount.used / amount.limit : undefined) ??
			(amount.unit === "percent" && amount.used !== undefined ? amount.used / 100 : undefined) ??
			(amount.remainingFraction !== undefined ? 1 - amount.remainingFraction : undefined);
		if (fraction !== undefined && (highest === undefined || fraction > highest)) highest = fraction;
	}
	return highest;
}

/** The subscriptions this session can use, with their usage and how many swarm agents run on each. */
export async function subscriptions(ctx: ExtensionContext, members: Peer[]): Promise<Subscription[]> {
	const providers = [...new Set(ctx.models.list().map(model => model.provider))];
	let reports: UsageReport[] | null = null;
	try {
		reports = await ctx.modelRegistry.authStorage.usage.reports({ signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
	} catch {
		// Usage is advisory: without it, choices balance by agent count alone.
	}
	return providers.map(provider => {
		const report = reports?.find(item => item.provider === provider);
		const used = report ? usedFraction(report.limits) : undefined;
		return {
			provider,
			used,
			agents: members.filter(member => member.model?.startsWith(`${provider}/`)).length,
			exhausted: !!report?.limits.some(limit => limit.status === "exhausted"),
		};
	});
}

export async function modelOptions(ctx: ExtensionContext, settings: HostSettings, members: Peer[]): Promise<ModelOptions> {
	return { subscriptions: await subscriptions(ctx, members), roles: configuredRoles(ctx, settings) };
}

/** How loaded a subscription is: its used fraction plus a share for each agent already on it. */
export function load(subscription: Subscription | undefined): number {
	if (!subscription) return Number.POSITIVE_INFINITY;
	if (subscription.exhausted) return Number.POSITIVE_INFINITY;
	return (subscription.used ?? 0) + subscription.agents * AGENT_WEIGHT;
}

export function describeSubscription(subscription: Subscription | undefined): string {
	if (!subscription) return "not available";
	const used = subscription.exhausted
		? "exhausted"
		: subscription.used === undefined
			? "usage unknown"
			: `${Math.round(subscription.used * 100)}% used`;
	const agents = subscription.agents === 1 ? "1 agent on it" : `${subscription.agents} agents on it`;
	return `${used}, ${agents}${NO_SUBAGENTS[subscription.provider] ? ", no subagents" : ""}`;
}

/**
 * Auto choice: among the user's agent roles, the one on the least-loaded subscription that isn't
 * nearly full (if every one is, the least loaded anyway); ties go to default, slow, plan, smol.
 * Without roles, the session's own model.
 */
export function autoChoice(ctx: ExtensionContext, options: ModelOptions): ModelChoice | undefined {
	const byProvider = new Map(options.subscriptions.map(subscription => [subscription.provider, subscription]));
	const candidates = options.roles.filter(role => !CHORE_ROLES[role.role] && byProvider.has(role.provider));
	if (candidates.length === 0) {
		const current = ctx.models.current();
		if (!current) return undefined;
		const launch = `${current.provider}/${current.id}`;
		return { selector: launch, launch, provider: current.provider, model: current.id, reason: "this session's model (no omp roles are configured)" };
	}
	const rank = (role: RoleChoice) => {
		const preference = ROLE_PREFERENCE.indexOf(role.role);
		return preference === -1 ? ROLE_PREFERENCE.length : preference;
	};
	const roomy = candidates.filter(role => {
		const subscription = byProvider.get(role.provider);
		return !subscription?.exhausted && (subscription?.used ?? 0) < NEARLY_FULL;
	});
	const pool = roomy.length > 0 ? roomy : candidates;
	const best = [...pool].sort(
		(a, b) => load(byProvider.get(a.provider)) - load(byProvider.get(b.provider)) || rank(a) - rank(b),
	)[0];
	return {
		selector: `@${best.role}`,
		launch: launchSpec(best.provider, best.model, best.setting),
		provider: best.provider,
		model: best.model,
		role: best.role,
		reason: `your "${best.role}" role, on the subscription with the most room (${best.provider}: ${describeSubscription(byProvider.get(best.provider))})`,
	};
}

/** A choice the hub (or the user) asked for: `@role`, a role name, `provider/id` or a model id. */
export function requestedChoice(ctx: ExtensionContext, options: ModelOptions, spec: string): ModelChoice {
	const wanted = spec.trim().replace(/^@/, "");
	const role = options.roles.find(item => item.role === wanted);
	if (role) {
		return { selector: `@${role.role}`, launch: launchSpec(role.provider, role.model, role.setting), provider: role.provider, model: role.model, role: role.role, reason: `your "${role.role}" role` };
	}
	// A role omp knows that isn't in the user's settings, such as the built-in `default`.
	const builtIn = /^[a-z][a-z0-9_-]*$/i.test(wanted) ? ctx.models.resolve(`@${wanted}`) : undefined;
	if (builtIn) {
		return { selector: `@${wanted}`, launch: `${builtIn.provider}/${builtIn.id}`, provider: builtIn.provider, model: builtIn.id, role: wanted, reason: `omp's "${wanted}" role` };
	}
	const model = ctx.models.resolve(spec.trim());
	if (!model) {
		const known = options.roles.map(item => `@${item.role}`).join(", ");
		throw new Error(`No role or model matches "${spec}". Roles: ${known || "none"}; or name one of the models peer_models lists.`);
	}
	const launch = `${model.provider}/${model.id}`;
	return { selector: launch, launch, provider: model.provider, model: model.id, reason: "as requested" };
}
