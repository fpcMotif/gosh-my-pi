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

let activeSyncPromise: Promise<{ processed: number; files: number }> | null = null;

/**
 * Internal function to perform the actual sync of all session files.
 */
async function _syncAllSessions(): Promise<{ processed: number; files: number }> {
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
}

/**
 * Sync all session files to the database.
 * Returns the number of new entries processed.
 * Uses promise coalescing to prevent redundant syncs.
 */
export async function syncAllSessions(): Promise<{ processed: number; files: number }> {
	if (activeSyncPromise) {
		return activeSyncPromise;
	}

	activeSyncPromise = _syncAllSessions().finally(() => {
		activeSyncPromise = null;
	});

	return activeSyncPromise;
}

let activeDashboardStatsPromise: Promise<DashboardStats> | null = null;

/**
 * Internal function to fetch all dashboard stats.
 */
async function _getDashboardStats(): Promise<DashboardStats> {
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

/**
 * Get all dashboard stats.
 * Uses promise coalescing to prevent redundant queries.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
	if (activeDashboardStatsPromise) {
		return activeDashboardStatsPromise;
	}

	activeDashboardStatsPromise = _getDashboardStats().finally(() => {
		activeDashboardStatsPromise = null;
	});

	return activeDashboardStatsPromise;
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
