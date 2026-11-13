import { spawn } from "node:child_process";
import { getAntigravityBinary } from "./binary.ts";
import { inspectAntigravityInstallation, readAntigravityVersion, type ReadAntigravityVersion } from "./installation.ts";
import type { RunAntigravity } from "./stream.ts";

export class AntigravityLaunchError extends Error {}

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createAntigravityLauncher({
	findBinary = getAntigravityBinary,
	readVersion = readAntigravityVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadAntigravityVersion;
	spawnProcess?: typeof spawn;
} = {}): RunAntigravity {
	return async (args, options) => {
		if (options.signal?.aborted) throw new AntigravityLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		const status = await inspectAntigravityInstallation(() => binary, readVersion);
		if (status.state === "update-required") {
			throw new AntigravityLaunchError(`Antigravity CLI ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update Antigravity CLI outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new AntigravityLaunchError("Antigravity CLI's version could not be checked. Check your installation outside LearnHarness and try again.");
		}
		if (options.signal?.aborted) throw new AntigravityLaunchError("Request was aborted");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
	};
}
