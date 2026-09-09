import type { OtelExporterConfig } from "./config.ts";
import type { OtelIdentity } from "./identity.ts";

export interface StandardAttributeInput {
	config: OtelExporterConfig;
	sessionId: string;
	appVersion: string;
	entrypoint: string;
	identity: OtelIdentity;
	terminalType: string | undefined;
	organizationId?: string | undefined;
}

export interface StandardAttributes {
	/** Metric datapoint attributes, filtered by the `OTEL_METRICS_INCLUDE_*` cardinality controls. */
	metrics: Record<string, unknown>;
	/** Event attributes, which always carry the full standard set. */
	events: Record<string, unknown>;
}

/** Build the Claude Code standard attribute sets for metrics and events. */
export function buildStandardAttributes(input: StandardAttributeInput): StandardAttributes {
	const { config, identity } = input;
	const shared: Record<string, unknown> = {
		"user.id": identity.userId,
		...(identity.email ? { "user.email": identity.email } : {}),
		...(input.terminalType ? { "terminal.type": input.terminalType } : {}),
		...(input.organizationId ? { "organization.id": input.organizationId } : {}),
	};

	const events: Record<string, unknown> = {
		"session.id": input.sessionId,
		"app.version": input.appVersion,
		"app.entrypoint": input.entrypoint,
		...shared,
		...(identity.accountUuid
			? { "user.account_uuid": identity.accountUuid, "user.account_id": identity.accountUuid }
			: {}),
		...config.resourceAttributes,
	};

	const metrics: Record<string, unknown> = {
		...(config.include.sessionId ? { "session.id": input.sessionId } : {}),
		...(config.include.version ? { "app.version": input.appVersion } : {}),
		...(config.include.entrypoint ? { "app.entrypoint": input.entrypoint } : {}),
		...shared,
		...(config.include.accountUuid && identity.accountUuid
			? { "user.account_uuid": identity.accountUuid, "user.account_id": identity.accountUuid }
			: {}),
		...(config.include.resourceAttributes ? config.resourceAttributes : {}),
	};

	return { metrics, events };
}
