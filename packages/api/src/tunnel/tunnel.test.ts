import assert from "node:assert/strict";
import { test } from "node:test";

import { AsyncQueue } from "../agent/queue";
import {
	type Bytes,
	Frame,
	HandshakeError,
	type Identity,
	importSecret,
	initiate,
	pairingKey,
	respond,
	UnknownKey,
} from "./crypto";
import { json, Msg, pack, parseJson, unpack } from "./messages";
import { fromBase64Url, hostIdFor, relaySocketUrl, toBase64Url } from "./relay-protocol";

const secretBytes = (fill: number) => new Uint8Array(32).fill(fill) as Bytes;
const phone: Identity = { kind: "device", id: "d".repeat(22) };

/** Two ends of a wire, each reading what the other sends. */
function wire() {
	const toHost = new AsyncQueue<Bytes>();
	const toPhone = new AsyncQueue<Bytes>();
	const reader = (queue: AsyncQueue<Bytes>) => {
		const frames = queue[Symbol.asyncIterator]();
		return async () => {
			const { value, done } = await frames.next();
			if (done) throw new Error("closed");
			return value;
		};
	};
	return {
		phone: { send: (frame: Bytes) => toHost.push(frame), next: reader(toPhone) },
		host: { send: (frame: Bytes) => toPhone.push(frame), next: reader(toHost) },
	};
}

async function handshake(phoneFill: number, hostFill: number | null) {
	const { phone: p, host: h } = wire();
	const hosting = (async () => {
		const hello = await h.next();
		const keyFor = async () => (hostFill === null ? null : importSecret(secretBytes(hostFill)));
		return respond(keyFor, hello, h.send, h.next);
	})();
	hosting.catch(() => {});
	const calling = initiate(phone, await importSecret(secretBytes(phoneFill)), p.send, p.next);
	return { hosting, calling };
}

test("a message is packed with its type and stream, and comes back the same", () => {
	const packed = pack(Msg.Data, 70_000, json({ hello: "there" }));
	assert.equal(packed.length, 5 + 17);
	const { type, stream, payload } = unpack(packed);
	assert.equal(type, Msg.Data);
	assert.equal(stream, 70_000);
	assert.deepEqual(parseJson(payload), { hello: "there" });

	const bare = unpack(pack(Msg.Ping, 0));
	assert.equal(bare.type, Msg.Ping);
	assert.equal(bare.payload.length, 0);
});

test("a message cut short is refused", () => {
	assert.throws(() => unpack(new Uint8Array(4) as Bytes), /cut short/);
});

test("unpacking reads a message that sits inside a larger buffer", () => {
	const packed = pack(Msg.Body, 9, Uint8Array.of(1, 2, 3));
	const larger = new Uint8Array(packed.length + 6);
	larger.set(packed, 3);
	const { type, stream, payload } = unpack(larger.subarray(3, 3 + packed.length) as Bytes);
	assert.equal(type, Msg.Body);
	assert.equal(stream, 9);
	assert.deepEqual([...payload], [1, 2, 3]);
});

test("both ends holding the same key agree, and can talk both ways", async () => {
	const { hosting, calling } = await handshake(7, 7);
	const [host, client] = await Promise.all([hosting, calling]);
	assert.deepEqual(host.identity, phone);

	const up = await client.seal(json("from the phone"));
	assert.equal(up[0], Frame.Sealed);
	assert.equal(parseJson(await host.cipher.open(up)), "from the phone");
	const down = await host.cipher.seal(json("from the computer"));
	assert.equal(parseJson(await client.open(down)), "from the computer");
});

test("a phone with the wrong key is found out by both ends", async () => {
	const { hosting, calling } = await handshake(7, 8);
	await assert.rejects(calling, HandshakeError);
	// The phone gives up without confirming, so the computer never accepts it either.
	const settled = await Promise.race([
		hosting.then(
			() => "accepted",
			() => "refused",
		),
		new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
	]);
	assert.notEqual(settled, "accepted");
});

test("a key the computer doesn't know is turned away by name", async () => {
	const { hosting } = await handshake(7, null);
	await assert.rejects(hosting, UnknownKey);
});

test("a sealed message can't be replayed, reordered or altered", async () => {
	const { hosting, calling } = await handshake(3, 3);
	const [host, client] = await Promise.all([hosting, calling]);
	const first = await client.seal(json(1));
	const second = await client.seal(json(2));

	await assert.rejects(host.cipher.open(second), "out of order");
	// That attempt used up a place in line, as a real one would: the connection is over.
	const fresh = await handshake(3, 3);
	const [host2, client2] = await Promise.all([fresh.hosting, fresh.calling]);
	const sealed = await client2.seal(json("once"));
	assert.equal(parseJson(await host2.cipher.open(sealed)), "once");
	await assert.rejects(host2.cipher.open(sealed), "replayed");

	const altered = (await client2.seal(json("twice"))).slice() as Bytes;
	altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
	await assert.rejects(host2.cipher.open(altered), "altered");
	assert.ok(first.length > 0);
});

test("a pairing code gives the same key and name each time, and the name gives nothing away", async () => {
	const a = await pairingKey("abcdefghijklmnopqrstuv");
	const b = await pairingKey("abcdefghijklmnopqrstuv");
	const other = await pairingKey("abcdefghijklmnopqrstuw");
	assert.equal(a.id, b.id);
	assert.deepEqual(a.secret, b.secret);
	assert.notEqual(a.id, other.id);
	assert.match(a.id, /^[\w-]{22}$/);
	assert.ok(!a.id.includes("abcdefgh"));
});

test("relay addresses and encodings", async () => {
	const bytes = Uint8Array.of(0, 250, 251, 252, 253, 254, 255);
	assert.deepEqual([...fromBase64Url(toBase64Url(bytes))], [...bytes]);
	assert.match(toBase64Url(bytes), /^[\w-]+$/);
	assert.match(await hostIdFor(secretBytes(1)), /^[\w-]{22}$/);
	assert.equal(await hostIdFor(secretBytes(1)), await hostIdFor(secretBytes(1)));
	assert.equal(relaySocketUrl("https://relay.example/", "/x"), "wss://relay.example/x");
	assert.equal(relaySocketUrl("http://localhost:8080", "/x"), "ws://localhost:8080/x");
});
