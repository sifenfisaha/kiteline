import { ORPCError } from "@orpc/server";
import z from "zod";

import type { Context } from "../context";
import { protectedProcedure } from "../index";

const key = z.string().regex(/^[\w-]+$/);

/** Notifications are a device's own: the terminal has none to turn on. */
function device(context: Context) {
	if (context.caller?.kind !== "device") {
		throw new ORPCError("BAD_REQUEST", { message: "Notifications are turned on from a paired device." });
	}
	return context.caller.id;
}

/** Lock-screen notifications for the device that's asking; see ../push. */
export const pushRouter = {
	status: protectedProcedure.handler(({ context }) => context.push.status(device(context))),

	subscribe: protectedProcedure
		.input(
			z.object({
				endpoint: z.url().max(2000),
				p256dh: key.min(80).max(100),
				auth: key.min(16).max(64),
				vapid: z.object({ d: key.max(64), x: key.max(64), y: key.max(64) }),
				/** Giving a changed subscription again, with nothing to show for it. */
				quiet: z.boolean().optional(),
			}),
		)
		.handler(async ({ input: { quiet, ...subscription }, context }) => {
			await context.push.subscribe(device(context), subscription, { quiet });
			return { ok: true };
		}),

	unsubscribe: protectedProcedure.handler(({ context }) => {
		context.push.unsubscribe(device(context));
		return { ok: true };
	}),

	/** Whether Kiteline is on this device's screen: while it is, it isn't sent notifications. */
	presence: protectedProcedure.input(z.object({ visible: z.boolean() })).handler(({ input, context }) => {
		context.push.presence(device(context), input.visible);
		return { ok: true };
	}),
};
