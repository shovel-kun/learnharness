import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";

import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: ANTIGRAVITY_API,
	provider: ANTIGRAVITY_PROVIDER,
	baseUrl: "",
	// Pi-required placeholders, not prices: the CLI's own auth/routing
	// determines charges. Server pricing and the client catalog report unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name" | "input" | "thinkingLevelMap">;

export const ANTIGRAVITY_MODELS: readonly Model<Api>[] = [
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		input: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-4-hydrogen",
		name: "Gemini 4 Hydrogen",
		input: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-pro-orchestrator-g1-pro",
		name: "Orchestrator (Argon)",
		input: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		input: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		input: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		input: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
	},
	{
		...SHARED_MODEL_FIELDS,
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B",
		input: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null },
	},
];

type VariantTable = Partial<Record<ThinkingLevel, string>> & { default: string };

const MODEL_VARIANTS: Record<string, VariantTable> = {
	"gemini-4-argon": {
		low: "gemini-4-argon-low",
		medium: "gemini-4-argon-medium",
		high: "gemini-4-argon-high",
		xhigh: "gemini-4-argon-high",
		default: "gemini-4-argon-medium",
	},
	"gemini-4-hydrogen": {
		low: "gemini-4-hydrogen-low",
		medium: "gemini-4-hydrogen-medium",
		high: "gemini-4-hydrogen-high",
		xhigh: "gemini-4-hydrogen-xhigh",
		default: "gemini-4-hydrogen-medium",
	},
	"gemini-pro-orchestrator-g1-pro": {
		default: "gemini-pro-orchestrator-g1-pro",
	},
	"gemini-3.8-flash": {
		low: "gemini-3.8-flash-low",
		medium: "gemini-3.8-flash-medium",
		high: "gemini-3.8-flash-high",
		xhigh: "gemini-3.8-flash-high",
		default: "gemini-3.8-flash-medium",
	},
	"claude-opus-5-5": {
		low: "claude-opus-5-5-low",
		medium: "claude-opus-5-5-medium",
		high: "claude-opus-5-5-high",
		xhigh: "claude-opus-5-5-high",
		default: "claude-opus-5-5-medium",
	},
	"claude-sonnet-5-5": {
		low: "claude-sonnet-5-5-low",
		medium: "claude-sonnet-5-5-medium",
		high: "claude-sonnet-5-5-high",
		xhigh: "claude-sonnet-5-5-high",
		default: "claude-sonnet-5-5-medium",
	},
	"gpt-oss-120b-medium": {
		default: "gpt-oss-120b-medium",
	},
};

export function resolveAntigravityModelId(modelId: string, reasoning: ThinkingLevel | undefined): string {
	const variants = MODEL_VARIANTS[modelId];
	if (!variants) return modelId;
	if (!reasoning) return variants.default;
	if (reasoning === "minimal" || reasoning === "off") return variants.low ?? variants.default;
	if (reasoning === "max") return variants.xhigh ?? variants.high ?? variants.default;
	return variants[reasoning] ?? variants.default;
}

export function antigravitySupportsXhigh(modelId: string): boolean {
	return modelId === "gemini-4-hydrogen";
}

export function antigravityThinkingLevels(modelId: string): ThinkingLevel[] {
	const model = ANTIGRAVITY_MODELS.find((candidate) => candidate.id === modelId);
	return model ? getSupportedThinkingLevels(model) : [];
}

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: ANTIGRAVITY_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
