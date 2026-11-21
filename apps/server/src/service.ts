import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { kitelineHome, localAddress } from "./auth";
import { accent, bold, dim } from "./banner";
import { readSettings, SettingsError } from "./config";

/**
 * `kiteline service`: Kiteline as a background service written for this computer, so it starts with it
 * and restarts if it stops. On Linux that's a systemd user service, which also keeps going after you
 * log out; on a Mac, a launchd agent, which runs while you're logged in. What the docs once listed as
 * steps.
 */

// Another name lets a second Kiteline run beside the first, on its own port.
const NAME = process.env.KITELINE_SERVICE_NAME?.trim() || "kiteline";
const WRITTEN = "Written by `kiteline service install`. Run it again to change these settings.";
const MARK = `# ${WRITTEN}`;
/** launchd names its agents like addresses, back to front. */
const LABEL = `dev.seefun.${NAME}`;
/** The settings worth keeping in the service, when they're set now. Never a key. */
const KEPT = [
	"PORT",
	"HOST",
	"KITELINE_PUBLIC_URL",
	"KITELINE_RELAY",
	"KITELINE_HOME",
	"CLAUDE_PATH",
	"KITELINE_ALLOW_BYPASS",
	"KITELINE_MAX_SESSIONS",
	"KITELINE_IDLE_MINUTES",
	"KITELINE_UPDATE_CHECK",
] as const;

/** A label and a command, lined up with the others. */
const row = (label: string, value: string) => `${dim(label.padEnd(22))}${value}`;

function say(...lines: string[]) {
	console.log(["", ...lines.map((line) => (line ? `  ${line}` : "")), ""].join("\n"));
}

function fail(...lines: string[]): never {
	console.error(
		["", ...lines.map((line, i) => (i === 0 ? `  ${accent("◆")}  ${line}` : `     ${line}`)), ""].join("\n"),
	);
	process.exit(1);
}

function systemctl(...args: string[]) {
	return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
}

