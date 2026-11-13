import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

import {
	createModels,
	getSupportedThinkingLevels,
	type AssistantMessage,
	type Context,
	type Message,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import type { RunAntigravity } from "../src/agent/antigravity/stream.ts";

const testData = mkdtempSync(join(tmpdir(), "lh-antigravity-test-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));

const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { ANTIGRAVITY_MINIMUM_VERSION, ANTIGRAVITY_PROVIDER, sanitizeUserSettings, cliContextWindowOf, providerKeyMissing } = await import("../src/core/index.ts");
const { resolveAntigravityBinary } = await import("../src/agent/antigravity/binary.ts");
const { AntigravityError } = await import("../src/agent/antigravity/constants.ts");
const { inspectAntigravityInstallation } = await import("../src/agent/antigravity/installation.ts");
const { ANTIGRAVITY_MODELS, antigravitySupportsXhigh, antigravityThinkingLevels, createAntigravityProvider, resolveAntigravityModelId } = await import("../src/agent/antigravity/provider.ts");
const { createAntigravityStreamFunction, toAcpPromptBlocks, toAntigravityArgs } = await import("../src/agent/antigravity/stream.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { antigravityAvailable, antigravityEnabled } = await import("../src/server/antigravity-config.ts");
const { ANTIGRAVITY_STATUS_HEADER, antigravityInstallationResponse } = await import("../src/server/antigravity.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { catalogContextLimits, modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { sessionCost } = await import("../src/server/pricing.ts");
const { parseAntigravitySettingsBody } = await import("../src/server/settings-body.ts");

function setupCliEnv(t: TestContext) {
	const previous = readSettings();
	const savedPath = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "antigravity-opt-in-"));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}

async function saveAntigravity(body: unknown) {
	return PUT(
		new Request("http://test/api/settings/antigravity", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ section: "antigravity" }) },
	);
}

test("resolveAntigravityBinary searches PATH and platform fallback directories", () => {
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "/custom/bin:/usr/bin" },
			platform: "linux",
			homeDir: "/home/alice",
			isExecutable: (p) => p === "/custom/bin/agy",
		}),
		"/custom/bin/agy",
	);
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "" },
			platform: "linux",
			homeDir: "/home/alice",
			isExecutable: (p) => p === "/home/alice/.local/bin/agy",
		}),
		"/home/alice/.local/bin/agy",
	);
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
			platform: "win32",
			homeDir: "C:\\Users\\alice",
			isExecutable: (p) => p === "C:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe",
		}),
		"C:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe",
	);
});

