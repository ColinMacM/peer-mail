/**
 * Which model a spawned agent runs on. Choices come from the user's own omp model roles
 * (`modelRoles` in ~/.omp/agent/config.yml), or any authenticated model the hub names. With no
 * choice made, the spawn goes to the role whose subscription (provider) has the most room: the
 * lowest used fraction of its usage limits, counting agents already running on it, so a swarm
 * spreads across subscriptions instead of draining one.
 */
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
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
	/**
	 * How used it is (0..1, >1 is overage): the fullest limit every request counts against, or for a
	 * provider split into separate pools (Cursor) the emptiest pool. Undefined when unreported.
	 */
	used?: number;
	/** Swarm members currently running on it. */
	agents: number;
	/** No request can go through: a limit every request counts against is spent, or every pool is. */
	exhausted: boolean;
	/** Each limit, e.g. `7 days 47%` or `Other Models exhausted, resets Nov 5`. */
	limits: string[];
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
export const NO_SUBAGENTS: Record<string, true> = { cursor: true };

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

/** A limit's used fraction, from whichever amount fields it has. */
function usedFraction(limit: UsageLimit): number | undefined {
	const { amount } = limit;
	return (
		amount.usedFraction ??
		(amount.used !== undefined && amount.limit ? amount.used / amount.limit : undefined) ??
		(amount.unit === "percent" && amount.used !== undefined ? amount.used / 100 : undefined) ??
		(amount.remainingFraction !== undefined ? 1 - amount.remainingFraction : undefined)
	);
}

/** `5 hours 100%, resets 21:46`: a limit's use, and when it resets once it's nearly full. */
function describeLimit(limit: UsageLimit, now: number): string {
	const used = usedFraction(limit);
	const spent = limit.status === "exhausted" || (used ?? 0) >= 1;
	const level = spent ? "exhausted" : used === undefined ? "usage unknown" : `${Math.round(used * 100)}%`;
	const resetsAt = limit.window?.resetsAt;
	if (!resetsAt || (!spent && (used ?? 0) < NEARLY_FULL)) return `${limit.label} ${level}`;
	const date = new Date(resetsAt);
	const when =
		resetsAt - now < 24 * 3600_000
			? date.toTimeString().slice(0, 5)
			: date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	return `${limit.label} ${level}, resets ${when}`;
}

/**
 * A provider's subscription from its usage report. Limits flagged shared all apply to every request.
 * Unflagged limits on the same window (Cursor's monthly "Cursor Models" and "Other Models") are
 * separate pools, alternatives to each other; a lone unflagged limit is treated as shared, the
 * cautious reading.
 */
export function subscriptionOf(provider: string, report: UsageReport | undefined, agents: number, now = Date.now()): Subscription {
	const limits = report?.limits ?? [];
	const groups = new Map<string, UsageLimit[]>();
	for (const limit of limits) {
		const key = limit.scope?.shared ? `shared:${limit.id}` : `window:${limit.scope?.windowId ?? limit.window?.id ?? limit.id}`;
		groups.set(key, [...(groups.get(key) ?? []), limit]);
	}
	const spent = (limit: UsageLimit) => limit.status === "exhausted" || (usedFraction(limit) ?? 0) >= 1;
	// Each group is as used as its emptiest member (a lone limit: itself); the subscription as its fullest group.
	let used: number | undefined;
	let exhausted = false;
	for (const group of groups.values()) {
		const fractions = group.map(usedFraction).filter((value): value is number => value !== undefined);
		if (fractions.length > 0) used = Math.max(used ?? 0, Math.min(...fractions));
		if (group.every(spent)) exhausted = true;
	}
	return { provider, used, agents, exhausted, limits: limits.map(limit => describeLimit(limit, now)) };
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
	return providers.map(provider =>
		subscriptionOf(
			provider,
			reports?.find(item => item.provider === provider),
			members.filter(member => member.model?.startsWith(`${provider}/`)).length,
		),
	);
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

/** `7 days 47%, 5 hours 0%; 2 agents on it`: each limit as reported, then how many swarm agents use it. */
export function describeSubscription(subscription: Subscription | undefined): string {
	if (!subscription) return "not available";
	const usage = subscription.limits.length > 0 ? subscription.limits.join(", ") : "usage unknown";
	const state = subscription.exhausted ? "EXHAUSTED: " : "";
	const agents = subscription.agents === 1 ? "1 agent on it" : `${subscription.agents} agents on it`;
	return `${state}${usage}; ${agents}${NO_SUBAGENTS[subscription.provider] ? "; no subagents" : ""}`;
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
