import { Exception } from "./ptree-errors";

/** Exception for explicit process abortion (via signal). */
export class AbortError extends Exception {
	constructor(
		readonly reason: unknown,
		stderr: string,
	) {
		const msg = reason instanceof Error ? reason.message : (typeof reason === "string" ? reason : "aborted");
		super(`Operation cancelled: ${msg}`, -1, stderr);
	}
	get aborted(): true {
		return true;
	}
}
