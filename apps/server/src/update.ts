/**
 * Looks up the newest Kiteline on npm, so the terminal and the app can say when there's an update.
 * It asks for the package's public page and sends nothing about this computer; KITELINE_UPDATE_CHECK=off
 * turns it off.
 */

const LATEST = "https://registry.npmjs.org/kiteline/latest";
const FIRST_MS = 20_000;
const EVERY_MS = 12 * 60 * 60_000;

function parts(version: string) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `candidate` is a newer release than `current`. Anything that isn't a plain x.y.z is not. */
export function isNewer(candidate: string, current: string) {
	const theirs = parts(candidate);
	const ours = parts(current);
	if (!theirs || !ours) return false;
	for (let i = 0; i < 3; i++) {
		if (theirs[i] !== ours[i]) return (theirs[i] ?? 0) > (ours[i] ?? 0);
	}
	return false;
}

export function watchForUpdates(current: string, onNewer: (version: string) => void) {
	let latest: string | null = null;
	const check = async () => {
		try {
			const response = await fetch(LATEST, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return;
			const { version } = (await response.json()) as { version?: unknown };
			if (typeof version !== "string" || !isNewer(version, current) || version === latest) return;
			latest = version;
			onNewer(version);
		} catch {
			// Offline, or npm isn't answering: ask again next time.
		}
	};
	setTimeout(() => void check(), FIRST_MS).unref();
	setInterval(() => void check(), EVERY_MS).unref();
	return () => latest;
}
