import type { RunSummary } from "@kiteline/api/agent/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { client, isUnauthorized, lostPairing, orpc } from "./orpc";

/** Every live session on the computer, kept current over one event stream. */
export function useLiveRuns() {
	const [runs, setRuns] = useState<RunSummary[] | null>(null);
	const [connected, setConnected] = useState(false);
	const queryClient = useQueryClient();

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		let attempt = 0;
		let previous = new Set<string>();
		let wake: (() => void) | null = null;
		let open: AbortController | null = null;

		void (async () => {
			while (!signal.aborted) {
				const connection = new AbortController();
				open = connection;
				const drop = () => connection.abort();
				signal.addEventListener("abort", drop, { once: true });
				try {
					const stream = await client.runs.list(undefined, { signal: connection.signal });
					setConnected(true);
					attempt = 0;
					for await (const list of stream) {
						setRuns(list);
						const ids = new Set(list.map((r) => r.sessionId));
						// A session that just went to sleep has fresh transcript data.
						if ([...previous].some((id) => !ids.has(id))) {
							void queryClient.invalidateQueries({ queryKey: orpc.sessions.list.key() });
						}
						previous = ids;
					}
				} catch (error) {
					if (signal.aborted) break;
					// Dropped on purpose to reconnect: go straight back.
					if (connection.signal.aborted) {
						attempt = 0;
						continue;
					}
					if (isUnauthorized(error)) {
						lostPairing();
						break;
					}
				} finally {
					signal.removeEventListener("abort", drop);
				}
				setConnected(false);
				if (signal.aborted) break;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt++));
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
					signal.addEventListener("abort", wake, { once: true });
				});
			}
		})();

		// A phone that slept can leave a stream that looks open but is dead: start a fresh one.
		let hiddenAt = 0;
		const onVisible = () => {
			if (document.visibilityState === "hidden") {
				hiddenAt = Date.now();
				return;
			}
			wake?.();
			if (hiddenAt && Date.now() - hiddenAt > 3000) open?.abort();
			hiddenAt = 0;
		};
		const onOnline = () => {
			wake?.();
			open?.abort();
		};
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("online", onOnline);
		return () => {
			controller.abort();
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("online", onOnline);
		};
	}, [queryClient]);

	return { runs, connected };
}
