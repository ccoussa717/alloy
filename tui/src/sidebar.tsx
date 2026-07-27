import type { SidebarSnapshot } from "./session-store";
import { For, Show } from "solid-js";
import { theme } from "./theme";

function compactNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "k" : "m";
  return `${(value / divisor).toFixed(value % divisor === 0 ? 0 : 1)}${suffix}`;
}

export function contextRows(context: SidebarSnapshot["context"] | null): string[] {
  if (!context) return ["Waiting for session"];
  if (context.tokens === null || context.contextWindow === null || context.percent === null) {
    return ["Context recalculating", `$${context.cost.toFixed(2)} session`];
  }
  return [
    `${compactNumber(context.tokens)} / ${compactNumber(context.contextWindow)} tokens`,
    `${context.percent.toFixed(1)}% used`,
    `$${context.cost.toFixed(2)} session`,
  ];
}

export function mcpRows(items: SidebarSnapshot["mcp"]): string[] {
  return items.toSorted((left, right) => left.name.localeCompare(right.name)).flatMap((item) => {
    const glyph = item.status === "connected" ? "●" : item.status === "connecting" ? "◐" : item.status === "failed" ? "×" : "○";
    const detail = item.status === "connected"
      ? `${item.toolCount ?? 0} tools`
      : item.status;
    return [
      `${glyph} ${item.name} · ${detail}${item.transport ? ` · ${item.transport}` : ""}`,
      ...(item.error ? [`  ${item.error}`] : []),
    ];
  });
}

function rowColor(row: string): string {
  if (row.startsWith("●")) return theme.success;
  if (row.startsWith("◐")) return theme.warning;
  if (row.startsWith("×") || row.startsWith("  ")) return theme.error;
  return theme.muted;
}

export function Sidebar(props: {
  snapshot: SidebarSnapshot | null;
  cwd: string;
  version: string;
  width: number;
  height: number;
}) {
  const context = () => contextRows(props.snapshot?.context ?? null);
  const mcp = () => mcpRows(props.snapshot?.mcp ?? []);
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      backgroundColor={theme.panel}
      border={["left"]}
      borderColor={theme.border}
      paddingLeft={2}
      paddingRight={1}
      paddingTop={1}
    >
      <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
        <text fg={theme.textStrong}>CONTEXT</text>
        <For each={context()}>{(row) => <text fg={theme.muted}>{row}</text>}</For>

        <box height={1} />
        <text fg={theme.textStrong}>MCP</text>
        <Show when={mcp().length > 0} fallback={<text fg={theme.dim}>No servers configured</text>}>
          <For each={mcp()}>{(row) => <text fg={rowColor(row)} wrapMode="char">{row}</text>}</For>
        </Show>

        <box height={1} />
        <text fg={theme.textStrong}>LSP</text>
        <Show when={props.snapshot?.lsp.supported} fallback={<text fg={theme.dim}>Not available yet</text>}>
          <Show when={props.snapshot?.lsp.enabled} fallback={<text fg={theme.dim}>Disabled</text>}>
            <For each={props.snapshot?.lsp.items ?? []}>
              {(item) => <text fg={item.status === "connected" ? theme.success : item.status === "error" ? theme.error : theme.muted}>{item.id} · {item.status}</text>}
            </For>
          </Show>
        </Show>

        <box height={1} />
        <text fg={theme.textStrong}>TODO</text>
        <Show when={(props.snapshot?.todos.length ?? 0) > 0} fallback={<text fg={theme.dim}>Not available yet</text>}>
          <For each={props.snapshot?.todos ?? []}>
            {(item) => <text fg={item.status === "in_progress" ? theme.accent : item.status === "completed" ? theme.dim : theme.muted}>{item.status === "in_progress" ? "●" : item.status === "completed" ? "✓" : "○"} {item.content}</text>}
          </For>
        </Show>
      </scrollbox>

      <box flexShrink={0} flexDirection="column" paddingBottom={1}>
        <text fg={theme.dim} wrapMode="char">{props.cwd}</text>
        <text fg={theme.dim}>Alloy v{props.version}</text>
      </box>
    </box>
  );
}
