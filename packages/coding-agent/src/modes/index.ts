/**
 * Run modes for the coding agent.
 *
 * The TS interactive TUI was removed in P6a; gmp-tui-go (apps/tui-go/)
 * is now the only interactive front-end and consumes this binary via
 * `--mode rpc`. Headless modes only here.
 */
export { runAcpMode } from "./acp";
export { type PrintModeOptions, runPrintMode } from "./print-mode";
export {
	defineRpcClientTool,
	type ModelInfo,
	RpcClient,
	type RpcClientCustomTool,
	type RpcClientOptions,
	type RpcClientToolContext,
	type RpcClientToolResult,
	type RpcEventListener,
} from "./rpc/rpc-client";
export { runRpcMode } from "./rpc/rpc-mode";
export type {
	RpcCommand,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types";