function launchctl(...args: string[]) {
	return spawnSync("launchctl", args, { encoding: "utf8" });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What differs between the two: where the service is written, and how it's started, stopped and read. */
type Backend = {
	file: string;
	text: (command: string[]) => string;
	/** "active" when it's running, else whatever the system calls its state. */
	state: () => string;
	/** Starts it, or starts it again with what was just written. Returns what went wrong, if anything. */
	start: () => Promise<string | null>;
	/** Stops it and takes its file away. */
	remove: () => void;
	logs: string;
	/** Seeing why it didn't come up. */
	recentLogs: string;
	/** What it does once set up, after "Kiteline runs in the background now." */
	promise: string;
	/** Anything left for the person to do, to have it start as early as it can. */
	finish: () => string;
};

function systemd(): Backend {
	const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const file = join(config, "systemd", "user", `${NAME}.service`);
	return {
		file,
		text: unitText,
		state: () => systemctl("is-active", NAME).stdout.trim(),
		start: async () => {
			for (const step of [["daemon-reload"], ["enable", NAME], ["restart", NAME]]) {
				const result = systemctl(...step);
				if (result.status !== 0) return `systemctl --user ${step.join(" ")} failed:\n${result.stderr.trim()}`;
			}
			return null;
		},
		remove: () => {
			systemctl("disable", "--now", NAME);
			rmSync(file);
			systemctl("daemon-reload");
		},
		logs: `journalctl --user -u ${NAME} -f`,
		recentLogs: `journalctl --user -u ${NAME} -n 40`,
		promise: "It starts with your computer and restarts if it stops.",
		finish: () => {
			// Without lingering, user services stop at logout and wait for a login after a reboot.
			const user = userInfo().username;
			const linger = spawnSync("loginctl", ["show-user", user, "--property=Linger", "--value"], {
				encoding: "utf8",
			});
			if (linger.stdout.trim() === "yes") return "";
			const enabled = spawnSync("loginctl", ["enable-linger", user], {
				stdio: ["inherit", "ignore", "pipe"],
			});
			return enabled.status === 0
				? ""
				: `To start it at boot, before anyone logs in, run once: ${accent(`sudo loginctl enable-linger ${user}`)}`;
		},
	};
}

function launchd(): Backend {
	const file = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
	const domain = `gui/${userInfo().uid}`;
	const target = `${domain}/${LABEL}`;
	const log = logFile();
	return {
		file,
		text: (command) => plistText(command, log),
		state: () => {
			const print = launchctl("print", target);
			if (print.status !== 0) return "not loaded";
			return /state = running/.test(print.stdout) ? "active" : "loaded, but not running";
		},
		start: async () => {
			mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
			// Out with the old one first; launchd takes a moment to let go of it.
			launchctl("bootout", target);
			let result = launchctl("bootstrap", domain, file);
			for (let i = 0; i < 12 && result.status !== 0; i++) {
				await sleep(250);
				result = launchctl("bootstrap", domain, file);
			}
			if (result.status !== 0) return `launchctl bootstrap ${domain} failed:\n${result.stderr.trim()}`;
			launchctl("enable", target);
			return null;
		},
		remove: () => {
			launchctl("bootout", target);
			rmSync(file);
		},
		logs: `tail -f ${log}`,
		recentLogs: `tail -n 40 ${log}`,
		promise: "It starts when you log in and restarts if it stops.",
		finish: () => "",
	};
}

function backend(): Backend {
	if (process.platform === "darwin") return launchd();
	if (process.platform !== "linux") {
		fail(
			"Setting Kiteline up to run in the background works on Linux and macOS so far.",
			`Here, keep ${bold("kiteline")} running in a terminal window.`,
		);
	}
	if (systemctl("show-environment").status !== 0) {
		fail(
			"This computer doesn't run systemd's user services, which the background service needs.",
			`Keep ${bold("kiteline")} running in a terminal window instead.`,
		);
	}
	return systemd();
}

/** Where the Mac service's output goes, beside Kiteline's other files: launchd keeps no log of its own. */
function logFile() {
	return join(kitelineHome(process.env.KITELINE_HOME?.trim() || undefined), `${NAME}.log`);
}

/** systemd reads % and, in commands, $ as its own; a quoted value keeps spaces. */
function quote(value: string, { command = false } = {}) {
	let out = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
	if (command) out = out.replaceAll("$", () => "$$");
	return `"${out}"`;
}

/** The settings worth keeping in the service, as they're set now, then the shell and folders to run with. */
function environment() {
	const kept = KEPT.flatMap((key) => {
		const value = process.env[key]?.trim();
		return value ? [[key, value] as const] : [];
	});
	return { kept, shell: process.env.SHELL || "/bin/sh", path: shellPath() };
}

/** The folders Claude Code's Bash tool should find tools in: the ones this terminal has, less throwaways. */
function shellPath() {
	const folders = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const kept = folders.filter((folder) => !/[\\/]_npx[\\/]|node_modules[\\/]\.bin/.test(folder));
	return [...new Set(kept)].join(delimiter) || "/usr/local/bin:/usr/bin:/bin";
}

/** One-off runners keep their copy only for a while; each one's own way to install it for good. */
const RUNNERS = [
	{ pattern: /[\\/]_npx[\\/]/, name: "npx", install: "npm install -g kiteline" },
	{ pattern: /[\\/]dlx[\\/]/, name: "pnpm dlx", install: "pnpm add -g kiteline" },
	{ pattern: /[\\/]bunx-/, name: "bunx", install: "bun add -g kiteline" },
];

/**
 * What the service runs. npm and bun install Kiteline at a path that stays put across updates, so the
 * service runs that file with this Node. pnpm keeps each global install in a folder of its own and
 * points its `kiteline` command at the current one, so there the service runs that command, which
 * still finds Kiteline after an update.
 */
export function launcher(script: string, node: string): string[] {
	const given = resolve(script);
	const real = realpathSync(given);
	const pnpmHome = /^(.*?)[\\/]global[\\/]v?\d+[\\/]/.exec(given)?.[1];
	if (pnpmHome && /[\\/]\.pnpm[\\/]/.test(real)) {
		const command = [join(pnpmHome, "bin", "kiteline"), join(pnpmHome, "kiteline")].find((shim) =>
			existsSync(shim),
		);
		if (command) return [command];
	}
	return [node, real];
}

export function unitText(command: string[]) {
	const { kept, shell, path } = environment();
	const settings = kept.map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`);
	return `${MARK}
[Unit]
Description=Kiteline: drive Claude Code from your phone
Documentation=https://kiteline.seefun.dev/docs/#always-on
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command.map((part) => quote(part, { command: true })).join(" ")}
${settings.length ? `${settings.join("\n")}\n` : ""}# Claude Code's Bash tool runs with this shell and finds tools in these folders, as in your terminal.
Environment=${quote(`SHELL=${shell}`)}
Environment=${quote(`PATH=${path}`)}
Restart=always
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

const xml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The same service as a launchd agent, for a Mac: started at login, and again whenever it stops. */
export function plistText(command: string[], log: string) {
	const { kept, shell, path } = environment();
	// Claude Code's Bash tool runs with this shell and finds tools in these folders, as in your terminal.
	const variables = [...kept, ["SHELL", shell] as const, ["PATH", path] as const];
	const text = (value: string) => `<string>${xml(value)}</string>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${WRITTEN} -->
<plist version="1.0">
<dict>
	<key>Label</key>
	${text(LABEL)}
	<key>ProgramArguments</key>
	<array>
${command.map((part) => `\t\t${text(part)}`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${variables.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t${text(value)}`).join("\n")}
	</dict>
	<key>WorkingDirectory</key>
	${text(homedir())}
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>3</integer>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	${text(log)}
	<key>StandardErrorPath</key>
	${text(log)}