test("inspectAntigravityInstallation classifies version states against 1.5.8 minimum", async () => {
	assert.deepEqual(
		await inspectAntigravityInstallation(() => null),
		{ state: "not-found", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/usr/local/bin/agy", async () => "1.5.8\n"),
		{ state: "meets-minimum", version: "1.5.8", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/usr/local/bin/agy", async () => "v1.6.2"),
		{ state: "meets-minimum", version: "1.6.2", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/usr/local/bin/agy", async () => "1.5.7"),
		{ state: "update-required", version: "1.5.7", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/usr/local/bin/agy", async () => "unexpected output"),
		{ state: "version-unchecked", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/usr/local/bin/agy", async () => { throw new Error("boom"); }),
		{ state: "version-unchecked", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
});

test("Antigravity provider registers 7 model families, zero costs, and thinking variant resolution", async () => {
	const collection = createModels();
	collection.setProvider(createAntigravityProvider((() => {
		throw new Error("unused");
	}) as never));

	const models = collection.getModels(ANTIGRAVITY_PROVIDER);
	assert.deepEqual(
		models.map((m) => m.id),
		[
			"gemini-4-argon",
			"gemini-4-hydrogen",
			"gemini-pro-orchestrator-g1-pro",
			"gemini-3.8-flash",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"gpt-oss-120b-medium",
		],
	);
	for (const model of models) {
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(getSupportedThinkingLevels(model), antigravityThinkingLevels(model.id));
	}

	assert.deepEqual(antigravityThinkingLevels("gemini-4-argon"), ["low", "medium", "high"]);
	assert.deepEqual(antigravityThinkingLevels("gemini-4-hydrogen"), ["low", "medium", "high", "xhigh"]);
	assert.deepEqual(antigravityThinkingLevels("gemini-pro-orchestrator-g1-pro"), ["medium"]);
	assert.deepEqual(antigravityThinkingLevels("gpt-oss-120b-medium"), ["medium"]);
	assert.equal(antigravitySupportsXhigh("gemini-4-hydrogen"), true);
	assert.equal(antigravitySupportsXhigh("gemini-4-argon"), false);

	assert.equal(resolveAntigravityModelId("gemini-4-argon", "high"), "gemini-4-argon-high");
	assert.equal(resolveAntigravityModelId("gemini-4-hydrogen", "xhigh"), "gemini-4-hydrogen-xhigh");
	assert.equal(resolveAntigravityModelId("gemini-pro-orchestrator-g1-pro", "high"), "gemini-pro-orchestrator-g1-pro");
	assert.equal(resolveAntigravityModelId("claude-opus-5-5", "low"), "claude-opus-5-5-low");
	assert.equal(resolveAntigravityModelId("claude-sonnet-5-5", undefined), "claude-sonnet-5-5-medium");
	assert.equal(resolveAntigravityModelId("gpt-oss-120b-medium", "low"), "gpt-oss-120b-medium");
	assert.ok(await collection.checkAuth(ANTIGRAVITY_PROVIDER));
	assert.equal((await collection.getAvailable(ANTIGRAVITY_PROVIDER)).length, 7);
});

test("opt-in, catalog gating, pricing, and HTTP status security boundaries", async (t) => {
	setupCliEnv(t);

	assert.deepEqual(parseAntigravitySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, extra: 1 }), { ok: true, settings: { enabled: true } });
	assert.equal(parseAntigravitySettingsBody({ enabled: "yes" }).ok, false);
	assert.notEqual(sanitizeUserSettings({ version: 1, antigravity: { enabled: "yes" } })?.antigravity?.enabled, true);

	assert.equal(antigravityEnabled(), false);
	assert.equal(antigravityAvailable(), false);
	assert.equal(providerKeyPresent(ANTIGRAVITY_PROVIDER), false);
	assert.match(providerKeyMissing(ANTIGRAVITY_PROVIDER, ["strong"]).error, /Enable and set it up in Settings/);
	assert(!modelCatalog().models.some((m) => m.provider === ANTIGRAVITY_PROVIDER));

	assert.equal((await saveAntigravity({ enabled: true })).status, 200);
	assert.equal(antigravityEnabled(), true);
	assert.equal(antigravityAvailable(), true);
	assert.equal(providerKeyPresent(ANTIGRAVITY_PROVIDER), true);

	const catalog = modelCatalog();
	const catalogEntries = catalog.models.filter((m) => m.provider === ANTIGRAVITY_PROVIDER);
	assert.equal(catalogEntries.length, 7);
	for (const entry of catalogEntries) {
		assert.equal(entry.cost, null);
		assert.equal(entry.contextWindow, null);
		assert.equal(entry.maxTokens, null);
	}
	assert.equal(catalogContextLimits().has(`${ANTIGRAVITY_PROVIDER}:gemini-4-argon`), false);

	const models = { strong: { model: { provider: ANTIGRAVITY_PROVIDER, id: "gemini-4-argon" } } };
	assert.equal((await saveAntigravity({ enabled: false })).status, 200);
	assert.equal(validateModelsSettings(models, models).ok, true);

	const pricing = sessionCost({
		turns: [
			{
				id: "t1",
				messageId: "m1",
				at: "2026-01-01T00:00:00.000Z",
				model: `${ANTIGRAVITY_PROVIDER}:gemini-4-argon`,
				steps: [{ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: undefined }],
			},
		],
	});
	assert.equal(pricing.unpriced, 1);
	assert.equal(pricing.cost, 0);
	assert.equal(pricing.turnCosts.t1, null);

	// Security boundaries on GET /api/antigravity
	const disabledRes = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity", { headers: { [ANTIGRAVITY_STATUS_HEADER]: "1" } }),
		async () => assert.fail("disabled CLI must not probe"),
	);
	assert.equal(disabledRes.status, 403);

	const noHeaderRes = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity"),
		async () => assert.fail("missing header must not probe"),
		() => true,
	);
	assert.equal(noHeaderRes.status, 403);

	const crossSiteRes = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity", {
			headers: { [ANTIGRAVITY_STATUS_HEADER]: "1", origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" },
		}),
		async () => assert.fail("cross-site must not probe"),
		() => true,
	);
	assert.equal(crossSiteRes.status, 403);

	const okRes = await antigravityInstallationResponse(
		new Request("http://localhost:3000/api/antigravity", { headers: { [ANTIGRAVITY_STATUS_HEADER]: "1" } }),
		async () => ({ state: "meets-minimum" as const, version: "1.5.8", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION }),
		() => true,
	);
	assert.equal(okRes.status, 200);
	assert.equal(okRes.headers.get("cache-control"), "no-store");
});

const FAKE_ACP_AUTH_ERROR_SCRIPT = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (req.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "Authentication required" } }) + "\\n");
  }
});
`;

const FAKE_ACP_TOOL_LOOP_SCRIPT = `
import { createInterface } from "node:readline";
let mcpConfig;
let sessionId = "acp-sess-1";
const log = [];

