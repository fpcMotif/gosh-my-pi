/**
 * Minimal CLI framework — drop-in replacement for the subset of @oclif/core
 * actually used by the coding agent. Provides `Command`, `Args`, `Flags`,
 * and a `run()` entry point with explicit command registration.
 *
 * Design goals:
 *   - Zero dependencies beyond node builtins
 *   - No filesystem scanning, no manifest files, no plugin loading
 *   - Lazy command imports (only the invoked command is loaded)
 *   - Typed `this.parse()` output matching oclif's API shape
 */
import { parseArgs as nodeParseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Flag & Arg descriptors
// ---------------------------------------------------------------------------

export interface FlagDescriptor<K extends "string" | "boolean" | "integer" = "string" | "boolean" | "integer"> {
	kind: K;
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

export interface ArgDescriptor {
	kind: "string";
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

interface FlagInput {
	description?: string;
	char?: string;
	default?: unknown;
	multiple?: boolean;
	options?: readonly string[];
	required?: boolean;
}

interface ArgInput {
	description?: string;
	required?: boolean;
	multiple?: boolean;
	options?: readonly string[];
}

/** Builders that match the `Flags.*()` / `Args.*()` API from oclif. */
export const Flags = {
	string<T extends FlagInput>(opts?: T): FlagDescriptor<"string"> & T {
		return { kind: "string" as const, ...opts } as FlagDescriptor<"string"> & T;
	},
	boolean<T extends FlagInput>(opts?: T): FlagDescriptor<"boolean"> & T {
		return { kind: "boolean" as const, ...opts } as FlagDescriptor<"boolean"> & T;
	},
	integer<T extends FlagInput & { default?: number }>(opts?: T): FlagDescriptor<"integer"> & T {
		return { kind: "integer" as const, ...opts } as FlagDescriptor<"integer"> & T;
	},
};

export const Args = {
	string<T extends ArgInput>(opts?: T): ArgDescriptor & T {
		return { kind: "string" as const, ...opts } as ArgDescriptor & T;
	},
};

// ---------------------------------------------------------------------------
// Parse result types — mirrors oclif's typed output from this.parse()
// ---------------------------------------------------------------------------

type FlagValue<D extends FlagDescriptor> = D["kind"] extends "boolean"
	? D extends { default: boolean }
		? boolean
		: boolean | undefined
	: D["kind"] extends "integer"
		? D extends { default: number }
			? number
			: number | undefined
		: D extends { multiple: true }
			? string[] | undefined
			: string | undefined;

type ArgValue<D extends ArgDescriptor> = D extends { multiple: true } ? string[] | undefined : string | undefined;

type FlagValues<T extends Record<string, FlagDescriptor>> = { [K in keyof T]: FlagValue<T[K]> };
type ArgValues<T extends Record<string, ArgDescriptor>> = { [K in keyof T]: ArgValue<T[K]> };

export interface ParseOutput<
	F extends Record<string, FlagDescriptor> = Record<string, FlagDescriptor>,
	A extends Record<string, ArgDescriptor> = Record<string, ArgDescriptor>,
> {
	flags: FlagValues<F>;
	args: ArgValues<A>;
	argv: string[];
}

// ---------------------------------------------------------------------------
// Command base class
// ---------------------------------------------------------------------------

export interface CommandCtor {
	new (argv: string[], config: CliConfig): Command;
	description?: string;
	hidden?: boolean;
	strict?: boolean;
	aliases?: string[];
	examples?: string[];
	flags?: Record<string, FlagDescriptor>;
	args?: Record<string, ArgDescriptor>;
}

/** Configuration passed to every command instance and help renderers. */
export interface CliConfig {
	bin: string;
	version: string;
	/** All registered commands keyed by their canonical name. */
	commands: Map<string, CommandCtor>;
}

/** Minimal Command base matching the oclif surface we use. */
export abstract class Command {
	argv: string[];
	config: CliConfig;

	constructor(argv: string[], config: CliConfig) {
		this.argv = argv;
		this.config = config;
	}

	abstract run(): Promise<void>;

	/**
	 * Parse argv against the static `flags` and `args` declared on the
	 * concrete command class. Returns a typed `{ flags, args, argv }` object.
	 */
	async parse<C extends CommandCtor>(
		_Cmd: C,
	): Promise<
		ParseOutput<
			NonNullable<C["flags"]> extends Record<string, FlagDescriptor>
				? NonNullable<C["flags"]>
				: Record<string, FlagDescriptor>,
			NonNullable<C["args"]> extends Record<string, ArgDescriptor>
				? NonNullable<C["args"]>
				: Record<string, ArgDescriptor>
		>
	> {
		const Cmd = _Cmd as CommandCtor;
		const flagDefs = (Cmd.flags ?? {}) as Record<string, FlagDescriptor>;
		const argDefs = (Cmd.args ?? {}) as Record<string, ArgDescriptor>;
		const strict = Cmd.strict !== false;

		const options = buildParseArgsOptions(flagDefs);
		const { values: rawValues, positionals } = nodeParseArgs({
			args: this.argv,
			options,
			allowPositionals: true,
			strict,
		});

		const flags = convertFlagValues(flagDefs, rawValues as Record<string, string | boolean | string[] | undefined>);
		const args = mapPositionalArgs(argDefs, positionals);

		return { flags, args, argv: positionals } as never;
	}
}

type ParseArgsOption = { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean };

function stringifyPrimitive(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

function buildParseArgsOptions(flagDefs: Record<string, FlagDescriptor>): Record<string, ParseArgsOption> {
	const options: Record<string, ParseArgsOption> = {};
	for (const [name, desc] of Object.entries(flagDefs)) {
		const opt: ParseArgsOption = {
			type: desc.kind === "boolean" ? "boolean" : "string",
		};
		if (desc.char !== undefined && desc.char !== "") opt.short = desc.char;
		if (desc.multiple === true) opt.multiple = true;
		if (desc.default !== undefined) {
			opt.default = desc.kind === "boolean" ? Boolean(desc.default) : stringifyPrimitive(desc.default);
		}
		options[name] = opt;
	}
	return options;
}

function convertFlagValues(
	flagDefs: Record<string, FlagDescriptor>,
	rawValues: Record<string, string | boolean | string[] | undefined>,
): Record<string, unknown> {
	const flags: Record<string, unknown> = {};
	for (const [name, desc] of Object.entries(flagDefs)) {
		const raw = rawValues[name];
		flags[name] = convertFlagValue(name, desc, raw);
		if (desc.required === true && flags[name] === undefined) {
			throw new Error(`Missing required flag: --${name}`);
		}
	}
	return flags;
}

function convertFlagValue(name: string, desc: FlagDescriptor, raw: unknown): unknown {
	if (desc.kind === "integer") return convertIntegerFlag(name, desc, raw);
	if (desc.kind === "boolean") {
		if (raw !== undefined) return Boolean(raw);
		return desc.default === undefined ? undefined : Boolean(desc.default);
	}
	return convertStringFlag(name, desc, raw);
}

function convertIntegerFlag(name: string, desc: FlagDescriptor, raw: unknown): number | undefined {
	if (raw === undefined || typeof raw === "boolean") {
		return desc.default === undefined ? undefined : Number(desc.default);
	}
	const n = Number.parseInt(raw as string, 10);
	if (Number.isNaN(n)) {
		throw new Error(`Expected integer for --${name}, got "${stringifyPrimitive(raw)}"`);
	}
	return n;
}

function convertStringFlag(name: string, desc: FlagDescriptor, raw: unknown): unknown {
	const val = raw !== undefined && typeof raw !== "boolean" ? raw : (desc.default ?? undefined);
	if (val !== undefined && desc.options && !Array.isArray(val) && !desc.options.includes(val as string)) {
		throw new Error(
			`Expected --${name} to be one of: ${[...desc.options].join(", ")}; got "${stringifyPrimitive(val)}"`,
		);
	}
	return val;
}

function mapPositionalArgs(argDefs: Record<string, ArgDescriptor>, positionals: string[]): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let posIdx = 0;
	for (const [argName, desc] of Object.entries(argDefs)) {
		if (desc.multiple === true) {
			const val = positionals.slice(posIdx);
			args[argName] = val.length > 0 ? val : undefined;
			posIdx = positionals.length;
		} else {
			args[argName] = positionals[posIdx];
			posIdx++;
		}
		validatePositionalArg(argName, desc, args[argName]);
	}
	return args;
}

function validatePositionalArg(argName: string, desc: ArgDescriptor, value: unknown): void {
	if (desc.required === true && value === undefined) {
		throw new Error(`Missing required argument: ${argName}`);
	}
	if (value !== undefined && desc.options && typeof value === "string" && !desc.options.includes(value)) {
		throw new Error(`Expected ${argName} to be one of: ${[...desc.options].join(", ")}; got "${value}"`);
	}
}

// ---------------------------------------------------------------------------
// Help rendering
// ---------------------------------------------------------------------------

/** Render full root help: header, default command details, subcommand list. */
export function renderRootHelp(config: CliConfig): void {
	const { bin, version, commands } = config;
	const lines: string[] = [];
	lines.push(`${bin} v${version}\n`);
	lines.push("USAGE");
	lines.push(`  $ ${bin} [COMMAND]\n`);

	// Show the default command's flags/args/examples inline.
	// The default command is the one marked hidden (it's the implicit entry point).
	const defaultCmd = [...commands.values()].find(C => C.hidden === true);
	if (defaultCmd) {
		renderCommandBody(lines, defaultCmd);
	}

	// List visible subcommands
	const visible = [...commands.entries()].filter(([, C]) => C.hidden !== true);
	if (visible.length > 0) {
		lines.push("COMMANDS");
		const maxLen = Math.max(...visible.map(([n]) => n.length));
		for (const [name, C] of visible.sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`  ${name.padEnd(maxLen + 2)}${C.description ?? ""}`);
		}
		lines.push("");
	}

	process.stdout.write(lines.join("\n"));
}

/** Render help for a single command. */
export function renderCommandHelp(bin: string, id: string, Cmd: CommandCtor): void {
	const lines: string[] = [];
	if (Cmd.description !== null && Cmd.description !== undefined && Cmd.description !== "")
		lines.push(`${Cmd.description}\n`);
	lines.push("USAGE");
	const argNames = Object.keys(Cmd.args ?? {});
	const argStr = argNames.length > 0 ? ` ${argNames.map(n => `[${n.toUpperCase()}]`).join(" ")}` : "";
	const hasFlags = Object.keys(Cmd.flags ?? {}).length > 0;
	lines.push(`  $ ${bin} ${id}${argStr}${hasFlags ? " [FLAGS]" : ""}\n`);
	renderCommandBody(lines, Cmd);
	process.stdout.write(lines.join("\n"));
}

function renderCommandBody(lines: string[], Cmd: CommandCtor): void {
	renderArgsSection(lines, Cmd.args ?? {});
	renderFlagsSection(lines, Cmd.flags ?? {});
	renderExamplesSection(lines, Cmd.examples);
}

function renderArgsSection(lines: string[], argDefs: Record<string, ArgDescriptor>): void {
	const argEntries = Object.entries(argDefs);
	if (argEntries.length === 0) return;
	lines.push("ARGUMENTS");
	const maxLen = Math.max(...argEntries.map(([n]) => n.length));
	for (const [name, desc] of argEntries) {
		const parts = [name.toUpperCase().padEnd(maxLen + 2)];
		if (desc.description !== undefined && desc.description !== "") parts.push(desc.description);
		if (desc.options) parts.push(`(${[...desc.options].join("|")})`);
		lines.push(`  ${parts.join(" ")}`);
	}
	lines.push("");
}

function renderFlagsSection(lines: string[], flagDefs: Record<string, FlagDescriptor>): void {
	const flagEntries = Object.entries(flagDefs);
	if (flagEntries.length === 0) return;
	lines.push("FLAGS");
	const formatted: [string, string][] = flagEntries.map(([name, desc]) => {
		const charPart = desc.char !== undefined && desc.char !== "" ? `-${desc.char}, ` : "    ";
		const namePart = `--${name}`;
		const typePart = desc.kind === "boolean" ? "" : (desc.kind === "integer" ? "=<int>" : "=<value>");
		return [`  ${charPart}${namePart}${typePart}`, desc.description ?? ""];
	});
	const maxLeft = Math.max(...formatted.map(([l]) => l.length));
	for (const [left, right] of formatted) {
		lines.push(`${left.padEnd(maxLeft + 2)}${right}`);
	}
	lines.push("");
}

function renderExamplesSection(lines: string[], examples: string[] | undefined): void {
	if (!examples || examples.length === 0) return;
	lines.push("EXAMPLES");
	for (const ex of examples) {
		for (const line of ex.split("\n")) {
			lines.push(`  ${line}`);
		}
	}
	lines.push("");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/** A lazily-loaded command: canonical name, loader, and optional aliases. */
export interface CommandEntry {
	name: string;
	load: () => Promise<CommandCtor>;
	aliases?: string[];
}

export interface RunOptions {
	bin: string;
	version: string;
	argv: string[];
	commands: CommandEntry[];
	/** Custom help renderer. Receives fully-populated config. */
	help?: (config: CliConfig) => Promise<void> | void;
}

/** Find a command entry by exact name or alias. */
function findEntry(commands: CommandEntry[], id: string): CommandEntry | undefined {
	return commands.find(e => e.name === id) ?? commands.find(e => e.aliases?.includes(id) === true);
}

/**
 * Main entry point — replaces `run()` from @oclif/core.
 *
 * Each command is explicitly registered with a lazy loader.
 * No filesystem scanning, no plugin system, no package.json reading.
 */
export async function run(opts: RunOptions): Promise<void> {
	const { bin, version, argv } = opts;

	const commandId = argv[0] ?? "";
	const commandArgv = argv.slice(1);

	if (isTopLevelHelp(commandId)) {
		await runTopLevelHelp(opts);
		return;
	}

	if (commandId === "--version" || commandId === "-v") {
		process.stdout.write(`${bin}/${version}\n`);
		return;
	}

	if (commandArgv.includes("--help") || commandArgv.includes("-h")) {
		await runCommandHelp(opts, commandId);
		return;
	}

	await runCommand(opts, commandId, commandArgv);
}

function isTopLevelHelp(commandId: string): boolean {
	return commandId === "--help" || commandId === "-h" || commandId === "help" || commandId === "";
}

async function runTopLevelHelp(opts: RunOptions): Promise<void> {
	const config = await loadAllCommands(opts);
	if (opts.help) {
		await opts.help(config);
	} else {
		renderRootHelp(config);
	}
}

async function runCommandHelp(opts: RunOptions, commandId: string): Promise<void> {
	const { bin } = opts;
	const config = await loadAllCommands(opts);
	const entry = findEntry(opts.commands, commandId);
	const Cmd = entry ? config.commands.get(entry.name) : undefined;
	if (Cmd && entry) {
		renderCommandHelp(bin, entry.name, Cmd);
	} else {
		process.stderr.write(`Unknown command: ${commandId}\n`);
	}
}

async function runCommand(opts: RunOptions, commandId: string, commandArgv: string[]): Promise<void> {
	const { bin, version } = opts;
	const entry = findEntry(opts.commands, commandId);
	if (!entry) {
		process.stderr.write(`Error: command ${commandId} not found\n`);
		process.exitCode = 1;
		return;
	}
	const Cmd = await entry.load();
	const config: CliConfig = { bin, version, commands: new Map([[entry.name, Cmd]]) };
	const instance = new Cmd(commandArgv, config);
	await instance.run();
}

/** Resolve all command loaders for help/alias display. */
async function loadAllCommands(opts: RunOptions): Promise<CliConfig> {
	const commands = new Map<string, CommandCtor>();
	const loaded = await Promise.all(opts.commands.map(async e => [e.name, await e.load()] as const));
	for (const [name, Cmd] of loaded) {
		commands.set(name, Cmd);
	}
	return { bin: opts.bin, version: opts.version, commands };
}
