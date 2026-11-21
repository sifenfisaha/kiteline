import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { type ManagerConfig, RunManager, type RunNote } from "./manager";
import type { PermissionRequest, RunEvent, RunStatus } from "./types";

/**
 * What the manager decides is worth a notification. It's fed a session's events directly, with a
 * stand-in for the run: no Claude Code is started.
 */
function setup() {
	const notes: RunNote[] = [];
	const manager = new RunManager({
		claudePath: null,
		allowBypass: true,
		maxLiveRuns: 6,
		idleTimeoutMs: 60_000,
		tracker: { add() {}, list: () => [] } as unknown as ManagerConfig["tracker"],
		notify: (note) => notes.push(note),
	});
	const run = {
		sessionId: "s1",
		cwd: "/home/me/projects/api",
		title: "",
		status: "running" as RunStatus,
		isLive: true,
		items: [{ kind: "text", id: "t1", text: "All 42 tests\n  pass now.", parent: null }],
	};
	const inner = manager as unknown as {
		runs: Map<string, typeof run>;
		broadcast: (sessionId: string, event: RunEvent) => void;
	};
	inner.runs.set("s1", run);
	const status = (next: RunStatus, error: string | null = null) => {
		run.status = next;
		inner.broadcast("s1", { type: "status", status: next, error });
	};
	return { notes, run, status, broadcast: (event: RunEvent) => inner.broadcast("s1", event) };
}

const request = (patch: Partial<PermissionRequest>): PermissionRequest => ({
	id: "p1",
	toolName: "Bash",
	input: {},
	title: null,
	description: null,
	displayName: null,
	decisionReason: null,
	blockedPath: null,
	canAlwaysAllow: false,
	alwaysAllow: null,
	defaultToNo: false,
	fromSubagent: false,
	createdAt: 0,
	...patch,
});

/** Takes over the clock once the manager is set up, so a test can let a finished turn rest in no time. */
function clock(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	return () => t.mock.timers.tick(1500);
}

test("a request for permission is told at once, named for its project", () => {
	const { notes, broadcast } = setup();
	broadcast({ type: "permission", request: request({ title: "Run pnpm test?" }) });
	assert.deepEqual(notes, [
		{ kind: "permission", sessionId: "s1", title: "api needs your OK", body: "Run pnpm test?" },
	]);
});

test("a request with no title falls back to the tool's name", () => {
	const { notes, broadcast } = setup();
	broadcast({ type: "permission", request: request({}) });
	assert.equal(notes[0]?.body, "Bash");
});

test("a finished turn is told once it has rested, with the reply on one line", (t) => {
	const { notes, status } = setup();
	const settle = clock(t);
	status("running");
	status("idle");
	assert.equal(notes.length, 0, "not before it has rested");
	settle();
	assert.deepEqual(notes, [
		{ kind: "done", sessionId: "s1", title: "api is done", body: "All 42 tests pass now." },
	]);
});

test("a turn that's followed straight away by the next one isn't called done", (t) => {
	const { notes, status } = setup();
	const settle = clock(t);
	status("running");
	status("idle");
	status("running");
	settle();
	assert.equal(notes.length, 0);
});

test("a session that starts out idle, or sleeps, says nothing", (t) => {
	const { notes, status } = setup();
	const settle = clock(t);
	status("idle");
	status("closed");
	settle();
	assert.equal(notes.length, 0);
});

test("stopping on an error is told, with what went wrong", () => {
	const { notes, status } = setup();
	status("running");
	status("error", "Claude Code exited with code 1");
	assert.deepEqual(notes, [
		{ kind: "error", sessionId: "s1", title: "api stopped", body: "Claude Code exited with code 1" },
	]);
});

test("a session's own name is used when it has one, and a long reply is cut short", (t) => {
	const { notes, run, status } = setup();
	const settle = clock(t);
	run.title = "Fix the login bug";
	run.items = [{ kind: "text", id: "t1", text: "word ".repeat(100), parent: null }];
	status("running");
	status("idle");
	settle();
	assert.equal(notes[0]?.title, "Fix the login bug is done");
	assert.ok((notes[0]?.body.length ?? 0) <= 180);
	assert.ok(notes[0]?.body.endsWith("…"));
});
