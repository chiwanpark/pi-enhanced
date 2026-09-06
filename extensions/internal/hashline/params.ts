function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function normalizeEdit(entry: unknown): unknown {
	const edit = asRecord(entry);
	if (!edit) return entry;
	const next: Record<string, unknown> = { ...edit };
	for (const key of ["from", "to"]) {
		const value = next[key];
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
			next[key] = Number(value);
		}
	}
	if (typeof next.lines === "string") next.lines = next.lines.split("\n");
	if (typeof next.op === "string") next.op = next.op.trim().toLowerCase();
	return next;
}

export function prepareEditArguments(args: unknown): unknown {
	const input = asRecord(args);
	if (!input) return args;
	const normalized: Record<string, unknown> = { ...input };

	if (typeof normalized.file_path === "string" && typeof normalized.path !== "string") {
		normalized.path = normalized.file_path;
	}
	delete normalized.file_path;

	if (typeof normalized.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(normalized.edits);
			if (Array.isArray(parsed)) normalized.edits = parsed;
		} catch {
			return normalized;
		}
	}
	if (typeof normalized.tag === "string")
		normalized.tag = normalized.tag
			.trim()
			.replace(/^\[|\]$/g, "")
			.toUpperCase();
	if (Array.isArray(normalized.edits)) normalized.edits = normalized.edits.map(normalizeEdit);
	return normalized;
}
