/**
 * Base exception type for child process errors.
 */
export abstract class Exception extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly stderr: string,
	) {
		super(message);
		this.name = this.constructor.name;
	}
	abstract readonly aborted: boolean;
}
