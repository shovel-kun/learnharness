import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { externalCliEnv } from "../../core/auth-env.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { toClaudeInput, type ClaudeContentBlock } from "../claude-code/transcript.ts";
import { AntigravityError } from "./constants.ts";
import { AntigravityLaunchError, createAntigravityLauncher } from "./launch.ts";
import { resolveAntigravityModelId } from "./provider.ts";
import {
	createAntigravityToolBridge,
	isBridgeMcpToolName,
	toolNameFromMcp,
	type PendingToolCall,
	type ToolBridge,
} from "./tool-bridge.ts";

type RunAntigravityOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type AntigravityChild = ChildProcessWithoutNullStreams | null;
export type RunAntigravity = (args: string[], options: RunAntigravityOptions) => AntigravityChild | Promise<AntigravityChild>;

export type AcpPromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

type AcpUsage = {
	inputTokens?: unknown;
	outputTokens?: unknown;
	cachedReadTokens?: unknown;
	cachedWriteTokens?: unknown;
	thoughtTokens?: unknown;
	totalTokens?: unknown;
};

type AnnouncedToolCall = {
	toolCallId: string;
	name: string;
	arguments: JsonObject;
};

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";
const REFUSAL_MESSAGE = "The model refused to complete the request";
const NO_STOP_REASON_MESSAGE = "agy CLI ended the message without a stop reason";

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	pause_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	cancelled: "aborted",
	refusal: "error",
};

export function toAntigravityArgs(): string[] {
	return [
		"acp",
		"--dangerously-skip-permissions",
		"--include-default-customizations=false",
	];
}

export function toAcpPromptBlocks(blocks: ClaudeContentBlock[]): AcpPromptBlock[] {
	return blocks.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: { type: "image", data: block.source.data, mimeType: block.source.media_type },
	);
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripToolSummary(args: JsonObject): JsonObject {
	if (!("toolSummary" in args)) return args;
	const { toolSummary: _ignored, ...rest } = args;
	return rest as JsonObject;
}

function toolArgumentsMatch(announced: JsonObject, mcpArgs: JsonObject): boolean {
	return isDeepStrictEqual(announced, mcpArgs) || isDeepStrictEqual(stripToolSummary(announced), stripToolSummary(mcpArgs));
}

function nonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isNotSignedInError(code: unknown, message: string): boolean {
	return code === -32000 && /authentication required|not signed in|sign[- ]?in/i.test(message);
}

class AntigravityTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private activeBlockIndex: number | null = null;
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage {
		return this.output;
	}

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0) {
			this.output.cliContextWindow = tokens;
		}
	}

	appendThinking(text: string): void {
		if (this.finished || !text) return;
		this.start();
		const index = this.ensureOpenBlock("thinking");
		const block = this.output.content[index];
		if (!block || block.type !== "thinking") return;
		block.thinking += text;
		this.stream.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: this.output });
	}

	appendText(text: string): void {
		if (this.finished || !text) return;
		this.start();
		const index = this.ensureOpenBlock("text");
		const block = this.output.content[index];
		if (!block || block.type !== "text") return;
		block.text += text;
		this.stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: this.output });
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeActiveBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finish();
	}

	complete(stopReasonRaw: string | undefined, usage: AcpUsage | undefined): void {
		if (this.finished) return;
		this.start();
		this.closeActiveBlock();
		if (usage) this.updateUsage(usage);
		if (!stopReasonRaw) {
			this.fail(NO_STOP_REASON_MESSAGE, "error");
			return;
		}
		const mapped = STOP_REASONS[stopReasonRaw];
		if (!mapped) {
			this.fail(`Unhandled stop reason: ${stopReasonRaw}`, "error");
			return;
		}
		if (mapped === "error") {
			this.fail(REFUSAL_MESSAGE, "error");
			return;
		}
		if (mapped === "aborted") {
			this.fail(ABORT_MESSAGE, "aborted");
			return;
		}
		this.output.stopReason = mapped;
		this.finish();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.closeActiveBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private ensureOpenBlock(kind: "thinking" | "text"): number {
		if (this.activeBlockIndex !== null) {
			const existing = this.output.content[this.activeBlockIndex];
			if (existing?.type === kind) return this.activeBlockIndex;
			this.closeActiveBlock();
		}
		const contentIndex = this.output.content.length;
		if (kind === "thinking") {
			this.output.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
		} else {
			this.output.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex, partial: this.output });
		}
		this.activeBlockIndex = contentIndex;
		return contentIndex;
	}

	private closeActiveBlock(): void {
		if (this.activeBlockIndex === null) return;
		const index = this.activeBlockIndex;
		this.activeBlockIndex = null;
		const block = this.output.content[index];
		if (!block) return;
		if (block.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
		} else if (block.type === "thinking") {
			this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
		}
	}

	private updateUsage(usage: AcpUsage): void {
		const input = nonNegativeInt(usage.inputTokens);
		const textOutput = nonNegativeInt(usage.outputTokens);
		const thoughtTokens = nonNegativeInt(usage.thoughtTokens);
		const cacheRead = nonNegativeInt(usage.cachedReadTokens);
		const cacheWrite = nonNegativeInt(usage.cachedWriteTokens);
		const output = textOutput + thoughtTokens;
		this.output.usage.input = input;
		this.output.usage.output = output;
		if (thoughtTokens > 0) this.output.usage.reasoning = thoughtTokens;
		this.output.usage.cacheRead = cacheRead;
		this.output.usage.cacheWrite = cacheWrite;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	private finish(): void {
		const { stopReason } = this.output;
		if (stopReason === "pending" || stopReason === "error" || stopReason === "aborted") {
			this.fail(this.output.errorMessage ?? NO_STOP_REASON_MESSAGE, "error");
			return;
		}
		this.finished = true;
		this.stream.push({ type: "done", reason: stopReason, message: this.output });
		this.stream.end();
	}
}

