import type { RunManager } from "./agent/manager";
import type { Actor, Devices } from "./devices";
import type { Push } from "./push";

export type Context = {
	authed: boolean;
	/** Who's asking: a paired device, or the computer's own `kiteline` commands, as "terminal". */
	caller: Actor | null;
	manager: RunManager;
	devices: Devices;
	push: Push;
	/** The newest Kiteline on npm, once it's been looked up; null when unknown or not looked for. */
	latestVersion: () => string | null;
	/** The link a one-time pairing code goes in, with its QR code. */
	pairingLink: (code: string) => { url: string; svg: string };
	allowBypass: boolean;
	version: string;
};
