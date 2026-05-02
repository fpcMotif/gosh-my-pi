/**
 * Generic event stream class for managing async iterators and results.
 */
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
	#events: TEvent[] = [];
	#resolvers: Array<{
		resolve: (value: IteratorResult<TEvent>) => void;
		reject: (reason: unknown) => void;
	}> = [];
	#done = false;
	#error: unknown = null;
	#result: TResult | null = null;
	#resultPromise: Promise<TResult>;
	#resolveResult!: (value: TResult) => void;
	#rejectResult!: (reason: unknown) => void;

	constructor(
		private isComplete: (event: TEvent) => boolean = () => false,
		private extractResult: (event: TEvent) => TResult = () => null as unknown as TResult,
	) {
		this.#resultPromise = new Promise<TResult>((resolve, reject) => {
			this.#resolveResult = resolve;
			this.#rejectResult = reject;
		});
	}

	get done(): boolean {
		return this.#done;
	}

	set done(value: boolean) {
		this.#done = value;
	}

	protected resolveFinalResult(result: TResult): void {
		this.#result = result;
		this.#resolveResult(result);
	}

	protected rejectFinalResult(error: unknown): void {
		this.#error = error;
		this.#rejectResult(error);
	}

	push(event: TEvent): void {
		if (this.#done) return;

		if (this.isComplete(event)) {
			this.#done = true;
			this.#result = this.extractResult(event);
			this.#resolveResult(this.#result);
		}

		if (this.#resolvers.length > 0) {
			const resolver = this.#resolvers.shift()!;
			resolver.resolve({ value: event, done: false });
		} else {
			this.#events.push(event);
		}
	}

	error(err: unknown): void {
		if (this.#done) return;
		this.#done = true;
		this.#error = err;
		this.#rejectResult(err);

		while (this.#resolvers.length > 0) {
			const resolver = this.#resolvers.shift()!;
			resolver.reject(err);
		}
	}

	end(result?: TResult): void {
		if (this.#done) return;
		this.#done = true;
		if (result !== undefined) {
			this.#result = result;
			this.#resolveResult(result);
		}

		while (this.#resolvers.length > 0) {
			const resolver = this.#resolvers.shift()!;
			resolver.resolve({ value: undefined as unknown as TEvent, done: true });
		}
	}

	result(): Promise<TResult> {
		return this.#resultPromise;
	}

	[Symbol.asyncIterator](): AsyncIterator<TEvent> {
		return {
			next: async (): Promise<IteratorResult<TEvent>> => {
				if (this.#events.length > 0) {
					return { value: this.#events.shift()!, done: false };
				}
				if (this.#done) {
					return { value: undefined as unknown as TEvent, done: true };
				}
				if (this.#error !== null && this.#error !== undefined) {
					throw this.#error;
				}

				return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
					this.#resolvers.push({ resolve, reject });
				});
			},
		};
	}

	protected deliver(event: TEvent): void {
		if (this.#resolvers.length > 0) {
			const resolver = this.#resolvers.shift()!;
			resolver.resolve({ value: event, done: false });
		} else {
			this.#events.push(event);
		}
	}
}
