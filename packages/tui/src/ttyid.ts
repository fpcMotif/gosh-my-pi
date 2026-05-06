/**
 * Backward-compat re-exports — these utilities now live in
 * `@oh-my-pi/pi-utils`. New code should import from pi-utils directly. pi-tui
 * is being phased out (candidate #3, T2 phase).
 */

export { getTerminalId, getTtyPath } from "@oh-my-pi/pi-utils";