type RpcPending = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
};

class AntigravityProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private nextRpcId = 1;
	private readonly pendingRpc = new Map<number, RpcPending>();
	private readonly announcedCalls: AnnouncedToolCall[] = [];
	private readonly seenToolCallIds = new Set<string>();
	private readonly admittedSet = new Set<PendingToolCall>();
	private admitted: PendingToolCall[] = [];
	private pendingError: string | undefined;
	private contextWindow: number | undefined;
	private acpSessionId: string | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly harnessToolNames: ReadonlySet<string>,
		private readonly cwd: string,
		private turn: AntigravityTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {}

	async start(
		systemPrompt: string,
		modelId: string,
		promptBlocks: AcpPromptBlock[],
		signal: AbortSignal | undefined,
	): Promise<void> {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.fail(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => {
			if (!this.stopping && !this.closed) console.error("agy CLI stdin closed early:", error);
		});

		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try {
				this.handleLine(line);
			} catch {
				this.fail("agy CLI emitted malformed stream output");
			}
		});

		this.setSignal(signal);
		if (this.stopping || this.closed) return;

		try {
			await this.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "learnharness", version: "1.0.0" },
			});
			if (this.stopping || this.closed) return;

			const created = await this.request("session/new", {
				cwd: this.cwd,
				mcpServers: [this.bridge.mcpServer],
				_meta: {
					antigravity: {
						disableBuiltInTools: true,
						...(systemPrompt ? { systemPrompt: { append: systemPrompt } } : {}),
					},
				},
			});
			if (this.stopping || this.closed) return;

			const sessionId = isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : "";
			if (!sessionId) {
				this.fail("agy CLI did not return a sessionId");
				return;
			}
			this.acpSessionId = sessionId;

			await this.request("session/set_model", { sessionId, modelId });
			if (this.stopping || this.closed) return;

			const promptResult = await this.request("session/prompt", {
				sessionId,
				prompt: promptBlocks,
			});
			if (this.stopping || this.closed) return;

			const stopReason = isRecord(promptResult) && typeof promptResult.stopReason === "string"
				? promptResult.stopReason
				: undefined;
			const usage = isRecord(promptResult) && isRecord(promptResult.usage)
				? (promptResult.usage as AcpUsage)
				: undefined;

			if (this.turn.finished || this.announcedCalls.length > 0 || this.bridge.getPendingToolCalls().length > 0) {
				this.fail("agy CLI completed while harness tool calls were waiting for results");
				return;
			}
			this.turn.complete(stopReason, usage);
			this.kill();
		} catch (error) {
			if (this.stopping || this.closed) return;
			this.fail(error instanceof Error ? error.message : START_FAILED_MESSAGE);
		}
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && !this.closed && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: AntigravityTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.setSignal(signal);
		if (this.stopping || this.closed) return;
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.admittedSet.delete(call);
			this.bridge.resolveToolCall(call, result);
		}
		this.flushAdmissions();
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		if (this.acpSessionId) {
			try {
				this.writeNotification("session/cancel", { sessionId: this.acpSessionId });
			} catch {
				// Best-effort cancellation notification before closing process.
			}
		}
		this.rejectPendingRpc(new Error(ABORT_MESSAGE));
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this);
	}

	consumeFailure(owner: symbol, turn: AntigravityTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: PendingToolCall): void {
		this.admittedSet.delete(call);
		if (call.id) {
			const index = this.announcedCalls.findIndex((candidate) => candidate.toolCallId === call.id);
			if (index >= 0) this.announcedCalls.splice(index, 1);
		}
	}

	flushAdmissions(): void {
		if (this.stopping || this.closed || this.turn.finished) return;
		const pending = this.bridge.getPendingToolCalls().filter((call) => !this.admittedSet.has(call));
		if (pending.length === 0 || this.announcedCalls.length === 0) return;

		const mcpCall = pending[0]!;
		const announced = this.announcedCalls[0]!;
		if (announced.name !== mcpCall.name || !toolArgumentsMatch(announced.arguments, mcpCall.arguments)) {
			this.fail("agy CLI compatibility error: MCP call does not match its streamed tool intent");
			return;
		}

		this.announcedCalls.shift();
		mcpCall.id = announced.toolCallId;
		this.admittedSet.add(mcpCall);
		this.admitted = [mcpCall];
		this.toolCallIds = [announced.toolCallId];
		this.turn.admit([{ type: "toolCall", id: announced.toolCallId, name: mcpCall.name, arguments: mcpCall.arguments }]);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill();
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextRpcId++;
		return new Promise((resolve, reject) => {
			this.pendingRpc.set(id, { resolve, reject });
			try {
				this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			} catch (error) {
				this.pendingRpc.delete(id);
				reject(error instanceof Error ? error : new Error(START_FAILED_MESSAGE));
			}
		});
	}

	private writeNotification(method: string, params: unknown): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private rejectPendingRpc(error: Error): void {
		for (const waiter of this.pendingRpc.values()) waiter.reject(error);
		this.pendingRpc.clear();
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) {
			this.fail("agy CLI emitted invalid JSON-RPC message");
			return;
		}

		// JSON-RPC response to an outbound request
		if (typeof parsed.id === "number" && ("result" in parsed || "error" in parsed)) {
			const waiter = this.pendingRpc.get(parsed.id);
			if (!waiter) return;
			this.pendingRpc.delete(parsed.id);
			if (isRecord(parsed.error)) {
				const rawMessage = typeof parsed.error.message === "string" ? parsed.error.message : "agy CLI JSON-RPC error";
				const message = isNotSignedInError(parsed.error.code, rawMessage) ? AntigravityError.NotSignedIn : rawMessage;
				this.fail(message);
				waiter.reject(new Error(message));
			} else {
				waiter.resolve(parsed.result);
			}
			return;
		}

		if (parsed.method === "session/update" && isRecord(parsed.params)) {
			const update = isRecord(parsed.params.update) ? parsed.params.update : null;
			if (update) this.handleSessionUpdate(update);
			return;
		}
	}

	private handleSessionUpdate(update: Record<string, unknown>): void {
		const kind = update.sessionUpdate;
		if (kind === "usage_update") {
			if (typeof update.size === "number" && Number.isSafeInteger(update.size) && update.size > 0) {
				this.contextWindow = update.size;
				this.turn.setContextWindow(update.size);
			}
			return;
		}

		if (kind === "tool_call_update") return;

		if (kind === "agent_thought_chunk") {
			if (this.turn.finished) {
				this.fail("agy CLI moved on while harness tool calls were waiting for results");
				return;
			}
			const content = isRecord(update.content) ? update.content : null;
			if (content?.type === "text" && typeof content.text === "string") {
				this.turn.appendThinking(content.text);
			}
			return;
		}

		if (kind === "agent_message_chunk") {
			if (this.turn.finished) {
				this.fail("agy CLI moved on while harness tool calls were waiting for results");
				return;
			}
			const content = isRecord(update.content) ? update.content : null;
			if (content?.type === "text" && typeof content.text === "string") {
				this.turn.appendText(content.text);
			}
			return;
		}

		if (kind === "tool_call") {
			const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
			if (!toolCallId) {
				this.fail("agy CLI emitted an invalid tool call");
				return;
			}
			if (this.seenToolCallIds.has(toolCallId)) return;
			const rawName = typeof update.name === "string" ? update.name : "";
			if (!rawName) {
				this.fail("agy CLI emitted an invalid tool call");
				return;
			}
			if (!isBridgeMcpToolName(rawName)) {
				if (this.harnessToolNames.has(rawName)) return;
				this.fail("agy CLI emitted an unsupported native tool call");
				return;
			}
			this.seenToolCallIds.add(toolCallId);
			const rawArgs = isRecord(update.args)
				? update.args
				: isRecord(update.rawInput)
					? update.rawInput
					: {};
			this.announcedCalls.push({
				toolCallId,
				name: toolNameFromMcp(rawName),
				arguments: rawArgs as JsonObject,
			});
			this.flushAdmissions();
		}
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		this.rejectPendingRpc(new Error(message));
		if (this.stderr.trim()) console.error("agy CLI stderr:", this.stderr.trim());
		this.turn.fail(message, "error");
		Promise.all([
			this.bridge.close(),
			rm(this.cwd, { recursive: true, force: true }),
		]).catch((error: unknown) => {
			console.error("agy CLI cleanup failed:", error);
		});
	}
}

