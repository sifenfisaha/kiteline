import type { Item } from "@kiteline/api/agent/types";

/**
 * Lays items from this visit's runs into the saved history. An item history knows replaces its copy
 * in place; one it doesn't (a notice seen only live, or a turn not written yet) goes right after the
 * last known item before it, so a refresh never moves anything to the bottom.
 */
function weave(out: Item[], list: Item[], windowStartsLater: boolean) {
	const position = (id: string) => out.findIndex((item) => item.id === id);
	const firstKnown = list.find((item) => position(item.id) !== -1);
	// History hasn't caught up with this run yet: it all comes after.
	if (!firstKnown) {
		for (const item of list) if (position(item.id) === -1) out.push(item);
		return;
	}
	let lead = position(firstKnown.id);
	// Before the first known item and the loaded window starts there: it's older than the window.
	const dropLeading = windowStartsLater && lead === 0;
	let anchor = -1;
	for (const item of list) {
		const at = position(item.id);
		if (at !== -1) {
			out[at] = item;
			anchor = at;
		} else if (anchor === -1) {
			if (!dropLeading) out.splice(lead++, 0, item);
		} else {
			out.splice(++anchor, 0, item);
		}
	}
}

/** History, then earlier runs from this visit, then the live run; later copies of an id win. */
export function mergeTimeline(history: Item[], retired: Item[], live: Item[], windowStartsLater = false) {
	const out = [...history];
	weave(out, retired, windowStartsLater);
	weave(out, live, windowStartsLater);
	return out;
}
