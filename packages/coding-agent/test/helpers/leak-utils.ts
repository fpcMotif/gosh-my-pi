/**
 * Shared leak-detection helpers for e2e/regression tests.
 *
 * Two complementary checks:
 *
 *  - listener-count assertions: cheap, deterministic, always-on. Catches the most
 *    common dispose bugs (forgot to remove an EventEmitter listener, kept a
 *    `subscribe()` callback in a Set after `dispose()`, etc).
 *  - heap-growth assertions: gated behind `PI_TEST_HEAP=1` because forced GC
 *    plus heap sampling is flaky in shared CI runners. Uses Bun's native
 *    `Bun.gc(true)` so no `--expose-gc` flag is required.
 */

export interface ListenerCountSource {
	listenerCount(eventName: string): number;
}

/**
 * Assert that running `fn` does not change `emitter.listenerCount(name)`.
 *
 * Throws with a useful diagnostic when leaks are detected so failures point
 * at the exact channel that grew.
 */
export async function withListenerCount<T>(
	emitter: ListenerCountSource,
	name: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const before = emitter.listenerCount(name);
	const out = await fn();
	const after = emitter.listenerCount(name);
	if (after !== before) {
		throw new Error(`Listener leak on '${name}': baseline ${before}, observed ${after} (diff ${after - before})`);
	}
	return out;
}

/**
 * Wrap a Set-backed listener registry so `withListenerCount` can introspect it.
 * Useful for code that uses `Set<Listener>` directly (e.g. AgentSession,
 * Agent core) instead of an EventEmitter.
 */
export function listenerSet(set: { size: number }): ListenerCountSource {
	return {
		listenerCount: () => set.size,
	};
}

/**
 * Assert active resource handles return to baseline. Catches dangling timers,
 * sockets, or child processes that disposal forgot to clean up.
 */
export async function withActiveHandles<T>(fn: () => Promise<T> | T): Promise<T> {
	const before = process.getActiveResourcesInfo();
	const out = await fn();
	// Settle one microtask so any cleanup queued from `fn` has a chance to run.
	await Bun.sleep(0);
	const after = process.getActiveResourcesInfo();
	const baseline = countByType(before);
	const observed = countByType(after);
	const grew: string[] = [];
	for (const [type, count] of observed) {
		const prev = baseline.get(type) ?? 0;
		if (count > prev && !ALLOWED_HANDLE_TYPES.has(type)) {
			grew.push(`${type}: ${prev} -> ${count}`);
		}
	}
	if (grew.length > 0) {
		throw new Error(`Active-handle growth detected: ${grew.join(", ")}`);
	}
	return out;
}

/** Resource types that are expected to vary between samples and should be ignored. */
const ALLOWED_HANDLE_TYPES = new Set<string>([
	// Bun's worker pool, GC threads, and microtask queue churn freely.
	"TickObject",
	"Immediate",
	"PromiseResolveThenableJob",
]);

function countByType(handles: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const h of handles) {
		out.set(h, (out.get(h) ?? 0) + 1);
	}
	return out;
}

export interface HeapGrowthOptions {
	samples: number;
	maxBytesPerSample: number;
	/** Skip the heap probe entirely unless this env var is "1". Defaults to PI_TEST_HEAP. */
	envFlag?: string;
}

/**
 * Run `fn` `samples` times and assert average heap growth per iteration is
 * bounded. Skipped unless `PI_TEST_HEAP=1` (or a custom flag) is set.
 *
 * Returns true when the assertion ran, false when it was skipped, so callers
 * can branch their assertions accordingly.
 */
export async function withHeapGrowth(fn: () => Promise<void> | void, opts: HeapGrowthOptions): Promise<boolean> {
	const flag = opts.envFlag ?? "PI_TEST_HEAP";
	if (Bun.env[flag] !== "1") return false;

	Bun.gc(true);
	const baseline = process.memoryUsage().heapUsed;
	for (let i = 0; i < opts.samples; i++) {
		await fn();
	}
	Bun.gc(true);
	const grew = process.memoryUsage().heapUsed - baseline;
	const perSample = grew / Math.max(1, opts.samples);
	if (perSample > opts.maxBytesPerSample) {
		throw new Error(
			`Heap grew ~${perSample.toFixed(0)}B/sample over ${opts.samples} samples (limit ${opts.maxBytesPerSample}B/sample, total ${grew}B)`,
		);
	}
	return true;
}

/**
 * Deterministic seeded RNG (LCG) for property/fuzz tests. Use a fixed seed
 * per test so failures are reproducible.
 */
export function createRng(seed: number): {
	next(): number;
	int(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
} {
	let state = seed % 2147483647;
	if (state <= 0) state += 2147483646;
	const next = () => {
		state = (state * 48271) % 2147483647;
		return state / 2147483647;
	};
	return {
		next,
		int(min, max) {
			return Math.floor(next() * (max - min + 1)) + min;
		},
		pick(items) {
			return items[Math.floor(next() * items.length)]!;
		},
	};
}
