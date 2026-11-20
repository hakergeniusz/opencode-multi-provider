/**
 * TUI part of opencode-multi-account.
 *
 * Adds `alt+a` to cycle accounts and an "Account: select" palette command with
 * an interactive picker. Uses only the documented TUI APIs and no JSX, so no
 * additional peer dependencies are required.
 */

import { Plugin } from "@opencode/plugin/tui"
import {
  buildGroups,
  findGroupByProvider,
  findAccount,
  loadConfig,
  nextAccount,
  type AccountGroup,
} from "./config"

export default Plugin.define({
  id: "multi-account.tui",
  setup(context) {
    const load = () => buildGroups(loadConfig(context.location?.directory ?? process.cwd(), context.options))
    let groups = load()

    const notify = (message: string, variant: "info" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Multi-account", message, variant })

    const activeSessionID = () => context.ui.tabs.list().find((tab) => tab.active)?.sessionID

    const switchTo = async (group: AccountGroup, providerID: string, modelID?: string) => {
      const sessionID = activeSessionID()
      if (!sessionID) {
        notify("Open a session before switching accounts", "warning")
        return
      }
      const id = modelID ?? context.ui.model.current()?.modelID
      if (!id) {
        notify("No model selected", "warning")
        return
      }
      try {
        await context.client.session.switchModel({ sessionID, model: { providerID, id } })
        const label = findAccount(group, providerID)?.label ?? providerID
        notify(`Switched to ${label}`, "info")
      } catch (e) {
        notify(`Failed to switch account: ${String(e)}`, "error")
      }
    }

    const cycle = async () => {
      groups = load()
      const current = context.ui.model.current()
      if (!current) {
        notify("No model selected", "warning")
        return
      }
      const group = findGroupByProvider(groups, current.providerID)
      if (!group || group.accounts.length < 2) {
        notify("Current model is not on a multi-account provider", "warning")
        return
      }
      await switchTo(group, nextAccount(group, current.providerID).providerID, current.modelID)
    }

    const select = async () => {
      groups = load()
      const current = context.ui.model.current()
      const options = groups.flatMap((group) =>
        group.accounts.map((account) => ({
          title: `${group.providerLabel} / ${account.label}${current?.providerID === account.providerID ? "  ●" : ""}`,
          value: { group, providerID: account.providerID },
        })),
      )
      if (options.length === 0) {
        notify("No multi-account providers configured", "warning")
        return
      }
      const chosen = await context.ui.dialog.select({
        title: "Select account",
        options,
        current: options.find((option) => option.value.providerID === current?.providerID)?.value,
      })
      if (chosen) await switchTo(chosen.group, chosen.providerID, current?.modelID)
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "multi-account.cycle",
          title: "Cycle multi-account provider",
          description: "Switch the current model to the next account's API key",
          group: "Multi Account",
          bind: "alt+a",
          palette: true,
          enabled: () => {
            const current = context.ui.model.current()
            return !!current && findGroupByProvider(groups, current.providerID) !== undefined
          },
          run: () => cycle(),
        },
        {
          id: "multi-account.select",
          title: "Account: select",
          description: "Pick a multi-account provider/account",
          group: "Multi Account",
          palette: true,
          run: () => select(),
        },
      ],
      bindings: ["multi-account.cycle"],
    }))
  },
})
