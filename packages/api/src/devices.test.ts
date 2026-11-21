import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { type Actor, Devices } from "./devices";

const terminal: Actor = { kind: "terminal" };
const fresh = () => join(mkdtempSync(join(tmpdir(), "kiteline-devices-")), "devices.json");

/** A code, and the request a phone makes with it. */
async function ask(devices: Devices, name = "Pixel · Chrome") {
	const code = await devices.createCode();
	const claimed = await devices.claim({ code: code.code }, { name, via: "direct" });
	assert.ok(claimed.ok);
	return { code, request: claimed.request };
}

test("a device gets in only once someone allows it", async () => {
	const file = fresh();
	const devices = new Devices(file);
	const { request } = await ask(devices);

	assert.equal((await devices.status(request.claim))?.state, "pending");
	assert.equal(devices.count, 0);
	assert.match(request.match, /^\d{6}$/);
	assert.equal(devices.snapshot().requests[0]?.match, request.match);

	const decided = devices.decide(request.id, true, terminal);
	assert.ok(decided.ok);
	const status = await devices.status(request.claim);
	assert.equal(status?.state, "approved");
	assert.equal(devices.count, 1);

	// What it's handed opens the door, as a cookie; anything else doesn't.
	if (status?.state !== "approved") throw new Error("unreachable");
	assert.equal(devices.fromCookie(Devices.cookieFor(status.device))?.id, status.device.id);
	assert.equal(devices.fromCookie(`${status.device.id}.wrong`), null);

	// And it's still paired after a restart.
	assert.equal(new Devices(file).count, 1);
});

test("a code works once", async () => {
	const devices = new Devices(fresh());
	const { code } = await ask(devices);
	const second = await devices.claim({ code: code.code }, { name: "Someone else", via: "direct" });
	assert.deepEqual(second, { ok: false, problem: "used" });
});

test("a code nobody made, and one that was cancelled, are turned away", async () => {
	const devices = new Devices(fresh());
	const unknown = await devices.claim({ code: "never-made-here-0000" }, { name: "x", via: "direct" });
	assert.deepEqual(unknown, { ok: false, problem: "unknown" });

	const code = await devices.createCode();
	devices.cancelCode(code.id);
	const cancelled = await devices.claim({ code: code.code }, { name: "x", via: "direct" });
	assert.deepEqual(cancelled, { ok: false, problem: "expired" });
});

test("declining leaves nothing paired, and can't be answered twice", async () => {
	const devices = new Devices(fresh());
	const { request } = await ask(devices);
	assert.deepEqual(devices.decide(request.id, false, terminal), { ok: true, device: null });
	assert.equal((await devices.status(request.claim))?.state, "denied");
	assert.equal(devices.count, 0);
	assert.deepEqual(devices.decide(request.id, true, terminal), { ok: false, state: "denied" });
});

test("a device that stops asking can't be allowed after", async () => {
	const devices = new Devices(fresh());
	const { request } = await ask(devices);
	devices.cancel(request.claim);
	assert.deepEqual(devices.decide(request.id, true, terminal), { ok: false, state: "cancelled" });
	assert.equal(devices.count, 0);
});

test("only so many devices can wait at once", async () => {
	const devices = new Devices(fresh());
	for (let i = 0; i < 5; i++) await ask(devices, `Phone ${i}`);
	const code = await devices.createCode();
	const sixth = await devices.claim({ code: code.code }, { name: "One too many", via: "direct" });
	assert.deepEqual(sixth, { ok: false, problem: "busy" });
});

test("waiting for an answer returns as soon as there is one", async () => {
	const devices = new Devices(fresh());
	const { request } = await ask(devices);
	const waiting = devices.status(request.claim, 5000);
	setTimeout(() => devices.decide(request.id, true, terminal), 10);
	const started = Date.now();
	assert.equal((await waiting)?.state, "approved");
	assert.ok(Date.now() - started < 2000);
});

test("removing a device cuts it off, and says who did it", async () => {
	const devices = new Devices(fresh());
	const { request } = await ask(devices);
	const decided = devices.decide(request.id, true, terminal);
	if (!decided.ok || !decided.device) throw new Error("unreachable");
	const id = decided.device.id;

	const heard: string[] = [];
	devices.on("removed", (device, by) => heard.push(`${device.id}:${by.kind}`));
	assert.equal(devices.remove(id, terminal)?.id, id);
	assert.deepEqual(heard, [`${id}:terminal`]);
	assert.equal(devices.device(id), null);
	assert.equal(devices.key({ kind: "device", id }), null);
	assert.equal(devices.remove(id, terminal), null);
});

test("names from a phone are made safe to print", async () => {
	const devices = new Devices(fresh());
	const { request } = await ask(devices, "  iPhone\u001b[31m\n Safari  ");
	devices.decide(request.id, true, terminal);
	assert.deepEqual(devices.names(), ["iPhone [31m Safari"]);
});

test("a devices file that can't be read is put aside, not written over", () => {
	const file = fresh();
	writeFileSync(file, "{ not json");
	const devices = new Devices(file);
	assert.equal(devices.count, 0);
	assert.ok(devices.damaged);
	assert.ok(!existsSync(file));
	const kept = readdirSync(dirname(file)).filter((name) => name.startsWith("devices.json.damaged-"));
	assert.equal(kept.length, 1);
	assert.equal(readFileSync(join(dirname(file), kept[0] ?? ""), "utf8"), "{ not json");
});
