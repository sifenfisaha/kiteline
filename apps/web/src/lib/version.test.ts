import assert from "node:assert/strict";
import { test } from "node:test";

import { computerIsBehind, newest } from "./version";

test("a computer on an older release is behind", () => {
	assert.ok(computerIsBehind("0.3.3", "0.3.4"));
	assert.ok(computerIsBehind("0.3.9", "0.4.0"));
	assert.ok(computerIsBehind("0.9.9", "1.0.0"));
	// Numbers, not text: 0.3.10 is after 0.3.9.
	assert.ok(computerIsBehind("0.3.9", "0.3.10"));
	assert.ok(!computerIsBehind("0.3.10", "0.3.9"));
});

test("the same or a newer release is not behind", () => {
	assert.ok(!computerIsBehind("0.3.4", "0.3.4"));
	assert.ok(!computerIsBehind("0.4.0", "0.3.9"));
});

test("a version that can't be read counts as fine", () => {
	assert.ok(!computerIsBehind(undefined, "0.3.4"));
	assert.ok(!computerIsBehind("dev", "0.3.4"));
	assert.ok(!computerIsBehind("0.3.3", ""));
});

test("the newer of the app's release and the one npm has", () => {
	assert.equal(newest("0.3.4", "0.3.5"), "0.3.5");
	assert.equal(newest("0.3.5", "0.3.4"), "0.3.5");
	assert.equal(newest("0.3.4", null), "0.3.4");
	assert.equal(newest("0.3.4", "nonsense"), "0.3.4");
	assert.equal(newest("", "0.3.5"), "0.3.5");
});
