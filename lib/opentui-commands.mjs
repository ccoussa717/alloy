export const OPENTUI_COMMANDS = [
  { name: "help", description: "Browse and search Alloy help", aliases: [] },
  { name: "new", description: "Start a new session", aliases: [] },
  { name: "clone", description: "Clone the current session", aliases: [] },
  { name: "compact", description: "Compact session context", aliases: [], argumentHint: "[instructions]" },
  { name: "session", description: "Show session statistics", aliases: [] },
  { name: "export", description: "Export the current session to HTML", aliases: [] },
  { name: "model", description: "Select the active model", aliases: [], argumentHint: "<provider/model>" },
  { name: "thinking", description: "Select the thinking level", aliases: [], argumentHint: "<level>" },
  { name: "sidebar", description: "Toggle workspace sidebar", aliases: [] },
  { name: "quit", description: "Exit Alloy", aliases: ["exit", "q"] },
];
