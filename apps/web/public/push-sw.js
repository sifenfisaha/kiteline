/*
 * The part of Kiteline's service worker that shows notifications. Each one arrives sealed to this
 * browser from the computer itself, so it's read here and nowhere on the way.
 */

self.addEventListener("push", (event) => {
	let note = {};
	try {
		note = event.data ? event.data.json() : {};
	} catch {
		// Not one of Kiteline's: say something anyway, as a push that shows nothing loses its permission.
	}
	const session =
		typeof note.sessionId === "string" && /^[\w-]{36}$/.test(note.sessionId) ? note.sessionId : "";
	const computer =
		typeof note.computer === "string" && /^[\w-]{22}$/.test(note.computer) ? note.computer : "";
	const url = `${session ? `/s/${session}` : "/"}${computer ? `?computer=${computer}` : ""}`;
	event.waitUntil(
		self.registration.showNotification(typeof note.title === "string" ? note.title : "Kiteline", {
			body: typeof note.body === "string" ? note.body : "",
			// One notification a session: the newest takes the last one's place.
			tag: session || "kiteline",
			renotify: true,
			icon: "/pwa-192x192.png",
			badge: "/pwa-64x64.png",
			data: { url },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const path = event.notification.data?.url || "/";
	const url = new URL(path, self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows[0];
			if (!open) return self.clients.openWindow(url);
			// The app is open already: bring it forward, and let it go to the session itself.
			await open.focus().catch(() => {});
			open.postMessage({ type: "kiteline:open", url });
		})(),
	);
});
