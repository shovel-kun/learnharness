import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AntigravityInstallationStatus, antigravityStatusLabel } from "../components/settings/antigravity-status.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityStatus } from "../src/core/contracts/antigravity.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: AntigravityStatus["state"], version: string | null = null): AntigravityStatus => ({
	state,
	version,
	minimumVersion: ANTIGRAVITY_MINIMUM_VERSION,
});
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;

function fixture(probe: (init?: RequestInit) => Promise<Response>, enabled = true, failSave = false) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, antigravity: { enabled: on } } });
		if (url === "/api/settings/antigravity") {
			assert.equal(init?.method, "PUT");
			assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
			if (failSave) return new Response(null, { status: 500 });
			on = JSON.parse(String(init.body)).enabled;
			return Response.json({ settings: { version: 1, antigravity: { enabled: on } } });
		}
		if (url === "/api/models") return Response.json({ models: on ? [{ provider: "antigravity", id: "gemini-4-argon" }] : [] });
		assert.equal(url, "/api/antigravity");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
		return probe(init);
	}) as typeof fetch;
	return calls;
}

async function mount(extra?: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<><AntigravityInstallationStatus />{extra}</>));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

test("initial render is collapsed and off", () => {
	const html = renderToStaticMarkup(<AntigravityInstallationStatus />);
	assert.match(html, /Antigravity/);
	assert.match(html, /aria-checked="false"/);
	assert.equal((html.match(/<button/g) ?? []).length, 1);
	assert(!html.includes("Check again"));
});

test("off by default; enabling persists before probing and reveals version/setup info", async () => {
	const calls = fixture(async () => Response.json(status("not-found")), false);
	await mount();
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert(!button());
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "true");
	assert.equal(label(), "Not found");
	assert(calls.indexOf("PUT /api/settings/antigravity") < calls.indexOf("GET /api/antigravity"));
	assert.equal(document.querySelector("a")?.getAttribute("href"), "https://antigravity.google/docs/cli/acp/");
	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert(!button());
});

for (const [value, text] of [
	[status("not-found"), "Not found"],
	[status("meets-minimum", "1.5.8"), "Version 1.5.8 · meets minimum"],
	[status("update-required", "1.5.7"), "Version 1.5.7 · update required"],
	[status("version-unchecked"), "Version could not be checked"],
] as const) {
	test(`installation display: ${text}`, () => assert.equal(antigravityStatusLabel(value), text));
}

function CatalogReader() {
	const { catalog } = useModelCatalog();
	return <span data-testid="agy-catalog-models">{catalog?.models.map((m) => `${m.provider}:${m.id}`).join(",") ?? "loading"}</span>;
}

test("persisted toggle updates invalidate shared model availability", async () => {
	fixture(async () => Response.json(status("not-found")), false);
	await mount(<CatalogReader />);
	const models = () => document.querySelector('[data-testid="agy-catalog-models"]')?.textContent;
	assert.equal(models(), "");
	await act(async () => toggle().click());
	assert.equal(models(), "antigravity:gemini-4-argon");
	await act(async () => toggle().click());
	assert.equal(models(), "");
});
