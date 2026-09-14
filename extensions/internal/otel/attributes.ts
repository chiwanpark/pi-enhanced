import type { OtelExporterConfig } from "./config.ts";
import { taggedAccountId, type OtelIdentity } from "./identity.ts";

export interface StandardAttributeInput {
	config: OtelExporterConfig;
	sessionId: string;
	appVersion: string;
	entrypoint: string;
	identity: OtelIdentity;
	terminalType: string | undefined;
	organizationId?: string | undefined;
}

/** Build the Claude Code standard attribute sets for metrics and events. */
export function buildStandardAttributes(input: StandardAttributeInput): Record<string, unknown> {
	const { config, identity } = input;
	return {
		...(config.include.resourceAttributes ? config.resourceAttributes : {}),
		"user.id": identity.userId,
		...(config.include.sessionId ? { "session.id": input.sessionId } : {}),
		...(config.include.version ? { "app.version": input.appVersion } : {}),
		...(config.include.entrypoint ? { "app.entrypoint": input.entrypoint } : {}),
		...(input.organizationId ? { "organization.id": input.organizationId } : {}),
		...(identity.email ? { "user.email": identity.email } : {}),
		...(config.include.accountUuid && identity.accountUuid
			? { "user.account_uuid": identity.accountUuid, "user.account_id": taggedAccountId(identity.accountUuid) }
			: {}),
		...(input.terminalType ? { "terminal.type": input.terminalType } : {}),
	};
}
