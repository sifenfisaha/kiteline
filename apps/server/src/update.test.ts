import assert from "node:assert/strict";
import { test } from "node:test";

import { isNewer } from "./update";

test("only a later release counts as an update", () => {
	assert.ok(isNewer("0.3.5", "0.3.4"));
	assert.ok(isNewer("0.3.10", "0.3.9"));
	assert.ok(isNewer("1.0.0", "0.9.9"));
	assert.ok(!isNewer("0.3.4", "0.3.4"));
	assert.ok(!isNewer("0.3.3", "0.3.4"));
});

test("a prerelease or anything odd from npm is never offered", () => {
	assert.ok(!isNewer("0.4.0-beta.1", "0.3.4"));
	assert.ok(!isNewer("latest", "0.3.4"));
	assert.ok(!isNewer("", "0.3.4"));
});
