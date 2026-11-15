import { ArrowCircleUpIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { APP_VERSION, computerIsBehind } from "@/lib/version";

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
 * Through the relay the app is always the newest release, while the computer runs whichever Kiteline
 * was installed there. When that one is older, say so: what's new here may not work until it's updated.
 */
export function UpdateNotice({ computer, host }: { computer: string | undefined; host: string }) {
	const pair = `${computer}>${APP_VERSION}`;
	const [dismissed, setDismissed] = useState(() => dismissedFor() === pair);
	if (dismissed || !computerIsBehind(computer)) return null;

	return (
		<section className="bg-warning-soft mb-6 rounded-2xl p-4">
			<div className="flex items-start gap-3">
				<ArrowCircleUpIcon weight="fill" className="text-warning mt-0.5 size-5 flex-none" />
				<div className="min-w-0 flex-1">
					<p className="text-[15px] leading-snug font-semibold">Update Kiteline on {host}</p>
					<p className="text-muted-foreground mt-1 text-[13px] leading-snug">
						It runs v{computer}, and this app is v{APP_VERSION}. Some things may not work until it's updated:
						run this there, then start Kiteline again.
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
