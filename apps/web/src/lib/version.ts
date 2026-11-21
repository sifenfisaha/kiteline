declare const __KITELINE_VERSION__: string;

/** The release this app was built for. Through the relay it can be newer than the computer's Kiteline. */
export const APP_VERSION: string = typeof __KITELINE_VERSION__ === "string" ? __KITELINE_VERSION__ : "";

function parts(version: string) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The later of two releases; one that isn't a plain version loses. */
export function newest(a: string, b: string | null | undefined) {
	return b && parts(b) && (!parts(a) || computerIsBehind(a, b)) ? b : a;
}

/** Whether the computer runs an older Kiteline than this app expects. Unknown versions count as fine. */
export function computerIsBehind(computer: string | undefined, app = APP_VERSION) {
	const theirs = computer ? parts(computer) : null;
	const ours = parts(app);
	if (!theirs || !ours) return false;
	for (let i = 0; i < 3; i++) {
		if (theirs[i] !== ours[i]) return (theirs[i] ?? 0) < (ours[i] ?? 0);
	}
	return false;
}