</dict>
</plist>
`;
}

async function answers(url: string) {
	return fetch(`${url}/auth/status`, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);
}

async function install({ force }: { force: boolean }) {
	const service = backend();

	// npx and friends run a copy they may clear out later; a service needs one that stays.
	const script = process.argv[1] ?? "";
	const real = realpathSync(script);
	const runner = RUNNERS.find(({ pattern }) => pattern.test(real) || pattern.test(script));
	if (runner) {
		fail(
			`This copy of Kiteline came from ${runner.name}, which may clear it out later, and a service needs one that stays.`,
			"Install it, then set up the service with that copy:",
			"",
			`  ${accent(runner.install)}`,
			`  ${accent("kiteline service install")}`,
		);
	}

	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch (error) {
		if (!(error instanceof SettingsError)) throw error;
		fail(error.message);
	}

	const { file } = service;
	const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
	if (existing !== null && !existing.includes(WRITTEN) && !force) {
		fail(
			`There's already a ${NAME} service, set up by hand:`,
			dim(file),
			`Run ${bold("kiteline service install --force")} to replace it; the old file is kept beside it as .bak.`,
		);
	}

	const url = localAddress(settings.port, settings.host);
	const runningHere = service.state() === "active";
	if (!runningHere && (await answers(url))) {
		fail(
			`Something already answers on port ${settings.port}, perhaps Kiteline in another terminal.`,
			`Stop it first (Ctrl C in its window), then run ${bold("kiteline service install")} again.`,
		);
	}

	mkdirSync(dirname(file), { recursive: true });
	if (existing !== null && !existing.includes(WRITTEN)) copyFileSync(file, `${file}.bak`);
	writeFileSync(file, service.text(launcher(script, process.execPath)));

	// The service says where it answers when it starts; a fresh note means this start's is up.
	const serverFile = join(kitelineHome(settings.home), "server.json");
	const before = existsSync(serverFile) ? statSync(serverFile).mtimeMs : 0;
	const problem = await service.start();
	if (problem) fail(...problem.split("\n"));
	const note = service.finish();

	let up = false;
	for (let i = 0; i < 40 && !up; i++) {
		await sleep(250);
		const fresh = existsSync(serverFile) && statSync(serverFile).mtimeMs > before;
		up = fresh && (await answers(url));
	}
	if (!up) {
		fail(
			"The service is set up, but Kiteline didn't come up. See what it said with:",
			"",
			`  ${accent(service.recentLogs)}`,
		);
	}

	say(
		`${bold("Kiteline runs in the background now.")} ${service.promise}`,
		"",
		row("See what it's doing", service.logs),
		row("Pair a phone", "kiteline pair"),
		row("See paired devices", "kiteline devices"),
		row("Change its settings", "kiteline service install, with the new options"),
		row("Stop running it", "kiteline service uninstall"),
		...(note ? ["", note] : []),
	);

	// Nothing paired yet and someone at the keyboard: pair the first phone now.
	const { connectToKiteline } = await import("./control");
	const { client } = await connectToKiteline();
	const { devices } = await client.devices.list();
	if (!devices.length && process.stdin.isTTY && process.stdout.isTTY) {
		const { pairCommand } = await import("./pair-command");
		await pairCommand();
	}
}

function uninstall({ force }: { force: boolean }) {
	const service = backend();
	const { file } = service;
	if (!existsSync(file)) {
		say(`Kiteline isn't set up to run in the background, so there's nothing to take away.`);
		return;
	}
	if (!readFileSync(file, "utf8").includes(WRITTEN) && !force) {
		fail(
			`The ${NAME} service was set up by hand:`,
			dim(file),
			`Run ${bold("kiteline service uninstall --force")} to remove it anyway.`,
		);
	}
	service.remove();
	say(
		`${bold("Kiteline no longer runs in the background.")} Paired phones stay paired.`,
		`Start it in a terminal with ${accent("kiteline")} whenever you like.`,
	);
}

function status() {
	const service = backend();
	const { file } = service;
	if (!existsSync(file)) {
		say(
			"Kiteline isn't set up to run in the background.",
			`Set it up with ${accent("kiteline service install")}: it starts with your computer and keeps going.`,
		);
		return;
	}
	const state = service.state();
	say(
		state === "active"
			? `${bold("Kiteline is running in the background.")}`
			: `${bold(`The ${NAME} service is set up, but it's ${state || "not running"}.`)}`,
		dim(file),
		"",
		row("See what it's doing", service.logs),
		row("Pair a phone", "kiteline pair"),
		row("See paired devices", "kiteline devices"),
		row("Stop running it", "kiteline service uninstall"),
	);
}

/** How to start the background service again, for a hint to someone whose Kiteline is out of date. */
export function restartCommand() {
	if (process.platform === "linux") return `systemctl --user restart ${NAME}`;
	if (process.platform === "darwin") return `launchctl kickstart -k gui/${userInfo().uid}/${LABEL}`;
	return null;
}

export async function service(action: string | undefined, options: { force: boolean }) {
	switch (action) {
		case "install":
			return install(options);
		case "uninstall":
		case "remove":
			return uninstall(options);
		case undefined:
		case "status":
			return status();
		default:
			fail(`"kiteline service ${action}" isn't a thing. Try install, uninstall or status.`);
	}
}