function continueLiveProcess(
	turn: AntigravityTurn,
	owner: symbol,
	sessionId: string | undefined,
	configuration: unknown,
	messages: Message[],
	signal: AbortSignal | undefined,
): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AntigravityProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(
	runAntigravity: RunAntigravity,
	turn: AntigravityTurn,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	resolvedModelId: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		return;
	}
	const input = toClaudeInput(context.messages);
	let cliProcess: AntigravityProcess | undefined;
	const bridge = await createAntigravityToolBridge(input.tools, {
		onCall: () => cliProcess?.flushAdmissions(),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.cancelCall(call),
	});

	let cwd: string;
	try {
		cwd = await mkdtemp(join(tmpdir(), "learnharness-agy-"));
	} catch (error) {
		await bridge.close();
		throw error;
	}

	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await Promise.all([bridge.close(), rm(cwd, { recursive: true, force: true })]);
		return;
	}

	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = await runAntigravity(toAntigravityArgs(), { cwd, env, signal: options?.signal });
	} catch (error) {
		await Promise.all([bridge.close(), rm(cwd, { recursive: true, force: true })]);
		throw error;
	}

	if (!child) {
		turn.fail(AntigravityError.CliNotFound, "error");
		await Promise.all([bridge.close(), rm(cwd, { recursive: true, force: true })]);
		return;
	}

	cliProcess = new AntigravityProcess(
		child,
		bridge,
		new Set(input.tools.map((tool) => tool.name)),
		cwd,
		turn,
		owner,
		options?.sessionId,
		configuration,
		structuredClone(conversationForReuse(context.messages)),
	);
	void cliProcess.start(
		input.systemPrompt,
		resolvedModelId,
		toAcpPromptBlocks(input.userContent),
		options?.signal,
	);
}

export function createAntigravityStreamFunction(runAntigravity: RunAntigravity): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AntigravityTurn(stream, model);

		const env = externalCliEnv();
		const resolvedModelId = resolveAntigravityModelId(model.id, options?.reasoning);
		// Ensure configuration & env match so live reuse never spans changed settings.
		const configuration = {
			request: configurationForReuse(model, context, resolvedModelId),
			tools: getCurrentTools(context.messages).map((tool) => tool.name),
			env,
		};
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) {
			return stream;
		}

		startProcess(
			runAntigravity,
			turn,
			context,
			options,
			owner,
			configuration,
			resolvedModelId,
			env,
		).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			turn.fail(
				options?.signal?.aborted
					? ABORT_MESSAGE
					: error instanceof AntigravityLaunchError
						? error.message
						: START_FAILED_MESSAGE,
				options?.signal?.aborted ? "aborted" : "error",
			);
		});

		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction(createAntigravityLauncher());
