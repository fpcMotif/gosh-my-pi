import * as fs from "node:fs";
import {
	getRecentErrors as dbGetRecentErrors,
	getRecentRequests as dbGetRecentRequests,
	getCostTimeSeries,
	getFileOffset,
	getMessageById,
	getMessageCount,
	getModelPerformanceSeries,
	getModelTimeSeries,
	getOverallStats,
	getStatsByFolder,
	getStatsByModel,
	getTimeSeries,
	initDb,
	insertMessageStats,
	setFileOffset,
} from "./db";
import { getSessionEntry, listAllSessionFiles, parseSessionFile } from "./parser";
import type { DashboardStats, MessageStats, RequestDetails } from "./types";

/**
 * Sync a single session file to the database.
 * Only processes new entries since the last sync.
 */
async function syncSessionFile(sessionFile: string): Promise<number> {
	// Get file stats
	let fileStats: fs.Stats;
	try {
		fileStats = await fs.promises.stat(sessionFile);
	} catch {
		return 0;
	}

	const lastModified = fileStats.mtimeMs;

	// Check if file has changed since last sync
	const stored = getFileOffset(sessionFile);
	if (stored && stored.lastModified >= lastModified) {
		return 0; // File hasn't changed
	}

	// Parse file from last offset
	const fromOffset = stored?.offset ?? 0;
	const { stats, newOffset } = await parseSessionFile(sessionFile, fromOffset);

	if (stats.length > 0) {
		insertMessageStats(stats);
	}

	// Update offset tracker
	setFileOffset(sessionFile, newOffset, lastModified);

	return stats.length;
}

type SyncResult = { processed: number; files: number };
let currentSyncPromise: Promise<SyncResult> | null = null;
let nextSyncPromise: Promise<SyncResult> | null = null;

/**
 * Sync all session files to the database.
 * Returns the number of new entries processed.
 *
 * Performance Optimization: Promise Coalescing / Request Deduplication
 * Expected Impact: Reduces I/O and DB contention when multiple requests trigger `syncAllSessions` concurrently.
 * We use a `currentSyncPromise` and `nextSyncPromise` pattern:
 * - If a sync is ongoing (`currentSyncPromise` exists), a concurrent caller won't start a new immediate sync.
 * - Instead, it creates or joins `nextSyncPromise` which waits for the current sync to finish, and then does ONE final catch-up sync for any data that arrived while the first sync was running.
 * This guarantees correctness (no data left behind) while drastically reducing the number of concurrent directory reads and file stat calls.
 */
export async function syncAllSessions(): Promise<SyncResult> {
	if (currentSyncPromise) {
		if (!nextSyncPromise) {
			// Chain the next sync to start after the current one finishes.
			// We catch the error to ensure the next sync still runs even if the current one fails.
			nextSyncPromise = currentSyncPromise
				.catch(() => {})
				.then(() => {
					const promise = doSync();
					currentSyncPromise = promise;
					nextSyncPromise = null;
					return promise;
				});
		}
		return nextSyncPromise;
	}

	currentSyncPromise = doSync();
	return currentSyncPromise;
}

async function doSync(): Promise<SyncResult> {
	try {
		await initDb();

		const files = await listAllSessionFiles();
		const counts = await Promise.all(files.map(file => syncSessionFile(file)));
		let totalProcessed = 0;
		let filesProcessed = 0;
		for (const count of counts) {
			if (count > 0) {
				totalProcessed += count;
				filesProcessed++;
			}
		}

		return { processed: totalProcessed, files: filesProcessed };
	} finally {
		if (currentSyncPromise === nextSyncPromise || nextSyncPromise === null) {
			// If there's no pending next sync, clear the current promise so the next call starts fresh.
			currentSyncPromise = null;
		}
	}
}

/**
 * Get all dashboard stats.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
	await initDb();

	return {
		overall: getOverallStats(),
		byModel: getStatsByModel(),
		byFolder: getStatsByFolder(),
		timeSeries: getTimeSeries(24),
		modelSeries: getModelTimeSeries(14),
		modelPerformanceSeries: getModelPerformanceSeries(14),
		costSeries: getCostTimeSeries(90),
	};
}
export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentRequests(limit);
}

export async function getRecentErrors(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentErrors(limit);
}

export async function getRequestDetails(id: number): Promise<RequestDetails | null> {
	await initDb();
	const msg = getMessageById(id);
	if (!msg) return null;

	const entry = await getSessionEntry(msg.sessionFile, msg.entryId);
	if (!entry || entry.type !== "message") return null;

	// TODO: Get parent/context messages?
	// For now we return the single entry which contains the assistant response.
	// The user prompt is likely the parent.

	return {
		...msg,
		messages: [entry],
		output: (entry as { message?: unknown }).message,
	};
}

/**
 * Get the current message count in the database.
 */
export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	return getMessageCount();
}
