import { normalizePluginConfig } from "./src/config.js";
import { createTeamChatRuntime } from "./src/runtime.js";
import { TeamChatState } from "./src/state.js";

const plugin = {
  id: "agent-teamchat",
  name: "Agent TeamChat",
  description:
    "Identity-enforced multi-agent team room plugin (group sync, turn limits, optional autopilot dispatch)",
  version: "0.1.0",

  register(api) {
    const pluginConfig = normalizePluginConfig(api.pluginConfig, api.config);
    const state = new TeamChatState({ logger: api.logger });
    const runtime = createTeamChatRuntime(api, pluginConfig, state);

    if (pluginConfig.identity.enabled || pluginConfig.teamroom.enabled) {
      api.on("before_agent_start", runtime.beforeAgentStart);
      api.on("before_tool_call", runtime.beforeToolCall, { priority: 80 });
    }
    if (pluginConfig.teamroom.enabled) {
      api.on("before_message_write", runtime.beforeMessageWrite);
      api.on("message_sending", runtime.messageSending);
      api.on("message_received", runtime.messageReceived);
    }
    if (pluginConfig.command.enabled) {
      api.registerCommand({
        name: pluginConfig.command.name,
        description: "Team room status/reset for agent-teamchat plugin",
        acceptsArgs: true,
        requireAuth: pluginConfig.command.requireAuth,
        handler: runtime.commandHandler
      });
    }

    api.logger.info(
      `[teamchat] loaded: identity=${pluginConfig.identity.enabled ? "on" : "off"}, rooms=${pluginConfig.teamroom.rooms.length}, command=/${pluginConfig.command.name}`
    );
  }
};

export default plugin;
