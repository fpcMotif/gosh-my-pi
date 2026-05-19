/**
 * Returns `true` if the signal exists and is in the aborted state. Canonical
 * replacement for the `signal !== undefined && signal.aborted` pattern; the lint-fix sweep
 * expanded that into `signal !== undefined && signal.aborted` across ~70 sites
 * — prefer this helper at all new call sites and gradually consolidate.
 */
export function isAborted(signal?: AbortSignal): boolean {
	return signal !== undefined && signal.aborted;
}

/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given message if the timeout fires first.
 * Cleans up all listeners on settlement.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
	if (isAborted(signal)) {
		const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
		return Promise.reject(reason);
	}

	const { promise: wrapped, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		reject(new Error(message));
	}, ms);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(
		value => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);

	return wrapped;
}

/**
 * Returns a new function that will deduplicate concurrent executions.
 * If the function is called while a promise from a previous call is still pending,
 * it returns the same promise. Once the promise settles, the next call will
 * invoke the function again.
 *
 * NOTE: This function does NOT differentiate based on arguments!
 * It strictly treats all concurrent calls as identical.
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
	let activePromise: Promise<T> | null = null;
	return () => {
		if (activePromise) {
			return activePromise;
		}
		activePromise = fn().finally(() => {
			activePromise = null;
		});
		return activePromise;
	};
}
