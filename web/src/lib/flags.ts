// Flag buttons on server-rendered threads (issues and tool requests): each `<details data-flag-target="kind:id">` holds
// FlagChoices, and a choice is sent to the API for a moderator. Signed-in people only; the API answers 401 otherwise.
import { api, ApiError } from "./api";

/** Wires every flag box on the page. */
export function wireFlags(root: ParentNode = document) {
  for (const box of root.querySelectorAll<HTMLDetailsElement>("[data-flag-target]")) {
    box.addEventListener("click", async (ev) => {
      const button = (ev.target as Element).closest<HTMLButtonElement>("button[data-reason]");
      if (!button) return;
      const [kind, id] = box.dataset.flagTarget!.split(":");
      const out = box.querySelector<HTMLElement>("[data-flag-out]")!;
      button.disabled = true;
      try {
        await api("/flags", { method: "POST", body: JSON.stringify({ target_kind: kind, target_id: id, reason: button.dataset.reason }) });
        out.textContent = "Thanks. A moderator will look at it.";
      } catch (e) {
        out.textContent = e instanceof ApiError && e.status === 401 ? "Sign in to flag posts." : e instanceof Error ? e.message : "That didn't work.";
        button.disabled = false;
      }
    });
  }
}