async function mcpPost(authorization, body) {
  const res = await fetch(mcpConfig.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: authorization,
      ...(mcpConfig.sessionHeader ? { "mcp-session-id": mcpConfig.sessionHeader } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpConfig.sessionHeader = sid;
  const text = await res.text();
  if (!text) return null;
  if (text.includes("data: ")) {
    const dataLine = text.split("\\n").find((l) => l.startsWith("data: "));
    return dataLine ? JSON.parse(dataLine.slice(6)) : null;
  }
  return JSON.parse(text);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const req = JSON.parse(line);
  log.push({ method: req.method, params: req.params });
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (req.method === "session/new") {
    const server = req.params.mcpServers[0];
    const authHeader = server.headers.find((h) => h.name === "Authorization").value;
    mcpConfig = { url: server.url, authHeader, sessionHeader: null };
    const init = await mcpPost(authHeader, { jsonrpc: "2.0", id: 100, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agy", version: "1.5.8" } } });
    await mcpPost(authHeader, { jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await mcpPost(authHeader, { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} });
    log.push({ mcpTools: list.result.tools.map((t) => t.name), initOk: Boolean(init.result) });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { sessionId } }) + "\\n");
  } else if (req.method === "session/set_model") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
  } else if (req.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "usage_update", used: 10, size: 1048576 } },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } } },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "agy-bare-1",
          name: "echo",
          args: { text: "ping" },
          status: "in_progress",
        },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "agy-call-1",
          name: "mcp_learnharness_echo",
          args: { text: "ping", toolSummary: "Echo ping" },
          status: "in_progress",
        },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "agy-call-1",
          name: "mcp_learnharness_echo",
          args: { text: "ping", toolSummary: "Echo ping" },
          status: "completed",
        },
      },
    }) + "\\n");
    const toolRes = await mcpPost(mcpConfig.authHeader, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "ping" } },
    });
    const returnedText = toolRes.result.content[0].text;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Echoed: " + returnedText } } },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 120, outputTokens: 30, thoughtTokens: 15, cachedReadTokens: 40, cachedWriteTokens: 5, totalTokens: 210 },
      },
    }) + "\\n");
  }
});
`;

async function drainResult(stream: ReturnType<ReturnType<typeof createAntigravityStreamFunction>>): Promise<AssistantMessage> {
	for await (const _ of stream) {
		// consume all stream events
	}
	return await stream.result();
}

test("toAntigravityArgs and toAcpPromptBlocks map inputs cleanly", () => {
	assert.deepEqual(toAntigravityArgs(), [
		"acp",
		"--dangerously-skip-permissions",
		"--include-default-customizations=false",
	]);
	assert.deepEqual(
		toAcpPromptBlocks([
			{ type: "text", text: "hello" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "Zm9v" } },
		]),
		[
			{ type: "text", text: "hello" },
			{ type: "image", data: "Zm9v", mimeType: "image/png" },
		],
	);
});

test("streamAntigravity maps -32000 Authentication required to NotSignedIn", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agy-auth-fail-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "fake-agy.mjs");
	writeFileSync(script, FAKE_ACP_AUTH_ERROR_SCRIPT);

	const runAntigravity: RunAntigravity = (_args, options) => {
		const child = spawn(process.execPath, [script], { cwd: options.cwd, env: options.env, stdio: "pipe" });
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
	const streamFn = createAntigravityStreamFunction(runAntigravity);
	const model = ANTIGRAVITY_MODELS[0]!;
	const context: TranscriptContext = normalizeContext({
		systemPrompt: "Be helpful",
		messages: [{ role: "user", content: "Hi", timestamp: 1 }],
	});
	const result = await drainResult(streamFn(model, context, { reasoning: "high" }));
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, AntigravityError.NotSignedIn);
});

test("streamAntigravity runs ACP handshake, MCP tool bridge, live continuation, and usage/context accounting", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agy-tool-loop-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "fake-agy-loop.mjs");
	writeFileSync(script, FAKE_ACP_TOOL_LOOP_SCRIPT);

	let spawns = 0;
	const runAntigravity: RunAntigravity = (args, options) => {
		spawns++;
		assert.deepEqual(args, toAntigravityArgs());
		const child = spawn(process.execPath, [script], { cwd: options.cwd, env: options.env, stdio: "pipe" });
		t.after(() => child.kill("SIGKILL"));
		return child;
	};

	const streamFn = createAntigravityStreamFunction(runAntigravity);
	const model = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-hydrogen")!;
	const echoTool: Tool = {
		name: "echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
	};
	const baseContext: Context = {
		systemPrompt: "Tutor prompt",
		tools: [echoTool],
		messages: [{ role: "user", content: "Say ping", timestamp: 1 }],
	};
	const sessionId = "agy-live-session-1";

	// Step 1: receives thinking, usage_update, and admits MCP tool call
	const firstMessage = await drainResult(streamFn(model, normalizeContext(baseContext), { reasoning: "xhigh", sessionId }));
	assert.equal(spawns, 1);
	assert.equal(firstMessage.stopReason, "toolUse");
	assert.equal((firstMessage as AssistantMessage & { cliContextWindow?: number }).cliContextWindow, 1048576);
	const thinkingBlock = firstMessage.content.find((b): b is ThinkingContent => b.type === "thinking");
	assert.equal(thinkingBlock?.thinking, "Thinking...");
	const toolCall = firstMessage.content.find((b): b is ToolCall => b.type === "toolCall");
	assert.deepEqual(toolCall, {
		type: "toolCall",
		id: "agy-call-1",
		name: "echo",
		arguments: { text: "ping" },
	});

	// Step 2: continuation reuses the live ACP process without spawning a second child
	const messagesStep2: Message[] = [
		...baseContext.messages,
		firstMessage,
		{
			role: "toolResult",
			toolCallId: "agy-call-1",
			toolName: "echo",
			content: [{ type: "text", text: "pong" }],
			isError: false,
			timestamp: 2,
		},
	];
	const secondMessage = await drainResult(streamFn(
		model,
		normalizeContext({ ...baseContext, messages: messagesStep2 }),
		{ reasoning: "xhigh", sessionId },
	));
	assert.equal(spawns, 1, "continuation must keep the same agy acp process alive");
	assert.equal(secondMessage.stopReason, "stop");
	const textBlock = secondMessage.content.find((b): b is TextContent => b.type === "text");
	assert.equal(textBlock?.text, "Echoed: pong");
	assert.deepEqual(secondMessage.usage, {
		input: 120,
		output: 45,
		reasoning: 15,
		cacheRead: 40,
		cacheWrite: 5,
		totalTokens: 210,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.deepEqual(
		cliContextWindowOf([{ ...(secondMessage as AssistantMessage), id: "msg-2" }]),
		{ model: "antigravity:gemini-4-hydrogen", tokens: 1048576 },
	);
});
