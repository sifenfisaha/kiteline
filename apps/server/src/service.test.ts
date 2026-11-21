import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { launcher, plistText, unitText } from "./service";

/** Runs with the settings a person might have, and puts their own back after. */
function withEnv<T>(env: Record<string, string | undefined>, run: () => T) {
	const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const QUIET = {
	PORT: undefined,
	HOST: undefined,
	KITELINE_PUBLIC_URL: undefined,
	KITELINE_RELAY: undefined,
	KITELINE_HOME: undefined,
	CLAUDE_PATH: undefined,
	KITELINE_ALLOW_BYPASS: undefined,
	KITELINE_MAX_SESSIONS: undefined,
	KITELINE_IDLE_MINUTES: undefined,
	KITELINE_UPDATE_CHECK: undefined,
};

test("the systemd unit runs the command, with the settings in force and nothing else", () => {
	const unit = withEnv(
		{ ...QUIET, KITELINE_RELAY: "on", PORT: "4600", SHELL: "/bin/zsh", PATH: "/usr/local/bin:/usr/bin" },
		() => unitText(["/usr/bin/node", "/opt/kite line/cli.mjs"]),
	);
	assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/kite line\/cli\.mjs"$/m);
	assert.match(unit, /^Environment="KITELINE_RELAY=on"$/m);
	assert.match(unit, /^Environment="PORT=4600"$/m);
	assert.match(unit, /^Environment="SHELL=\/bin\/zsh"$/m);
	assert.match(unit, /^Environment="PATH=\/usr\/local\/bin:\/usr\/bin"$/m);
	assert.match(unit, /^Restart=always$/m);
	assert.ok(!unit.includes("KITELINE_HOME"));
	assert.ok(unit.startsWith("# Written by `kiteline service install`"));
});

test("what systemd would read as its own is escaped", () => {
	const unit = withEnv({ ...QUIET, KITELINE_PUBLIC_URL: "https://a.example/50%" }, () =>
		unitText(["/home/me/$weird/node", 'say "hi"']),
	);
	assert.match(unit, /^ExecStart="\/home\/me\/\$\$weird\/node" "say \\"hi\\""$/m);
	assert.match(unit, /^Environment="KITELINE_PUBLIC_URL=https:\/\/a\.example\/50%%"$/m);
});

test("folders that won't last are left out of the service's PATH", () => {
	const unit = withEnv(
		{ ...QUIET, PATH: "/home/me/.npm/_npx/abc/node_modules/.bin:/usr/bin:/usr/bin:/proj/node_modules/.bin" },
		() => unitText(["/usr/bin/node", "/x/cli.mjs"]),
	);
	assert.match(unit, /^Environment="PATH=\/usr\/bin"$/m);
});

test("the Mac agent is a well-formed plist with the same command and settings", () => {
	const plist = withEnv(
		{ ...QUIET, KITELINE_RELAY: "on", SHELL: "/bin/zsh", PATH: "/opt/homebrew/bin:/usr/bin" },
		() =>
			plistText(["/opt/homebrew/bin/node", "/Users/me/a & b/cli.mjs"], "/Users/me/.kiteline/kiteline.log"),
	);
	assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
	assert.ok(plist.includes("Written by `kiteline service install`"));
	assert.ok(plist.includes("<key>Label</key>\n\t<string>dev.seefun.kiteline</string>"));
	assert.ok(
		plist.includes(
			"<array>\n\t\t<string>/opt/homebrew/bin/node</string>\n\t\t<string>/Users/me/a &amp; b/cli.mjs</string>\n\t</array>",
		),
	);
	assert.ok(plist.includes("<key>KITELINE_RELAY</key>\n\t\t<string>on</string>"));
	assert.ok(plist.includes("<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>"));
	assert.ok(plist.includes("<key>KeepAlive</key>\n\t<true/>"));
	assert.ok(plist.includes("<key>RunAtLoad</key>\n\t<true/>"));
	assert.ok(
		plist.includes("<key>StandardOutPath</key>\n\t<string>/Users/me/.kiteline/kiteline.log</string>"),
	);
	// Every tag that opens closes, in order.
	const stack: string[] = [];
	for (const [, close, name, selfClosing] of plist.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)) {
		if (selfClosing) continue;
		if (close) assert.equal(stack.pop(), name);
		else stack.push(name ?? "");
	}
	assert.deepEqual(stack, []);
});

// On a Mac, the system's own checker has the last word on whether launchd will take the file.
test("macOS accepts the agent's plist", { skip: process.platform !== "darwin" }, () => {
	const file = join(mkdtempSync(join(tmpdir(), "kiteline-plist-")), "agent.plist");
	writeFileSync(file, plistText(["/usr/local/bin/node", "/Users/me/a & b/cli.mjs"], "/tmp/kiteline.log"));
	const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
	assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});

test("an npm install is run as this Node with the real file", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiteline-service-")));
	const real = join(dir, "lib", "node_modules", "kiteline", "dist", "cli.mjs");
	mkdirSync(join(real, ".."), { recursive: true });
	writeFileSync(real, "");
	mkdirSync(join(dir, "bin"));
	symlinkSync(real, join(dir, "bin", "kiteline"));
	assert.deepEqual(launcher(join(dir, "bin", "kiteline"), "/usr/bin/node"), ["/usr/bin/node", real]);
});

test("a pnpm install is run by its command, which follows updates", () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "kiteline-pnpm-")));
	const real = join(
		home,
		"global",
		"5",
		".pnpm",
		"kiteline@0.3.4",
		"node_modules",
		"kiteline",
		"dist",
		"cli.mjs",
	);
	mkdirSync(join(real, ".."), { recursive: true });
	writeFileSync(real, "");
	const linked = join(home, "global", "5", "node_modules", "kiteline");
	mkdirSync(join(linked, ".."), { recursive: true });
	symlinkSync(join(real, "..", ".."), linked);
	mkdirSync(join(home, "bin"));
	writeFileSync(join(home, "bin", "kiteline"), "");
	assert.deepEqual(launcher(join(linked, "dist", "cli.mjs"), "/usr/bin/node"), [
		join(home, "bin", "kiteline"),
	]);
});
