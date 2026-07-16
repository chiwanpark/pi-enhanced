import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const TODO_WIDGET_ID = "pi-enhanced-todos";
const TODO_TOOL_NAME = "write_todos";
const TODO_WIDGET_PADDING_X = 1;

const TodoStatus = StringEnum(["pending", "in_progress", "completed"] as const);
const TodoPriority = StringEnum(["high", "medium", "low"] as const);

const TodoItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable unique ID for this TODO item" })),
	content: Type.String({ description: "TODO item text" }),
	status: TodoStatus,
	priority: TodoPriority,
});

const WriteTodosParams = Type.Object({
	todos: Type.Array(TodoItemSchema, {
		description:
			"Complete TODO list. Always include every current item; omitted items are removed from the visible TODO list.",
	}),
});

type WriteTodosInput = Static<typeof WriteTodosParams>;
type TodoInput = WriteTodosInput["todos"][number];

type TodoStatusValue = "pending" | "in_progress" | "completed";
type TodoPriorityValue = "high" | "medium" | "low";

type TodoItem = {
	id: string;
	content: string;
	status: TodoStatusValue;
	priority: TodoPriorityValue;
};

type TodoDetails = {
	todos: TodoItem[];
	nextId: number;
	stats: {
		total: number;
		pending: number;
		inProgress: number;
		completed: number;
	};
};

function todoStats(todos: TodoItem[]): TodoDetails["stats"] {
	return {
		total: todos.length,
		pending: todos.filter((todo) => todo.status === "pending").length,
		inProgress: todos.filter((todo) => todo.status === "in_progress").length,
		completed: todos.filter((todo) => todo.status === "completed").length,
	};
}

function statusIcon(status: TodoStatusValue): string {
	switch (status) {
		case "completed":
			return "✓";
		case "in_progress":
			return "◐";
		case "pending":
			return "○";
	}
}

function priorityRank(priority: TodoPriorityValue): number {
	switch (priority) {
		case "high":
			return 0;
		case "medium":
			return 1;
		case "low":
			return 2;
	}
}

function nextGeneratedId(nextId: number, usedIds: Set<string>): { id: string; nextId: number } {
	let candidate = `todo-${nextId}`;
	let next = nextId + 1;
	while (usedIds.has(candidate)) {
		candidate = `todo-${next}`;
		next += 1;
	}
	return { id: candidate, nextId: next };
}

function normalizeTodos(inputTodos: TodoInput[], previousNextId: number): { todos: TodoItem[]; nextId: number } {
	let nextId = previousNextId;
	const usedIds = new Set<string>();
	const todos: TodoItem[] = [];

	for (const input of inputTodos) {
		const content = input.content.trim();
		if (!content) continue;

		let id = input.id?.trim();
		if (!id || usedIds.has(id)) {
			const generated = nextGeneratedId(nextId, usedIds);
			id = generated.id;
			nextId = generated.nextId;
		}
		usedIds.add(id);

		todos.push({
			id,
			content,
			status: input.status,
			priority: input.priority,
		});
	}

	return { todos, nextId };
}

function formatToolText(todos: TodoItem[]): string {
	if (todos.length === 0) return "TODO list is empty.";

	const stats = todoStats(todos);
	const lines = [`${stats.completed}/${stats.total} TODOs completed`];
	for (const todo of todos) {
		lines.push(`[${statusIcon(todo.status)}] (${todo.priority}) ${todo.content}`);
	}
	return lines.join("\n");
}

function updateTodoWidget(ctx: ExtensionContext, todos: TodoItem[], visible = true): void {
	if (ctx.mode !== "tui") return;

	if (!visible || todos.length === 0) {
		ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
		return;
	}

	const snapshot = todos.map((todo) => ({ ...todo }));
	ctx.ui.setWidget(TODO_WIDGET_ID, (_tui, theme) => ({
		render(width: number): string[] {
			const contentWidth = Math.max(1, width - TODO_WIDGET_PADDING_X * 2);
			const padding = " ".repeat(TODO_WIDGET_PADDING_X);
			const stats = todoStats(snapshot);
			const activeTodos = snapshot
				.filter((todo) => todo.status !== "completed")
				.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
			const completedTodos = snapshot.filter((todo) => todo.status === "completed");
			const visibleTodos = [...activeTodos, ...completedTodos].slice(0, 8);

			const lines = [
				truncateToWidth(
					`${theme.fg("accent", theme.bold("TODO"))} ${theme.fg("dim", `${stats.completed}/${stats.total} done`)}`,
					contentWidth,
				),
			];

			for (const todo of visibleTodos) {
				const iconColor = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "warning" : "dim";
				const priorityColor = todo.priority === "high" ? "error" : todo.priority === "medium" ? "warning" : "dim";
				const contentColor = todo.status === "completed" ? "dim" : "text";
				const line = `${theme.fg(iconColor, statusIcon(todo.status))} ${theme.fg(priorityColor, todo.priority[0]?.toUpperCase() ?? "?")} ${theme.fg(contentColor, todo.content)}`;
				lines.push(truncateToWidth(line, contentWidth, theme.fg("dim", "…")));
			}

			if (snapshot.length > visibleTodos.length) {
				lines.push(truncateToWidth(theme.fg("dim", `… ${snapshot.length - visibleTodos.length} more`), contentWidth));
			}

			return lines.map((line) => `${padding}${line}${padding}`);
		},
		invalidate() {},
	}));
}

