import assert from "node:assert/strict";
import {
	createDecipheriv,
	createECDH,
	createPublicKey,
	generateKeyPairSync,
	hkdfSync,
	verify,
} from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Push, type PushSubscription, sealPush, validEndpoint, vapidHeader, vapidPublicKey } from "./push";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A browser, as far as push goes: its key pair, its secret, and a signing key as a phone would make. */
function browser() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = Buffer.from("0123456789abcdef");
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const { d, x, y } = privateKey.export({ format: "jwk" });
	const subscription: PushSubscription = {
		endpoint: "https://push.example/send/abc",
		p256dh: b64(ecdh.getPublicKey()),
		auth: b64(auth),
		vapid: { d: d ?? "", x: x ?? "", y: y ?? "" },
	};
	return { ecdh, auth, subscription };
}

/** Opens a sealed message the way a browser does (RFC 8291). */
function open(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: Buffer) {
	const salt = body.subarray(0, 16);
	const keyLength = body.readUInt8(20);
	const sender = body.subarray(21, 21 + keyLength);
	const sealed = body.subarray(21 + keyLength);
	const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), sender]);
	const material = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(sender), auth, info, 32));
	const key = Buffer.from(hkdfSync("sha256", material, salt, "Content-Encoding: aes128gcm\0", 16));
	const nonce = Buffer.from(hkdfSync("sha256", material, salt, "Content-Encoding: nonce\0", 12));
	const decipher = createDecipheriv("aes-128-gcm", key, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	assert.equal(plain.at(-1), 2, "ends with the last-record mark");
	return plain.subarray(0, -1).toString();
}

test("a sealed push opens with the browser's key, and no other", () => {
	const { ecdh, auth, subscription } = browser();
	const body = sealPush(Buffer.from("needs your OK"), subscription);
	assert.equal(body.readUInt32BE(16), 4096);
	assert.equal(open(body, ecdh, auth), "needs your OK");

	const other = browser();
	assert.throws(() => open(body, other.ecdh, other.auth));
});

test("sealing matches the worked example in RFC 8291", () => {
	// Appendix A of the RFC: the same keys, salt and message must give the same bytes.
	const body = sealPush(
		Buffer.from("When I grow up, I want to be a watermelon"),
		{
			p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
			auth: "BTBZMqHH6r4Tts7J_aSIgg",
		},
		{
			salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
			privateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
		},
	);
	assert.equal(
		b64(body),
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
});

test("the signature on a send verifies against the key the browser was given", () => {
	const { subscription } = browser();
	const header = vapidHeader(subscription.endpoint, subscription.vapid, Date.UTC(2026, 0, 1));
	const [, token = "", key = ""] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header) ?? [];
	assert.equal(key, vapidPublicKey(subscription.vapid));

	const [head = "", claims = "", signature = ""] = token.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { typ: "JWT", alg: "ES256" });
	const said = JSON.parse(Buffer.from(claims, "base64url").toString()) as { aud: string; exp: number };
	assert.equal(said.aud, "https://push.example");
	assert.equal(said.exp, Date.UTC(2026, 0, 1) / 1000 + 12 * 60 * 60);

	const { x, y } = subscription.vapid;
	const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
	const ok = verify(
		"sha256",
		Buffer.from(`${head}.${claims}`),
		{ key: publicKey, dsaEncoding: "ieee-p1363" },
		Buffer.from(signature, "base64url"),
	);
	assert.ok(ok);
});

test("only a push service over HTTPS is called", () => {
	assert.ok(validEndpoint("https://fcm.googleapis.com/fcm/send/abc"));
	assert.ok(!validEndpoint("http://fcm.googleapis.com/fcm/send/abc"));
	assert.ok(!validEndpoint("https://user:pass@push.example/x"));
	assert.ok(!validEndpoint("file:///etc/passwd"));
	assert.ok(!validEndpoint("not an address"));
});

function setup(status: () => number) {
	const sent: { url: string; headers: Record<string, string> }[] = [];
	const file = join(mkdtempSync(join(tmpdir(), "kiteline-push-")), "push.json");
	const push = new Push(file, {
		computer: "c".repeat(22),
		send: async (url, init) => {
			sent.push({ url, headers: init.headers as Record<string, string> });
			return { status: status() };
		},
	});
	return { push, sent, file };
}

test("turning notifications on sends one, keeps the subscription, and survives a restart", async () => {
	const { push, sent, file } = setup(() => 201);
	const { subscription } = browser();
	await push.subscribe("phone", subscription);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.headers["content-encoding"], "aes128gcm");
	assert.deepEqual(push.status("phone"), { enabled: true, endpoint: subscription.endpoint });
	assert.deepEqual(push.status("other"), { enabled: false, endpoint: null });

	const again = new Push(file, {});
	assert.equal(again.status("phone").enabled, true);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).subscriptions.length, 1);
});

test("a subscription that can't be sent to isn't kept", async () => {
	const { push } = setup(() => 500);
	await assert.rejects(push.subscribe("phone", browser().subscription), /couldn't reach/);
	assert.equal(push.status("phone").enabled, false);

	const bad = { ...browser().subscription, p256dh: "AAAA" };
	await assert.rejects(setup(() => 201).push.subscribe("phone", bad), /can't be used/);
	const local = { ...browser().subscription, endpoint: "http://localhost:9/x" };
	await assert.rejects(setup(() => 201).push.subscribe("phone", local), /push service's address/);
});

test("a device looking at Kiteline isn't notified; one that looked away is", async () => {
	const { push, sent } = setup(() => 201);
	await push.subscribe("phone", browser().subscription);
	const note = { kind: "done" as const, title: "api is done", body: "All tests pass.", sessionId: "s" };

	push.presence("phone", true);
	await push.notify(note);
	assert.equal(sent.length, 1, "only the hello so far");

	push.presence("phone", false);
	await push.notify(note);
	assert.equal(sent.length, 2);
});

test("a subscription the push service says is gone is dropped", async () => {
	let status = 201;
	const { push } = setup(() => status);
	await push.subscribe("phone", browser().subscription);
	status = 410;
	await push.notify({ kind: "done", title: "t", body: "b" });
	assert.equal(push.status("phone").enabled, false);
});

test("a push service that's only down for a while keeps its subscription", async () => {
	let status = 201;
	const { push } = setup(() => status);
	await push.subscribe("phone", browser().subscription);
	status = 503;
	for (let i = 0; i < 4; i++) await push.notify({ kind: "done", title: "t", body: "b" });
	assert.equal(push.status("phone").enabled, true);
	await push.notify({ kind: "done", title: "t", body: "b" });
	assert.equal(push.status("phone").enabled, false, "five in a row is gone");
});
