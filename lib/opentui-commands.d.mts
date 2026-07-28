export interface OpenTuiCommand {
  name: string;
  description: string;
  aliases: readonly string[];
  argumentHint?: string;
}

export const OPENTUI_COMMANDS: readonly OpenTuiCommand[];
