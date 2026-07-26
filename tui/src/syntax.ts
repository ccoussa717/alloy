import { RGBA, SyntaxStyle } from "@opentui/core";
import { theme } from "./theme";

const color = (value: string) => RGBA.fromHex(value);

export const syntaxStyle = SyntaxStyle.fromTheme([
  { scope: ["default"], style: { foreground: color(theme.text) } },
  { scope: ["comment", "comment.documentation"], style: { foreground: color(theme.muted), italic: true } },
  { scope: ["string", "symbol", "character.special"], style: { foreground: color("#a6e3a1") } },
  { scope: ["number", "boolean", "constant"], style: { foreground: color(theme.warning) } },
  { scope: ["keyword", "keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine", "keyword.import", "keyword.directive", "keyword.modifier", "keyword.exception"], style: { foreground: color("#c792ea") } },
  { scope: ["keyword.type", "type", "type.builtin", "class", "module"], style: { foreground: color("#7fdbff") } },
  { scope: ["function", "function.call", "function.method", "function.method.call", "constructor"], style: { foreground: color("#82aaff") } },
  { scope: ["variable", "variable.parameter", "variable.member", "property", "parameter"], style: { foreground: color(theme.text) } },
  { scope: ["variable.builtin", "function.builtin", "module.builtin", "constant.builtin"], style: { foreground: color(theme.error) } },
  { scope: ["operator", "keyword.operator", "punctuation.delimiter", "punctuation.special"], style: { foreground: color(theme.accent) } },
  { scope: ["punctuation", "punctuation.bracket"], style: { foreground: color(theme.muted) } },
  { scope: ["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3"], style: { foreground: color(theme.textStrong), bold: true } },
  { scope: ["markup.bold", "markup.strong"], style: { foreground: color(theme.textStrong), bold: true } },
  { scope: ["markup.italic", "markup.quote"], style: { foreground: color(theme.warning), italic: true } },
  { scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"], style: { foreground: color(theme.accent) } },
  { scope: ["markup.link", "markup.link.label", "markup.link.url"], style: { foreground: color("#82aaff"), underline: true } },
]);
