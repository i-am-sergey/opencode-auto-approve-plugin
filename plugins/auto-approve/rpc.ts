import { Rpc } from "@opencode/plugin/rpc"

export const AutoApproveNotifications = Rpc.define({
  id: "auto_approve_notifications",
  methods: {},
  events: {
    status: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          status: { type: "string", enum: ["reviewing", "approved", "abstained", "external-resolution"] },
        },
        required: ["sessionID", "status"],
        additionalProperties: false,
      },
    },
  },
})
