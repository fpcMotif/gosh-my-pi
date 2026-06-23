import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeModelCache, readModelCache, DEFAULT_CACHE_TTL_MS } from "../src/model-cache";
import { Database } from "bun:sqlite";

describe("model cache", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-cache-"));
		dbPath = path.join(tempDir, "cache.db");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("round-trip write and read", () => {
		const models = [{ id: "model-1", providerId: "test-provider" } as any];
		const now = Date.now();

		writeModelCache("test-provider", now, models, true, dbPath);

		const entry = readModelCache("test-provider", DEFAULT_CACHE_TTL_MS, () => now, dbPath);

		expect(entry).not.toBeNull();
		expect(entry?.models).toEqual(models);
		expect(entry?.updatedAt).toBe(now);
		expect(entry?.authoritative).toBe(true);
		expect(entry?.fresh).toBe(true);
	});

	test("upsert (INSERT OR REPLACE) overwrites existing entry", () => {
		const initialModels = [{ id: "model-1", providerId: "test-provider" } as any];
		const updatedModels = [{ id: "model-2", providerId: "test-provider" } as any];
		const initialTime = Date.now();
		const updatedTime = initialTime + 1000;

		writeModelCache("test-provider", initialTime, initialModels, false, dbPath);
		writeModelCache("test-provider", updatedTime, updatedModels, true, dbPath);

		const entry = readModelCache("test-provider", DEFAULT_CACHE_TTL_MS, () => updatedTime, dbPath);

		expect(entry).not.toBeNull();
		expect(entry?.models).toEqual(updatedModels);
		expect(entry?.updatedAt).toBe(updatedTime);
		expect(entry?.authoritative).toBe(true);
	});

	test("read fresh boundary logic", () => {
		const models = [{ id: "model-1", providerId: "test-provider" } as any];
		const writeTime = 100000;

		writeModelCache("test-provider", writeTime, models, false, dbPath);

		// Within TTL
		const freshEntry = readModelCache("test-provider", 1000, () => writeTime + 500, dbPath);
		expect(freshEntry?.fresh).toBe(true);

		// Outside TTL
		const staleEntry = readModelCache("test-provider", 1000, () => writeTime + 1500, dbPath);
		expect(staleEntry?.fresh).toBe(false);
	});

	test("read ignores version mismatch", () => {
		const models = [{ id: "model-1", providerId: "test-provider" } as any];
		const now = Date.now();

		// To simulate a version mismatch, we have to initialize the db manually with version = 1
		const db = new Database(dbPath, { create: true });
		db.run(`
			CREATE TABLE IF NOT EXISTS model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		db.run(
			`INSERT INTO model_cache (provider_id, version, updated_at, authoritative, models)
			 VALUES (?, ?, ?, ?, ?)`,
			["test-provider", 1, now, 0, JSON.stringify(models)],
		);
		db.close();

		const entry = readModelCache("test-provider", DEFAULT_CACHE_TTL_MS, () => now, dbPath);
		expect(entry).toBeNull();
	});

	test("write handles errors gracefully without corrupting subsequent valid operations", () => {
		const models = [{ id: "model-1", providerId: "test-provider" } as any];
		const now = Date.now();

		// Attempting to write to an invalid path should not throw
		expect(() => writeModelCache("test-provider", now, models, false, "/no/such/dir/cache.db")).not.toThrow();

		// Subsequent write to the valid path should succeed
		writeModelCache("test-provider", now, models, true, dbPath);

		const entry = readModelCache("test-provider", DEFAULT_CACHE_TTL_MS, () => now, dbPath);
		expect(entry).not.toBeNull();
		expect(entry?.authoritative).toBe(true);
	});
});
