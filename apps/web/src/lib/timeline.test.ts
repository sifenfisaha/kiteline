import assert from "node:assert/strict";
import { test } from "node:test";

import type { Item } from "@kiteline/api/agent/types";

import { mergeTimeline } from "./timeline";

const text = (id: string, body = id): Item => ({ kind: "text", id, text: body, parent: null });
const ids = (items: Item[]) => items.map((item) => item.id).join(" ");

test("with nothing live, history is shown as it is", () => {
	const history = [text("a"), text("b")];
	assert.equal(ids(mergeTimeline(history, [], [])), "a b");
});

test("a run history hasn't caught up with goes after it", () => {
	assert.equal(ids(mergeTimeline([text("a"), text("b")], [], [text("c"), text("d")])), "a b c d");
});

test("a live item history already has replaces its copy in place", () => {
	const merged = mergeTimeline([text("a"), text("b", "saved")], [], [text("b", "live"), text("c")]);
	assert.equal(ids(merged), "a b c");
	assert.equal((merged[1] as Extract<Item, { kind: "text" }>).text, "live");
});

test("an item seen only live stays where it happened, after a refresh too", () => {
	// A notice between two saved items must not drop to the bottom once history has both.
	const live = [text("a"), text("notice"), text("b")];
	assert.equal(ids(mergeTimeline([text("a"), text("b"), text("c")], [], live)), "a notice b c");
});

test("live items from before the loaded page are left out, not put at the top", () => {
	const live = [text("old"), text("a"), text("b")];
	assert.equal(ids(mergeTimeline([text("a"), text("b")], [], live, true)), "a b");
	// When the page starts at the beginning of the session, they belong there.
	assert.equal(ids(mergeTimeline([text("a"), text("b")], [], live, false)), "old a b");
});

test("an earlier run from this visit comes before the live one", () => {
	const merged = mergeTimeline([text("a")], [text("r1"), text("r2")], [text("l1")]);
	assert.equal(ids(merged), "a r1 r2 l1");
});

test("the same id in an earlier run and the live one shows once, as the live copy", () => {
	const merged = mergeTimeline([], [text("x", "earlier")], [text("x", "live")]);
	assert.equal(ids(merged), "x");
	assert.equal((merged[0] as Extract<Item, { kind: "text" }>).text, "live");
});

test("merging leaves the lists it was given alone", () => {
	const history = [text("a")];
	mergeTimeline(history, [], [text("b")]);
	assert.equal(ids(history), "a");
});
