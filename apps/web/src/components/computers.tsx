import { Button } from "@kiteline/ui/components/button";
import { Sheet } from "@kiteline/ui/components/sheet";
import { cn } from "@kiteline/ui/lib/utils";
import { DesktopIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { type ComputerInfo, forgetOtherComputer, listComputers, onRelay, switchComputer } from "@/lib/relay";

const KEY = ["computers"];
const day = (at: number) => new Date(at).toLocaleDateString("en", { month: "short", day: "numeric" });
const nameOf = (computer: ComputerInfo) => computer.name ?? "A computer";

/**
 * The computers this phone is paired with. Through the relay one phone can hold several, each with its
 * own key; reached directly, the address is the computer, so there's only ever the one.
 */
export function useComputers() {
	const query = useQuery({ queryKey: KEY, queryFn: listComputers, enabled: onRelay, staleTime: 30_000 });
	return query.data ?? [];
}

function ComputerRow({
	computer,
	first,
	onSwitch,
	removable,
}: {
	computer: ComputerInfo;
	first: boolean;
	onSwitch?: () => void;
	removable?: boolean;
}) {
	return (
		<div className="pl-4">
			<div
				className={cn("flex min-h-[60px] items-center gap-3 py-2.5 pr-3", !first && "border-border border-t")}
			>
				<span className="bg-surface-2 text-icon inline-flex size-9 flex-none items-center justify-center rounded-full">
					<DesktopIcon weight="fill" className="size-[18px]" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="flex items-center gap-2 text-[15px] leading-tight">
						<span className="truncate">{nameOf(computer)}</span>
						{computer.current ? (
							<span className="bg-brand-soft text-brand-text flex-none rounded-full px-2 py-0.5 text-[11px] leading-tight font-medium">
								On it now
							</span>
						) : null}
					</p>
					<p className="text-muted-foreground mt-1 truncate text-[13px] leading-tight">
						Paired {day(computer.pairedAt)}
					</p>
				</div>
				{computer.current ? null : (
					<>
						{removable ? <ForgetButton computer={computer} /> : null}
						<Button size="sm" variant="secondary" onClick={onSwitch ?? (() => switchComputer(computer.id))}>
							Switch
						</Button>
					</>
				)}
			</div>
		</div>
	);
}

/** Two taps, like removing a device: the first asks, the second unpairs this phone from that computer. */
function ForgetButton({ computer }: { computer: ComputerInfo }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!confirming) return;
		const timer = setTimeout(() => setConfirming(false), 4000);
		return () => clearTimeout(timer);
	}, [confirming]);

	if (confirming)
		return (
			<Button
				size="sm"
				variant="destructive"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					await forgetOtherComputer(computer.id).catch(() => {});
					await queryClient.invalidateQueries({ queryKey: KEY });
					setBusy(false);
				}}
			>
				{busy ? "Unpairing…" : "Unpair"}
			</Button>
		);
	return (
		<button
			type="button"
			aria-label={`Unpair from ${nameOf(computer)}`}
			onClick={() => setConfirming(true)}
			className="text-icon hover:bg-surface-2 hover:text-destructive inline-flex size-9 flex-none items-center justify-center rounded-full transition-colors"
		>
			<TrashIcon className="size-[18px]" />
		</button>
	);
}

/** In Settings: every computer this phone is paired with, to switch to or unpair from. */
export function ComputerList({ computers }: { computers: ComputerInfo[] }) {
	return (
		<>
			{computers.map((computer, i) => (
				<ComputerRow key={computer.id} computer={computer} first={i === 0} removable />
			))}
		</>
	);
}

/** From the home screen: pick which computer to be on. */
export function ComputerSheet({
	open,
	onOpenChange,
	computers,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	computers: ComputerInfo[];
}) {
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			title="Your computers"
			description="Each has its own sessions. To add one, run kiteline pair on it and open the link on this phone."
		>
			<div className="bg-surface shadow-card overflow-hidden rounded-2xl">
				{computers.map((computer, i) => (
					<ComputerRow key={computer.id} computer={computer} first={i === 0} />
				))}
			</div>
		</Sheet>
	);
}
