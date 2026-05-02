import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import { type Static, Type } from "@sinclair/typebox";

export interface CalculateResult extends AgentToolResult<undefined> {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
}

/** Tokenizer for arithmetic expressions: numbers, + - * / ( ) */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i] ?? "";
		if (ch === " " || ch === "\t") {
			i += 1;
			continue;
		}
		if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "(" || ch === ")") {
			tokens.push(ch);
			i += 1;
			continue;
		}
		if ((ch >= "0" && ch <= "9") || ch === ".") {
			let j = i;
			while (j < input.length) {
				const c = input[j] ?? "";
				if ((c >= "0" && c <= "9") || c === ".") {
					j += 1;
				} else {
					break;
				}
			}
			tokens.push(input.slice(i, j));
			i = j;
			continue;
		}
		throw new Error(`Unexpected character: ${ch}`);
	}
	return tokens;
}

/** Recursive-descent parser for + - * / and parens. */
function parse(tokens: string[]): number {
	let pos = 0;
	const peek = (): string | undefined => tokens[pos];
	const consume = (): string => {
		const t = tokens[pos];
		if (t === undefined) throw new Error("Unexpected end of expression");
		pos += 1;
		return t;
	};

	const parseExpr = (): number => {
		let value = parseTerm();
		while (peek() === "+" || peek() === "-") {
			const op = consume();
			const right = parseTerm();
			value = op === "+" ? value + right : value - right;
		}
		return value;
	};

	const parseTerm = (): number => {
		let value = parseFactor();
		while (peek() === "*" || peek() === "/") {
			const op = consume();
			const right = parseFactor();
			value = op === "*" ? value * right : value / right;
		}
		return value;
	};

	const parseFactor = (): number => {
		const t = peek();
		if (t === "-") {
			consume();
			return -parseFactor();
		}
		if (t === "+") {
			consume();
			return parseFactor();
		}
		if (t === "(") {
			consume();
			const v = parseExpr();
			if (consume() !== ")") throw new Error("Missing closing paren");
			return v;
		}
		const tok = consume();
		const n = Number(tok);
		if (Number.isNaN(n)) throw new Error(`Not a number: ${tok}`);
		return n;
	};

	const result = parseExpr();
	if (pos !== tokens.length) throw new Error(`Unexpected token: ${tokens[pos] ?? ""}`);
	return result;
}

export function calculate(expression: string): CalculateResult {
	const result = parse(tokenize(expression));
	return { content: [{ type: "text", text: `${expression} = ${result}` }], details: undefined };
}

const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

type CalculateParams = Static<typeof calculateSchema>;

export const calculateTool: AgentTool<typeof calculateSchema, undefined> = {
	label: "Calculator",
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
	execute: async (_toolCallId: string, args: CalculateParams) => {
		return calculate(args.expression);
	},
};
