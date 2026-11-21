import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { client, orpc } from "./orpc";

/**
 * Notifications on this phone's lock screen, for when Claude Code needs an answer or finishes a turn.
 * The computer sends them itself, sealed to this browser. This phone makes the key those sends are
 * signed with and gives it to each computer it turns notifications on for, so one subscription hears
 * from all of them.
 */

const SIGNING_KEY = "kiteline:push:key";
/** How often a phone showing Kiteline says so; the computer believes it a little longer than this. */
const PRESENCE_EVERY_MS = 20_000;

type SigningKey = { d: string; x: string; y: string };

export type PushSupport =
	/** Ready to turn on. */
	| "ok"
	/** An iPhone or iPad only takes notifications from an app on the home screen. */
	| "install"
	/** Browsers only allow them over HTTPS. */
	| "insecure"
	| "blocked"
	| "unsupported";

const fromBase64Url = (text: string) =>
	Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const toBase64Url = (bytes: ArrayBuffer | null) =>
	bytes
		? btoa(String.fromCharCode(...new Uint8Array(bytes)))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, "")
		: "";

export function pushSupport(): PushSupport {
	if (typeof window === "undefined") return "unsupported";
	const apple =
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
	const installed =
		window.matchMedia?.("(display-mode: standalone)").matches ||
		(navigator as { standalone?: boolean }).standalone === true;
	if (!window.isSecureContext) return "insecure";
	if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
		return apple && !installed ? "install" : "unsupported";
	if (Notification.permission === "denied") return "blocked";
	return "ok";
}

/** What to tell someone whose phone can't take notifications as it is. */
export const SUPPORT_HINTS: Record<Exclude<PushSupport, "ok">, string> = {
	install:
		"On an iPhone or iPad, add Kiteline to your home screen first (Share, then Add to Home Screen), and turn notifications on from there.",
	insecure:
		"Notifications need a secure address. Open Kiteline through the relay or your Tailscale HTTPS address to turn them on.",
	blocked:
		"Notifications are blocked for Kiteline in this browser's settings. Allow them there, then turn them on here.",
	unsupported: "This browser doesn't do notifications for web apps.",
};

function readSigningKey(): SigningKey | null {
	try {
		const key = JSON.parse(localStorage.getItem(SIGNING_KEY) ?? "null") as SigningKey | null;
		return key && typeof key.d === "string" && typeof key.x === "string" && typeof key.y === "string"
			? key
			: null;
	} catch {
		return null;
	}
}

async function signingKey(): Promise<SigningKey> {
	const kept = readSigningKey();
	if (kept) return kept;
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
	const { d, x, y } = await crypto.subtle.exportKey("jwk", pair.privateKey);
	if (!d || !x || !y) throw new Error("This browser couldn't make a key for notifications.");
	const key = { d, x, y };
	localStorage.setItem(SIGNING_KEY, JSON.stringify(key));
	return key;
}

function publicBytes(key: SigningKey) {
	const x = fromBase64Url(key.x);
	const y = fromBase64Url(key.y);
	const out = new Uint8Array(65);
	out[0] = 4;
	out.set(x, 1);
	out.set(y, 33);
	return out;
}

async function registration() {
	const found = await navigator.serviceWorker.getRegistration();
	if (!found) throw new Error("Kiteline isn't ready for notifications yet. Reload the page and try again.");
	return navigator.serviceWorker.ready;
}

/** This browser's subscription, made with this phone's key: a new one if there's none, or it's another key's. */
async function subscription(key: SigningKey) {
	const manager = (await registration()).pushManager;
	const wanted = publicBytes(key);
	let found = await manager.getSubscription();
	const held = found?.options.applicationServerKey;
	if (found && (!held || toBase64Url(held) !== toBase64Url(wanted.buffer))) {
		await found.unsubscribe();
		found = null;
	}
	found ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
	return found;
}

async function tellComputer(key: SigningKey, quiet: boolean) {
	const found = await subscription(key);
	const p256dh = toBase64Url(found.getKey("p256dh"));
	const auth = toBase64Url(found.getKey("auth"));
	if (!p256dh || !auth) throw new Error("This browser didn't give out what notifications need.");
	await client.push.subscribe({ endpoint: found.endpoint, p256dh, auth, vapid: key, quiet });
}

/** Turns notifications on for the computer this phone is on. Call it from a tap: the browser asks then. */
export async function enablePush() {
	// Asked before anything else: an iPhone only shows the question straight from a tap.
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new Error(
			permission === "denied" ? SUPPORT_HINTS.blocked : "Notifications weren't allowed, so they stay off.",
		);
	}
	await tellComputer(await signingKey(), false);
}

/** Off for this computer only; the others this phone is paired with keep theirs. */
export async function disablePush() {
	await client.push.unsubscribe();
}

export function usePushStatus(enabled = true) {
	return useQuery(orpc.push.status.queryOptions({ staleTime: 60_000, enabled, retry: false }));
}

/**
 * Keeps notifications working while they're on: tells the computer when Kiteline is on screen, so it
 * only notifies a phone that isn't looking; clears the ones already read; follows a tap on one to its
 * session; and gives the computer this browser's subscription again when it has changed.
 */
export function usePushUpkeep() {
	const queryClient = useQueryClient();
	const supported = pushSupport() === "ok";
	const status = usePushStatus(supported);
	const enabled = supported && status.data?.enabled === true;
	const endpoint = status.data?.endpoint ?? null;

	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; url?: string } | null;
			if (data?.type !== "kiteline:open" || typeof data.url !== "string") return;
			const url = new URL(data.url, window.location.origin);
			if (url.origin === window.location.origin) window.location.assign(url.href);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, []);

	useEffect(() => {
		if (!enabled) return;
		const say = () => {
			const visible = document.visibilityState === "visible";
			void client.push.presence({ visible }).catch(() => {});
			if (!visible) return;
			void navigator.serviceWorker
				.getRegistration()
				.then((found) => found?.getNotifications())
				.then((shown) => {
					for (const notification of shown ?? []) notification.close();
				})
				.catch(() => {});
		};
		say();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") say();
		}, PRESENCE_EVERY_MS);
		document.addEventListener("visibilitychange", say);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", say);
		};
	}, [enabled]);

	// The browser may replace its subscription on its own; the computer needs the one that works now.
	useEffect(() => {
		if (!enabled || !endpoint || Notification.permission !== "granted") return;
		const key = readSigningKey();
		if (!key) return;
		let stopped = false;
		void (async () => {
			const found = await (await registration()).pushManager.getSubscription();
			if (stopped || found?.endpoint === endpoint) return;
			await tellComputer(key, true);
			void queryClient.invalidateQueries({ queryKey: orpc.push.status.key() });
		})().catch(() => {});
		return () => {
			stopped = true;
		};
	}, [enabled, endpoint, queryClient]);
}
