export const ANTIGRAVITY_PROVIDER = "antigravity";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export type AntigravityInstallState =
	| "not-found"
	| "meets-minimum"
	| "update-required"
	| "version-unchecked";

export interface AntigravityStatus {
	state: AntigravityInstallState;
	version: string | null;
	minimumVersion: string;
}

/** First version of agy verified with ACP + HTTP MCP bridge support. */
export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.8";
