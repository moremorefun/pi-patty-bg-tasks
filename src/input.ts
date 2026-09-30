// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Cooperative steering (Claude Code parity): ANY input typed while a
        // foreground bash command is running backgrounds that command and
        // re-delivers the input as the next turn — regardless of the message's
        // steer/followUp streamingBehavior. We only intercept when a foreground
        // slot is active; everything else falls through to Pi.
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };
        for (const detach of reg.attachWaiters) detach();
        if (reg.foreground.size === 0) return { action: "continue" };

        const text = event.text;
        const bg = backgroundActiveForeground(reg, ctx as UiContext);
        if (!bg) return { action: "continue" };

        // No ctx.abort(): requestPause() already makes the bash tool return its
        // "Process backgrounded as job-X" result, so aborting is redundant — and
        // harmful. Pi's agent loop does not re-check signal.aborted before the
        // next model request, so the aborted signal hits lazy setup (auth
        // resolution) and surfaces as a turn-killing
        // `stopReason: "error" / "This operation was aborted"` (pi issue #8409,
        // fix PR #8635 still unmerged).
        //
        // Redeliver as steering, which is what Pi does for typed input anyway:
        // the message lands at the next turn boundary — right after the bash
        // result, before the next model request — so the turn survives.
        try {
            pi.sendUserMessage(text, { deliverAs: "steer" });
        } catch {
            // Session ended between backgrounding and resubmit — nothing to deliver to.
        }

        return { action: "handled" };
    });
}
