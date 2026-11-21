import type { PermissionModeId } from "@kiteline/api/agent/types";
import { useSyncExternalStore } from "react";

import { currentComputerId } from "./relay";

/** Per-device conveniences only; everything that matters lives on the server. */
export type Prefs = {
	permissionMode: PermissionModeId;
	model: string | null;
	enterToSend: boolean;
	recentProjects: string[];
};

const KEY = "kiteline:prefs:v1";
/** Folders belong to a computer: each one this phone is paired with keeps its own recent ones. */
const computer = currentComputerId();
const PROJECTS = computer ? `kiteline:projects:${computer}` : null;
const DEFAULTS: Prefs = {
	permissionMode: "default",
	model: null,
	enterToSend: !window.matchMedia?.("(pointer: coarse)").matches,
	recentProjects: [],
};

function read(): Prefs {
	try {
		const raw = localStorage.getItem(KEY);
		const prefs = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
		if (!PROJECTS) return prefs;
		const projects = localStorage.getItem(PROJECTS);
		if (projects) return { ...prefs, recentProjects: JSON.parse(projects) as string[] };
		// The list from before computers were kept apart goes to the first one to ask, and no other.
		const apart = Object.keys(localStorage).some((key) => key.startsWith("kiteline:projects:"));
		if (!apart) localStorage.setItem(PROJECTS, JSON.stringify(prefs.recentProjects));
		return apart ? { ...prefs, recentProjects: [] } : prefs;
	} catch {
		return DEFAULTS;
	}
}

let current = read();
const listeners = new Set<() => void>();

export function setPrefs(patch: Partial<Prefs>) {
	current = { ...current, ...patch };
	try {
		if (PROJECTS) {
			if (patch.recentProjects) localStorage.setItem(PROJECTS, JSON.stringify(current.recentProjects));
			// The list from before computers were kept apart stays as it was.
			const shared = (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>).recentProjects ?? [];
			localStorage.setItem(KEY, JSON.stringify({ ...current, recentProjects: shared }));
		} else localStorage.setItem(KEY, JSON.stringify(current));
	} catch {
		// Private mode or blocked storage: keep the change for this visit only.
	}
	for (const listener of listeners) listener();
}

export function rememberProject(cwd: string) {
	setPrefs({ recentProjects: [cwd, ...current.recentProjects.filter((p) => p !== cwd)].slice(0, 8) });
}

export function usePrefs(): Prefs {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
}
