import { ArrowCircleUpIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { APP_VERSION, computerIsBehind, newest } from "@/lib/version";

const KEY = "kiteline:update-notice";
const COMMAND = "npm install -g kiteline@latest";

function dismissedFor() {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

/**
 * Says when the computer's Kiteline is behind: a newer one is out, as the computer itself found on npm;
 * or, through the relay, this app is newer than the computer, and what's new here may not work until
 * it's updated.
 */
export function UpdateNotice({
	computer,
	latest,
	host,
}: {
	computer: string | undefined;
	latest?: string | null;
	host: string;
}) {
	const target = newest(APP_VERSION, latest);
	const pair = `${computer}>${target}`;
	const [dismissed, setDismissed] = useState(() => dismissedFor() === pair);
	if (dismissed || !computerIsBehind(computer, target)) return null;
	// Only an app ahead of its computer can break things; a release that's merely out is good news.
	const ahead = computerIsBehind(computer);

	return (
		<section className="bg-warning-soft mb-6 rounded-2xl p-4">
			<div className="flex items-start gap-3">
				<ArrowCircleUpIcon weight="fill" className="text-warning mt-0.5 size-5 flex-none" />
				<div className="min-w-0 flex-1">
					<p className="text-[15px] leading-snug font-semibold">Update Kiteline on {host}</p>
					<p className="text-muted-foreground mt-1 text-[13px] leading-snug">
						{ahead
							? `It runs v${computer}, and this app is v${APP_VERSION}. Some things may not work until it's updated. `
							: `It runs v${computer}, and v${target} is out. `}
						Run this there, then start Kiteline again.
					</p>
					<div className="bg-background/60 mt-3 flex items-center gap-2 rounded-xl py-1 pr-1 pl-3">
						<code className="min-w-0 flex-1 truncate font-mono text-[13px]">{COMMAND}</code>
						<CopyButton text={COMMAND} />
					</div>
				</div>
				<button
					type="button"
					aria-label="Dismiss"
					onClick={() => {
						setDismissed(true);
						try {
							localStorage.setItem(KEY, pair);
						} catch {}
					}}
					className="text-icon hover:text-foreground -mt-1 -mr-1 inline-flex size-8 flex-none items-center justify-center rounded-full"
				>
					<XIcon weight="bold" className="size-4" />
				</button>
			</div>
		</section>
	);
}
