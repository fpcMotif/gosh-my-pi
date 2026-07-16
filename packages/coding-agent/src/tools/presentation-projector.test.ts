import { describe, expect, test } from "bun:test";
import { createToolPresentationProjector } from "./presentation-projector";
import type { ToolPresenter } from "./presenters";

describe("ToolPresentationProjector", () => {
	test("retains call arguments for the final presentation snapshot", () => {
		const presenter: ToolPresenter = {
			presentResult: (_result, _options, args) => ({
				type: "status",
				status: { title: `Read ${(args as { path: string }).path}` },
			}),
		};
		const project = createToolPresentationProjector({ read: presenter });

		project({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/value.ts" },
		});
		const presentation = project({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "const value = 1;" }] },
		});

		expect(presentation).toEqual({
			type: "status",
			status: { title: "Read src/value.ts" },
		});
	});

	test("refreshes arguments on update and returns complete snapshots", () => {
		const presenter: ToolPresenter = {
			presentResult: (result, options, args) => ({
				type: "block",
				status: { title: options.isPartial ? "Reading" : "Read" },
				sections: [{ label: (args as { path: string }).path, lines: [result.content[0]?.text ?? ""] }],
			}),
		};
		const project = createToolPresentationProjector({ read: presenter });

		project({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "draft.ts" },
		});
		const update = project({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "final.ts" },
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		const end = project({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "complete" }] },
		});

		expect(update).toEqual({
			type: "block",
			status: { title: "Reading" },
			sections: [{ label: "final.ts", lines: ["partial"] }],
		});
		expect(end).toEqual({
			type: "block",
			status: { title: "Read" },
			sections: [{ label: "final.ts", lines: ["complete"] }],
		});
	});

	test("clears retained arguments after every terminal outcome", () => {
		let shouldThrow = false;
		const presenter: ToolPresenter = {
			presentResult: (_result, _options, args) => {
				if (shouldThrow) throw new Error("result failed");
				return { type: "status", status: { title: args === undefined ? "missing" : "retained" } };
			},
		};
		const project = createToolPresentationProjector({ read: presenter });
		const start = () =>
			project({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "src/value.ts" },
			});
		const end = () =>
			project({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "done" }] },
			});

		start();
		expect(end()).toEqual({ type: "status", status: { title: "retained" } });
		expect(end()).toEqual({ type: "status", status: { title: "missing" } });

		start();
		shouldThrow = true;
		expect(end()).toBeUndefined();
		shouldThrow = false;
		expect(end()).toEqual({ type: "status", status: { title: "missing" } });
	});

	test("bounds presenter diagnostics and isolates diagnostic failures", () => {
		const failures: string[] = [];
		const project = createToolPresentationProjector(
			{
				read: {
					presentCall: () => {
						throw new Error("x".repeat(1_000));
					},
				},
			},
			failure => {
				failures.push(failure.error);
				throw new Error("diagnostic sink failed");
			},
		);

		expect(() =>
			project({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: {},
			}),
		).not.toThrow();
		expect(failures[0]?.length).toBe(500);
	});
});
