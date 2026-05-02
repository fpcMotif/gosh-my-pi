/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { collectEnvSecrets, obfuscateMessages, SecretObfuscator } from "../src/secrets";
import { compileSecretRegex } from "../src/secrets/regex";

const ENV_SECRET_KEY = "OMP_UNIT_SECURITY_TOKEN";
const ENV_DUPLICATE_SECRET_KEY = "OMP_UNIT_SECURITY_SECRET_DUPLICATE";
const ENV_PUBLIC_KEY = "OMP_UNIT_PUBLIC_VALUE";
const ENV_SHORT_SECRET_KEY = "OMP_UNIT_SHORT_TOKEN";
const envKeys = [ENV_SECRET_KEY, ENV_DUPLICATE_SECRET_KEY, ENV_PUBLIC_KEY, ENV_SHORT_SECRET_KEY] as const;
const originalEnv = new Map<string, string | undefined>(envKeys.map(key => [key, process.env[key]]));

afterEach(() => {
	for (const key of envKeys) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
});

describe("compileSecretRegex", () => {
	it("compiles pattern with explicit flags and enforces global scanning", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+", "gi");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("adds global flag when not provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+", "i");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("defaults to global flag when no flags provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("g");
	});

	it("rejects invalid regex pattern", () => {
		expect(() => compileSecretRegex("(")).toThrow();
	});
	it("rejects invalid regex flags", () => {
		expect(() => compileSecretRegex("x", "zz")).toThrow();
	});
});

describe("SecretObfuscator regex behavior", () => {
	it("obfuscates and deobfuscates regex matches with flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = "API_KEY=abc and api-key=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("supports bare regex patterns without explicit flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+" }]);
		const text = "api_key=abc and API_KEY=def";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toEqual(text);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(text);
	});
	it("deobfuscates placeholders through object payloads", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = {
			cmd: "API_KEY=abc and api-key=def",
			status: "ok",
		};
		const obfuscated = {
			cmd: obfuscator.obfuscate(original.cmd),
			status: original.status,
		};
		expect(obfuscator.deobfuscateObject(obfuscated)).toEqual({
			cmd: original.cmd,
			status: original.status,
		});
	});

	it("obfuscates outbound message text without leaking the original secret", () => {
		const secret = "sk-test-security-risk-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: `Please use ${secret}` },
					{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		];

		const obfuscated = obfuscateMessages(obfuscator, messages);

		expect(JSON.stringify(obfuscated)).not.toContain(secret);
		expect(obfuscated[0]).not.toBe(messages[0]);
		expect(obfuscator.deobfuscateObject(obfuscated)).toEqual(messages);
	});
});

describe("collectEnvSecrets", () => {
	it("collects likely secret values once and ignores public or short values", () => {
		const secret = "env-secret-risk-value";
		const publicValue = "public-risk-value";
		process.env[ENV_SECRET_KEY] = secret;
		process.env[ENV_DUPLICATE_SECRET_KEY] = secret;
		process.env[ENV_PUBLIC_KEY] = publicValue;
		process.env[ENV_SHORT_SECRET_KEY] = "short";

		const entries = collectEnvSecrets();

		expect(entries.filter(entry => entry.content === secret)).toHaveLength(1);
		expect(entries.some(entry => entry.content === publicValue)).toBe(false);
		expect(entries.some(entry => entry.content === "short")).toBe(false);
		expect(entries.find(entry => entry.content === secret)).toMatchObject({
			type: "plain",
			mode: "obfuscate",
		});
	});
});
