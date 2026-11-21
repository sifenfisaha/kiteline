import {
	createCipheriv,
	createECDH,
	createPrivateKey,
	hkdfSync,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Notifications on a phone's lock screen, by Web Push: for when Claude Code needs an answer or a turn
 * has finished, and nobody is looking.
 *
 * The computer sends each one itself, straight to the phone's push service (Google's, Apple's or
 * Mozilla's), sealed to a key only that phone's browser holds: the push service passes it on unread,
 * and Kiteline's relay never sees it at all. The phone makes the key that signs the sends too, and
 * hands it to each computer it's paired with, so one phone can hear from all of them.
 */

/** What the phone's browser gives out when it subscribes, and the key to sign sends to it with. */
export type PushSubscription = {
	endpoint: string;
	/** The browser's public key, to seal messages to. */
	p256dh: string;
	auth: string;
	/** The phone's signing key, as the three parts of a P-256 JWK. */
	vapid: { d: string; x: string; y: string };
};

export type PushNote = {
	kind: "permission" | "done" | "error" | "hello";
	title: string;
	body: string;
	sessionId?: string;
	/** Which computer this is, through the relay, so a tap opens the right one. */
	computer?: string;
};

type Stored = PushSubscription & { device: string; addedAt: string };

/** Who to say the sender is: push services want an address, and this is the project's. */
const SUBJECT = "https://kiteline.seefun.dev";
/** A notification nobody collected by then isn't worth showing. */
const TTL_SECONDS = 60 * 60;
/** A push service that keeps failing has lost the subscription, whatever it says. */
const MAX_FAILURES = 5;
/**
 * How long a device's word that Kiteline is on its screen holds. It says so again every so often while
 * that's true, and a phone that locks or loses its connection just stops saying it.
 */
export const PRESENCE_MS = 45_000;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

function isSubscription(value: unknown): value is Stored {
	const s = value as Stored;
	return (
		!!s &&
		typeof s.device === "string" &&
		typeof s.endpoint === "string" &&
		typeof s.p256dh === "string" &&
		typeof s.auth === "string" &&
		!!s.vapid &&
		typeof s.vapid.d === "string" &&
		typeof s.vapid.x === "string" &&
		typeof s.vapid.y === "string"
	);
}

/** Only a push service over HTTPS: the address comes from a phone, and the computer calls it. */
export function validEndpoint(endpoint: string) {
	try {
		const url = new URL(endpoint);
		return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
	} catch {
		return false;
	}
}

/**
 * Seals a message to one browser, as RFC 8291 lays out (aes128gcm): a fresh key pair for each send,
 * agreed with the browser's own, so only it can open what comes out.
 */
export function sealPush(
	payload: Uint8Array,
	to: { p256dh: string; auth: string },
	// Fixed only in tests, to check against known answers.
	fixed?: { salt: Buffer; privateKey: Buffer },
) {
	const browser = unb64(to.p256dh);
	const secret = unb64(to.auth);
	if (browser.length !== 65 || browser[0] !== 4) throw new Error("That isn't a browser's push key.");
	const sender = createECDH("prime256v1");
	if (fixed) sender.setPrivateKey(fixed.privateKey);
	else sender.generateKeys();
	const ours = sender.getPublicKey();
	const shared = sender.computeSecret(browser);
	const salt = fixed?.salt ?? randomBytes(16);

	const info = Buffer.concat([Buffer.from("WebPush: info\0"), browser, ours]);
	const material = Buffer.from(hkdfSync("sha256", shared, secret, info, 32));
	const key = Buffer.from(hkdfSync("sha256", material, salt, "Content-Encoding: aes128gcm\0", 16));
	const nonce = Buffer.from(hkdfSync("sha256", material, salt, "Content-Encoding: nonce\0", 12));

	const cipher = createCipheriv("aes-128-gcm", key, nonce);
	// One record: the message, then the mark that says it's the last.
	const sealed = Buffer.concat([cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final()]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(4096, 16);
	header.writeUInt8(ours.length, 20);
	return Buffer.concat([header, ours, sealed, cipher.getAuthTag()]);
}

function signingKey(vapid: PushSubscription["vapid"]): KeyObject {
	return createPrivateKey({ key: { kty: "EC", crv: "P-256", ...vapid }, format: "jwk" });
}

/** The phone's signing key's public half, as the browser was given it when it subscribed. */
export function vapidPublicKey(vapid: PushSubscription["vapid"]) {
	return b64(Buffer.concat([Buffer.from([4]), unb64(vapid.x), unb64(vapid.y)]));
}

/** The header that tells a push service this send is from whoever the phone subscribed to (RFC 8292). */
export function vapidHeader(endpoint: string, vapid: PushSubscription["vapid"], now = Date.now()) {
	const part = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: SUBJECT };
	const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
	const signature = sign("sha256", Buffer.from(unsigned), {
		key: signingKey(vapid),
		dsaEncoding: "ieee-p1363",
	});
	return `vapid t=${unsigned}.${b64(signature)}, k=${vapidPublicKey(vapid)}`;
}

type Send = (url: string, init: RequestInit) => Promise<{ status: number }>;

export class Push {
	private subscriptions: Stored[];
	private readonly failures = new Map<string, number>();
	/** Devices that said their screen is showing Kiteline, and until when that's believed. */
	private readonly visible = new Map<string, number>();

	constructor(
		private readonly file: string,
		private readonly options: {
			/** This computer's address on the relay, so a tap on a notification opens the right one. */
			computer?: string;
			log?: (message: string) => void;
			send?: Send;
		},
	) {
		this.subscriptions = Push.load(file);
	}

	private static load(file: string): Stored[] {
		try {
			const data = JSON.parse(readFileSync(file, "utf8")) as { subscriptions?: unknown };
			return Array.isArray(data?.subscriptions) ? data.subscriptions.filter(isSubscription) : [];
		} catch {
			// None yet, or unreadable: each phone turns notifications on again.
			return [];
		}
	}

	private save() {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ version: 1, subscriptions: this.subscriptions }, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(temp, this.file);
	}

	/** Where this device's notifications go, if it has them on. */
	status(device: string) {
		const found = this.subscriptions.find((s) => s.device === device);
		return { enabled: !!found, endpoint: found?.endpoint ?? null };
	}

	/**
	 * Turns notifications on for a device, and sends one to show it worked: a subscription that can't be
	 * sent to isn't kept. `quiet` skips that, for a device giving a changed subscription again.
	 */
	async subscribe(device: string, subscription: PushSubscription, { quiet = false } = {}) {
		if (!validEndpoint(subscription.endpoint)) throw new Error("That isn't a push service's address.");
		// Checked now, so keys that can't be used are turned away here and not at the first notification.
		try {
			vapidHeader(subscription.endpoint, subscription.vapid);
			sealPush(new Uint8Array(), subscription);
		} catch {
			throw new Error("This phone's keys for notifications can't be used. Turn them off and on again.");
		}
		const stored: Stored = { ...subscription, device, addedAt: new Date().toISOString() };
		const outcome = quiet
			? "sent"
			: await this.deliver(stored, {
					kind: "hello",
					title: "Notifications are on",
					body: "Kiteline will tell you here when Claude Code needs you or finishes.",
				});
		if (outcome !== "sent") {
			throw new Error(
				outcome === "gone"
					? "This phone's push service turned the notification away. Turn notifications off and on again."
					: "Your computer couldn't reach this phone's push service. Check its internet connection.",
			);
		}
		this.subscriptions = [...this.subscriptions.filter((s) => s.device !== device), stored];
		this.failures.delete(device);
		this.save();
	}

	unsubscribe(device: string) {
		this.visible.delete(device);
		this.failures.delete(device);
		if (!this.subscriptions.some((s) => s.device === device)) return;
		this.subscriptions = this.subscriptions.filter((s) => s.device !== device);
		try {
			this.save();
		} catch {}
	}

	/** A device says whether Kiteline is on its screen: while it is, there's nothing to notify it of. */
	presence(device: string, visible: boolean) {
		if (visible) this.visible.set(device, Date.now() + PRESENCE_MS);
		else this.visible.delete(device);
	}

	private watching(device: string) {
		return (this.visible.get(device) ?? 0) > Date.now();
	}

	/** Tells every device that has notifications on and isn't looking at Kiteline right now. */
	async notify(note: PushNote) {
		const away = this.subscriptions.filter((s) => !this.watching(s.device));
		await Promise.all(
			away.map(async (subscription) => {
				const outcome = await this.deliver(subscription, note);
				if (outcome === "sent") {
					this.failures.delete(subscription.device);
					return;
				}
				const failures = (this.failures.get(subscription.device) ?? 0) + 1;
				this.failures.set(subscription.device, failures);
				if (outcome === "gone" || failures >= MAX_FAILURES) {
					this.options.log?.("A phone's notifications stopped working, so they're turned off for it.");
					this.unsubscribe(subscription.device);
				}
			}),
		);
	}

	private async deliver(to: Stored, note: PushNote): Promise<"sent" | "gone" | "failed"> {
		try {
			const computer = this.options.computer;
			const payload = Buffer.from(JSON.stringify({ ...note, ...(computer ? { computer } : {}) }));
			const body = sealPush(payload, to);
			const send: Send = this.options.send ?? ((url, init) => fetch(url, init));
			const response = await send(to.endpoint, {
				method: "POST",
				headers: {
					authorization: vapidHeader(to.endpoint, to.vapid),
					"content-encoding": "aes128gcm",
					"content-type": "application/octet-stream",
					ttl: String(TTL_SECONDS),
					urgency: "high",
					// A newer note about the same session takes the place of one still waiting.
					...(note.sessionId ? { topic: note.sessionId.replaceAll("-", "").slice(0, 32) } : {}),
				},
				body: new Uint8Array(body),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status >= 200 && response.status < 300) return "sent";
			// Gone for good: the phone unsubscribed, or cleared the app's data.
			return response.status === 404 || response.status === 410 ? "gone" : "failed";
		} catch {
			return "failed";
		}
	}
}
