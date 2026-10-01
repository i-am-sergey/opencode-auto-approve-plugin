import { Plugin } from "@opencode/plugin/tui"
import { AutoApproveNotifications } from "./rpc.ts"

const notices = {
  reviewing: { message: "Auto-approve is reviewing this permission…", variant: "info" },
  approved: { message: "Approved once by auto-approve.", variant: "success" },
  abstained: { message: "Auto-approve reviewer abstained; permission remains pending.", variant: "warning" },
  "external-resolution": { message: "Permission resolved outside auto-approve; the responder is unknown.", variant: "info" },
} as const

export default Plugin.define({
  id: "opencode-auto-approve-notifications",
  setup(context) {
    const unsubscribe = context.client.rpc(AutoApproveNotifications).events.on("status", (event) => {
      const { sessionID, status } = event.data as { sessionID?: unknown; status?: unknown }
      if (typeof sessionID !== "string" || typeof status !== "string" || !Object.hasOwn(notices, status)) return
      const notice = notices[status as keyof typeof notices]
      context.ui.toast.show({ title: "Auto-approve", ...notice, sessionID })
    })
    return unsubscribe
  },
})