export default function todoExtension(pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let nextId = 1;
	let todoPanelVisible = true;

	function details(): TodoDetails {
		return {
			todos: todos.map((todo) => ({ ...todo })),
			nextId,
			stats: todoStats(todos),
		};
	}

	function reconstructState(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;

			const toolDetails = message.details as TodoDetails | undefined;
			if (!toolDetails) continue;
			todos = toolDetails.todos.map((todo) => ({ ...todo }));
			nextId = toolDetails.nextId;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		updateTodoWidget(ctx, todos, todoPanelVisible);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateTodoWidget(ctx, todos, todoPanelVisible);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
	});

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Write Todos",
		description: "Replace the current visible TODO list with an updated TODO list.",
		promptSnippet: "Create, replace, or update the visible TODO list shown to the user.",
		promptGuidelines: [
			"Use write_todos to track multi-step work and keep the visible TODO list current for the user.",
			"When calling write_todos, include the complete current TODO list; omitted items are removed.",
			"Keep exactly one TODO item in_progress when actively working, and mark items completed as soon as they are done.",
		],
		parameters: WriteTodosParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const normalized = normalizeTodos(params.todos, nextId);
			todos = normalized.todos;
			nextId = normalized.nextId;
			updateTodoWidget(ctx, todos, todoPanelVisible);

			return {
				content: [{ type: "text", text: formatToolText(todos) }],
				details: details(),
			};
		},

		renderCall(args, theme, _context) {
			const count = args.todos.length;
			const text = `${theme.fg("toolTitle", theme.bold("write_todos"))} ${theme.fg("muted", `${count} item${count === 1 ? "" : "s"}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const toolDetails = result.details as TodoDetails | undefined;
			if (!toolDetails) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const todoList = toolDetails.todos;
			if (todoList.length === 0) {
				return new Text(theme.fg("dim", "TODO list cleared"), 0, 0);
			}

			const displayTodos = expanded ? todoList : todoList.slice(0, 6);
			const lines = [
				theme.fg(
					"muted",
					`${toolDetails.stats.completed}/${toolDetails.stats.total} TODOs completed (${toolDetails.stats.inProgress} in progress)`,
				),
			];

			for (const todo of displayTodos) {
				const iconColor = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "warning" : "dim";
				const priorityColor = todo.priority === "high" ? "error" : todo.priority === "medium" ? "warning" : "dim";
				const contentColor = todo.status === "completed" ? "dim" : "muted";
				lines.push(
					`${theme.fg(iconColor, statusIcon(todo.status))} ${theme.fg(priorityColor, todo.priority)} ${theme.fg(contentColor, todo.content)}`,
				);
			}

			if (!expanded && todoList.length > displayTodos.length) {
				lines.push(theme.fg("dim", `… ${todoList.length - displayTodos.length} more`));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current TODO list and restore the TODO panel",
		handler: async (_args, ctx) => {
			todoPanelVisible = true;
			updateTodoWidget(ctx, todos, todoPanelVisible);
			if (todos.length === 0) {
				ctx.ui.notify("TODO list is empty", "info");
				return;
			}

			pi.sendMessage({
				customType: "todo-list",
				content: formatToolText(todos),
				display: true,
				details: details(),
			});
		},
	});

	pi.registerCommand("hide-todos", {
		description: "Hide the TODO panel",
		handler: async (_args, ctx) => {
			todoPanelVisible = false;
			if (ctx.hasUI) {
				ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
				ctx.ui.notify("TODO panel hidden. Run /todos to show it again.", "info");
			}
		},
	});

	pi.registerMessageRenderer<TodoDetails>("todo-list", (message, _options, theme) => {
		const toolDetails = message.details;
		if (!toolDetails || toolDetails.todos.length === 0) {
			return new Text(theme.fg("dim", "TODO list is empty"), 0, 0);
		}

		const lines = [
			theme.fg(
				"accent",
				theme.bold(
					`TODOs: ${toolDetails.stats.completed}/${toolDetails.stats.total} completed, ${toolDetails.stats.inProgress} in progress`,
				),
			),
			"",
		];
		for (const todo of toolDetails.todos) {
			const iconColor = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "warning" : "dim";
			const priorityColor = todo.priority === "high" ? "error" : todo.priority === "medium" ? "warning" : "dim";
			const contentColor = todo.status === "completed" ? "dim" : "text";
			lines.push(
				`${theme.fg(iconColor, statusIcon(todo.status))} ${theme.fg("accent", todo.id)} ${theme.fg(priorityColor, todo.priority)} ${theme.fg(contentColor, todo.content)}`,
			);
		}

		return new Text(lines.join("\n"), 0, 0);
	});
}
