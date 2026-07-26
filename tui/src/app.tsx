import { addDefaultParsers, RGBA, type CliRenderer, type KeyEvent, type ScrollBoxRenderable, type Selection, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { displayPreview, displayText, messageBlocks, messageRole, toolSummary, type TranscriptBlock, type TranscriptToolStatus } from "./content";
import {
  resolveSubmission,
  THINKING_LEVELS,
  type LocalDialog,
  type SubmissionResolution,
} from "./commands";
import { RpcClient, type RpcExtensionUIResponse, type RpcMessage as ClientRpcMessage } from "./rpc-client";
import {
  activeExtensionDialog,
  createInitialState,
  isStreamingTranscriptMessage,
  reduceRpcMessage,
  type ExtensionDialog,
  type NotificationState,
  type RpcMessage,
  type SessionState,
  type ToolExecution,
} from "./session-store";
import parsers from "./parsers-config";
import { activityAnimationInterval, activityFrame, activityLabel, splashDivider } from "./presentation";
import { syntaxStyle } from "./syntax";
import { theme } from "./theme";

addDefaultParsers(parsers.parsers);

export interface AppState {
  session: SessionState;
}

export function createAppState(): AppState {
  return { session: createInitialState() };
}

export function reduceAppRpcMessage(state: AppState, message: RpcMessage): AppState {
  return { ...state, session: reduceRpcMessage(state.session, message) };
}

export function cancelExtensionDialog(state: AppState): RpcExtensionUIResponse | null {
  const dialog = activeExtensionDialog(state.session);
  return dialog ? { type: "extension_ui_response", id: dialog.id, cancelled: true } : null;
}

export function cancelExtensionDialogById(state: AppState, id: string): RpcExtensionUIResponse | null {
  return Object.prototype.hasOwnProperty.call(state.session.extensionDialogs.byId, id)
    ? { type: "extension_ui_response", id, cancelled: true }
    : null;
}

export function extensionDialogOptions(dialog: ExtensionDialog | null): string[] {
  if (dialog?.method === "select") return dialog.options ?? [];
  if (dialog?.method === "confirm") return ["Deny", "Allow"];
  return [];
}

export function extensionDialogResponse(
  dialog: ExtensionDialog,
  selected: number,
  value: string,
): RpcExtensionUIResponse {
  if (dialog.method === "select") {
    return { type: "extension_ui_response", id: dialog.id, value: dialog.options?.[selected] ?? "" };
  }
  if (dialog.method === "confirm") {
    return { type: "extension_ui_response", id: dialog.id, confirmed: selected === 1 };
  }
  return { type: "extension_ui_response", id: dialog.id, value };
}

export function latestNotifications(notifications: NotificationState[]): NotificationState[] {
  return notifications.slice(-8);
}

export function copySelectionToClipboard(
  renderer: Pick<CliRenderer, "copyToClipboardOSC52">,
  selection: Pick<Selection, "getSelectedText">,
): boolean {
  const text = selection.getSelectedText();
  return text.length > 0 && renderer.copyToClipboardOSC52(text);
}

export function appLayout(width: number, height: number) {
  const compact = width <= 40 || height <= 10;
  const horizontalPadding = compact ? 1 : 2;
  return {
    width,
    height,
    horizontalPadding,
    showIdentity: !compact,
    showComposerMeta: height > 10,
    composerMaxHeight: height <= 10 ? 1 : Math.min(6, Math.max(1, Math.floor(height / 3))),
    modalWidth: Math.min(60, Math.max(1, width - 2)),
  };
}

export interface AlloyAppProps {
  client: RpcClient;
  initialState: SessionState;
  version: string;
  subscribe: (listener: (message: ClientRpcMessage) => void) => () => void;
  onExit: (code: number) => void;
}

const HELP_LINES = [
  "Enter       send prompt",
  "Shift+Tab   Build / Plan mode",
  "PageUp/Down scroll transcript",
  "Ctrl+U/D    half-page scroll",
  "Mouse drag  copy selection on release",
  "Ctrl+C      abort, then exit when idle",
  "",
  "/new /compact /model /thinking",
  "/session /export /help /quit",
];

function modeLabel(statuses: Record<string, string>): string {
  const raw = statuses["alloy-mode"] ?? statuses.mode ?? "mode:build";
  const value = raw.replace(/^mode:/, "");
  return value ? value[0]!.toUpperCase() + value.slice(1) : "Build";
}

function cleanStatus(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function Block(props: { block: TranscriptBlock; user?: boolean; streaming?: boolean; execution?: ToolExecution; transcriptStatus?: TranscriptToolStatus; activityGlyph?: string }) {
  const color = () => (props.user ? theme.textStrong : theme.text);
  if (props.block.kind === "text") {
    return props.user ? (
      <text fg={color()}>{props.block.text}</text>
    ) : (
      <markdown
        syntaxStyle={syntaxStyle}
        streaming={props.streaming === true}
        internalBlockMode="top-level"
        content={props.block.text}
        tableOptions={{ style: "grid" }}
        fg={theme.text}
        bg={theme.background}
      />
    );
  }
  if (props.block.kind === "reasoning") {
    return (
      <box flexDirection="column">
        <text fg={theme.warning}>{props.block.redacted ? "Thought (redacted)" : "Thought"}</text>
        <text fg={theme.muted}>{props.block.text}</text>
      </box>
    );
  }
  if (props.block.kind === "tool-call") {
    const status = () => props.execution?.status ?? props.transcriptStatus;
    const glyph = () => status() === "running" ? props.activityGlyph ?? "■" : status() === "error" ? "×" : status() === "completed" ? "✓" : "•";
    const foreground = () => status() === "running" ? theme.accent : status() === "error" ? theme.error : theme.muted;
    return <text fg={foreground()}>{glyph()} {props.block.summary}</text>;
  }
  if (props.block.kind === "tool-result") {
    return (
      <box paddingLeft={2} flexDirection="column">
        <text fg={props.block.isError ? theme.error : theme.muted}>{props.block.preview || "(no output)"}</text>
        <Show when={props.block.truncated}>
          <text fg={theme.dim}>output truncated</text>
        </Show>
      </box>
    );
  }
  if (props.block.kind === "image" || props.block.kind === "file") {
    return <text fg={theme.muted}>[{props.block.kind}: {props.block.name ?? props.block.mimeType ?? "attachment"}]</text>;
  }
  if (props.block.kind === "custom") return <text fg={theme.muted}>{props.block.name}: {props.block.text}</text>;
  return <text fg={theme.muted}>{props.block.text}</text>;
}

export function AlloyApp(props: AlloyAppProps) {
  const renderer = useRenderer();
  useSelectionHandler((selection) => copySelectionToClipboard(renderer, selection));
  const dimensions = useTerminalDimensions();
  const layout = createMemo(() => appLayout(dimensions().width, dimensions().height));
  const [session, setSession] = createSignal(props.initialState);
  const [localDialog, setLocalDialog] = createSignal<LocalDialog | null>(null);
  const [dialogResult, setDialogResult] = createSignal<unknown>();
  const [selected, setSelected] = createSignal(0);
  const [dialogText, setDialogText] = createSignal("");
  const [activityFrameIndex, setActivityFrameIndex] = createSignal(0);
  const activityInterval = activityAnimationInterval();
  const activityActive = createMemo(() =>
    session().isStreaming ||
    session().isCompacting ||
    session().isRetrying ||
    Object.values(session().toolExecutions).some((tool) => tool.status === "running"),
  );
  let scroll!: ScrollBoxRenderable;
  let composer!: TextareaRenderable;
  let modalInput: TextareaRenderable | undefined;
  let submitting = false;
  let appliedEditorText = "";
  const submissionQueue: Array<{ value: string; restoreOnFailure: boolean }> = [];
  const extensionTimeouts = new Map<string, { delay: number; timer: ReturnType<typeof setTimeout> }>();

  const reduce = (message: RpcMessage) => {
    const current = session();
    const next = reduceRpcMessage(current, message);
    const sessionChanged = current.sessionId !== null && next.sessionId !== current.sessionId;
    batch(() => {
      setSession(next);
      if (sessionChanged) {
        setLocalDialog(null);
        setDialogResult(undefined);
      }
    });
  };
  const unsubscribe = props.subscribe((message) => {
    const previousSessionId = session().sessionId;
    reduce(message);
    const nextSessionId =
      message.type === "response" && message.command === "get_state" && message.data && typeof message.data === "object"
        ? (message.data as { sessionId?: unknown }).sessionId
        : undefined;
    if (typeof nextSessionId === "string" && previousSessionId !== null && nextSessionId !== previousSessionId) {
      void refresh();
    }
  });
  onCleanup(unsubscribe);

  onMount(() => {
    const focusTimer = setTimeout(() => composer?.focus(), 0);
    const scrollTimer = setTimeout(() => scroll?.scrollTo(scroll.scrollHeight), 50);
    onCleanup(() => {
      clearTimeout(focusTimer);
      clearTimeout(scrollTimer);
    });
  });

  createEffect(() => {
    const title = session().title.trim();
    renderer.setTerminalTitle(title ? `ALLOY | ${title.slice(0, 48)}` : "ALLOY");
  });
  onCleanup(() => renderer.setTerminalTitle(""));

  createEffect(() => {
    const value = session().editorText;
    if (!composer || value === appliedEditorText) return;
    appliedEditorText = value;
    composer.setText(value);
    composer.gotoBufferEnd();
  });

  createEffect(() => {
    const active = activityActive();
    if (!active) {
      setActivityFrameIndex(0);
      return;
    }
    if (activityInterval === null) return;
    const timer = setInterval(() => setActivityFrameIndex((frame) => frame + 1), activityInterval);
    onCleanup(() => clearInterval(timer));
  });

  const extensionDialog = createMemo(() => activeExtensionDialog(session()));
  const dialogKey = createMemo(() => extensionDialog()?.id ?? localDialog() ?? "");
  createEffect(() => {
    dialogKey();
    const dialog = extensionDialog();
    setSelected(0);
    setDialogText(dialog?.method === "editor" ? dialog.prefill ?? "" : "");
  });

  const options = createMemo(() => {
    const dialog = extensionDialog();
    if (dialog) return extensionDialogOptions(dialog);
    if (localDialog() === "model") return session().availableModels.map((model) => `${model.provider}/${model.id}`);
    if (localDialog() === "thinking") return [...THINKING_LEVELS];
    return [];
  });

  async function request(message: ClientRpcMessage) {
    try {
      const response = await props.client.request(message);
      if (response) reduce(response);
      return response;
    } catch (error) {
      reduce({ type: "backend_error", error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  async function refresh(): Promise<void> {
    for (const type of ["get_state", "get_messages", "get_commands", "get_available_models", "get_session_stats"]) {
      const response = await request({ type });
      if (!response?.success) return;
    }
  }

  function clearComposer(): void {
    composer.clear();
    appliedEditorText = "";
  }

  async function runResolution(resolution: SubmissionResolution): Promise<boolean> {
    if (resolution.kind === "none") return true;
    if (resolution.kind === "error") {
      reduce({ type: "backend_error", error: resolution.message });
      return false;
    }
    if (resolution.kind === "exit") {
      props.onExit(0);
      return true;
    }
    if (resolution.kind === "dialog") {
      setDialogResult(undefined);
      setLocalDialog(resolution.dialog);
      return true;
    }

    const response = await request(resolution.request);
    if (!response?.success) return false;
    if (resolution.refresh) await refresh();
    if (resolution.resultDialog) {
      setDialogResult(response.data);
      setLocalDialog(resolution.resultDialog);
    }
    setTimeout(() => scroll?.scrollTo(scroll.scrollHeight), 0);
    return true;
  }

  async function submitValue(value: string, restoreOnFailure = false): Promise<void> {
    submissionQueue.push({ value, restoreOnFailure });
    if (submitting) return;
    submitting = true;
    let failedComposerValue: string | undefined;
    try {
      while (submissionQueue.length > 0) {
        const next = submissionQueue.shift();
        if (next === undefined) continue;
        const handled = await runResolution(resolveSubmission(next.value, {
          isStreaming: session().isStreaming,
          commands: session().commands,
          models: session().availableModels,
        }));
        if (!handled && next.restoreOnFailure) failedComposerValue = next.value;
      }
    } finally {
      submitting = false;
      if (failedComposerValue !== undefined && !composer.plainText) {
        appliedEditorText = failedComposerValue;
        composer.setText(failedComposerValue);
        composer.gotoBufferEnd();
      }
    }
  }

  function submitComposer(): void {
    const value = composer.plainText;
    if (!value.trim()) return;
    clearComposer();
    void submitValue(value, true);
  }

  async function answerExtension(response: RpcExtensionUIResponse): Promise<void> {
    reduce(response);
    try {
      await props.client.request(response);
      setTimeout(() => composer?.focus(), 0);
    } catch (error) {
      reduce({ type: "backend_error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  createEffect(() => {
    const dialogs = session().extensionDialogs;
    const queued = new Set(dialogs.order);
    for (const [id, pending] of extensionTimeouts) {
      if (!queued.has(id)) {
        clearTimeout(pending.timer);
        extensionTimeouts.delete(id);
      }
    }
    for (const id of dialogs.order) {
      const timeout = dialogs.byId[id]?.timeout;
      const pending = extensionTimeouts.get(id);
      if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
        if (pending) {
          clearTimeout(pending.timer);
          extensionTimeouts.delete(id);
        }
        continue;
      }
      if (pending?.delay === timeout) continue;
      if (pending) clearTimeout(pending.timer);
      const timer = setTimeout(() => {
        extensionTimeouts.delete(id);
        const response = cancelExtensionDialogById({ session: session() }, id);
        if (response) void answerExtension(response);
      }, timeout);
      extensionTimeouts.set(id, { delay: timeout, timer });
    }
  });
  onCleanup(() => {
    for (const pending of extensionTimeouts.values()) clearTimeout(pending.timer);
    extensionTimeouts.clear();
  });

  async function acceptDialog(): Promise<void> {
    const dialog = extensionDialog();
    if (dialog) {
      if (dialog.method === "select") {
        const value = options()[selected()];
        if (value !== undefined) await answerExtension(extensionDialogResponse(dialog, selected(), dialogText()));
        return;
      }
      if (dialog.method === "confirm") {
        await answerExtension(extensionDialogResponse(dialog, selected(), dialogText()));
        return;
      }
      const value = modalInput?.plainText ?? dialogText();
      await answerExtension(extensionDialogResponse(dialog, selected(), value));
      return;
    }

    if (localDialog() === "model") {
      const model = session().availableModels[selected()];
      if (!model) return;
      const response = await request({ type: "set_model", provider: model.provider, modelId: model.id });
      if (!response?.success) return;
      setLocalDialog(null);
      setTimeout(() => composer?.focus(), 0);
      return;
    }
    if (localDialog() === "thinking") {
      const level = THINKING_LEVELS[selected()];
      if (!level) return;
      const response = await request({ type: "set_thinking_level", level });
      if (!response?.success) return;
      setLocalDialog(null);
      setTimeout(() => composer?.focus(), 0);
      return;
    }
    setLocalDialog(null);
    setTimeout(() => composer?.focus(), 0);
  }

  async function dismissDialog(): Promise<void> {
    const response = cancelExtensionDialog({ session: session() });
    if (response) {
      await answerExtension(response);
      return;
    }
    setLocalDialog(null);
    setTimeout(() => composer?.focus(), 0);
  }

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "c") {
      event.preventDefault();
      event.stopPropagation();
      if (extensionDialog() || localDialog()) void dismissDialog();
      else if (session().isStreaming) void request({ type: "abort" });
      else props.onExit(0);
      return;
    }
    if (event.ctrl && event.shift && event.name === "a" && !extensionDialog() && !localDialog()) {
      event.preventDefault();
      event.stopPropagation();
      void submitValue("/last-agent");
      return;
    }
    if (event.name === "pageup" || (event.ctrl && event.name === "u")) {
      event.preventDefault();
      scroll?.scrollBy(event.name === "pageup" ? -scroll.height : -scroll.height / 2);
      return;
    }
    if (event.name === "pagedown" || (event.ctrl && event.name === "d")) {
      event.preventDefault();
      scroll?.scrollBy(event.name === "pagedown" ? scroll.height : scroll.height / 2);
      return;
    }
    if (event.shift && event.name === "tab" && !extensionDialog() && !localDialog()) {
      event.preventDefault();
      void submitValue(modeLabel(session().statuses) === "Plan" ? "/build" : "/plan");
      return;
    }
    if (!extensionDialog() && !localDialog()) return;
    if (event.name === "escape") {
      event.preventDefault();
      void dismissDialog();
      return;
    }
    if ((event.name === "up" || event.name === "down") && options().length > 0) {
      event.preventDefault();
      setSelected((value) => (value + (event.name === "up" ? -1 : 1) + options().length) % options().length);
      return;
    }
    if (extensionDialog()?.method === "confirm" && (event.name === "y" || event.name === "n")) {
      event.preventDefault();
      setSelected(event.name === "y" ? 1 : 0);
      void answerExtension({
        type: "extension_ui_response",
        id: extensionDialog()!.id,
        confirmed: event.name === "y",
      });
      return;
    }
    if (event.name === "return" && extensionDialog()?.method !== "editor") {
      event.preventDefault();
      void acceptDialog();
    }
  });

  const toolExecutions = createMemo(() => Object.values(session().toolExecutions));
  const standaloneToolExecutions = createMemo(() =>
    toolExecutions().filter((tool) => session().transcriptTools[tool.toolCallId] === undefined),
  );
  const aboveWidgets = createMemo(() => Object.values(session().widgets).filter((widget) => widget.placement === "aboveEditor"));
  const belowWidgets = createMemo(() => Object.values(session().widgets).filter((widget) => widget.placement === "belowEditor"));
  const notifications = createMemo(() => latestNotifications(session().notifications));
  const modelLabel = createMemo(() => {
    const model = session().model;
    return model ? `${model.id} ${model.provider}` : "no model";
  });
  const statusLabel = createMemo(() =>
    Object.entries(session().statuses)
      .filter(([key]) => key !== "alloy-mode" && key !== "mode")
      .map(([, value]) => cleanStatus(value))
      .filter(Boolean)
      .slice(0, 4)
      .join(" | "),
  );
  const hasDialog = createMemo(() => Boolean(extensionDialog() || localDialog()));
  const dialogTitle = createMemo(() => extensionDialog()?.title || {
    help: "Alloy help",
    model: "Select model",
    thinking: "Thinking level",
    session: "Session statistics",
    export: "Export result",
  }[localDialog() ?? "help"]);

  return (
    <box width={layout().width} height={layout().height} flexDirection="column" backgroundColor={theme.background}>
      <Show when={layout().showIdentity}>
        <box height={1} flexShrink={0} paddingLeft={layout().horizontalPadding} paddingRight={layout().horizontalPadding} flexDirection="row" justifyContent="space-between">
          <text fg={theme.accent}>ALLOY</text>
          <text fg={theme.dim}>v{props.version}</text>
        </box>
      </Show>

      <box flexGrow={1} minHeight={0} paddingLeft={layout().horizontalPadding} paddingRight={layout().horizontalPadding}>
        <scrollbox ref={(value) => (scroll = value)} flexGrow={1} minHeight={0} stickyScroll={true} stickyStart="bottom" scrollbarOptions={{ visible: false }}>
          <box height={1} />
          <Show when={session().messages.length === 0}>
            <box flexGrow={1} minHeight={1} alignItems="center" justifyContent="center">
              <text fg={theme.accent}>A L L O Y</text>
              <Show when={layout().showIdentity}>
                <text fg={theme.accent}>{splashDivider(Math.max(0, layout().width - layout().horizontalPadding * 2))}</text>
                <text fg={theme.dim}>MULTI-MODEL CODING HARNESS</text>
              </Show>
            </box>
          </Show>
          <For each={session().messages}>
            {(message, index) => {
              const role = messageRole(message);
              const blocks = messageBlocks(message, { previewLines: 8, previewChars: 2_000 });
              return role === "user" ? (
                <box marginTop={index() === 0 ? 0 : 1} border={["left"]} borderColor={theme.accent} backgroundColor={theme.user} paddingLeft={2} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
                  <For each={blocks}>{(block) => <Block block={block} user />}</For>
                </box>
              ) : (
                <box marginTop={1} paddingLeft={2} paddingRight={1} gap={1} flexShrink={0}>
                  <For each={blocks}>{(block) => (
                    <Block
                      block={block}
                      streaming={isStreamingTranscriptMessage(session(), index())}
                      execution={(block.kind === "tool-call" || block.kind === "tool-result") && block.id ? session().toolExecutions[block.id] : undefined}
                      transcriptStatus={(block.kind === "tool-call" || block.kind === "tool-result") && block.id ? session().transcriptTools[block.id] : undefined}
                      activityGlyph={activityFrame(activityFrameIndex(), 1)}
                    />
                  )}</For>
                </box>
              );
            }}
          </For>
          <For each={standaloneToolExecutions()}>
            {(tool) => (
              <box paddingLeft={2} marginTop={1} flexShrink={0}>
                <text fg={tool.status === "error" ? theme.error : tool.status === "running" ? theme.warning : theme.muted}>
                  {tool.status === "running" ? activityFrame(activityFrameIndex(), 1) : tool.status === "error" ? "×" : "✓"} {toolSummary(tool.toolName, tool.args)}
                </text>
                <Show when={tool.result !== undefined || tool.partialResult !== undefined}>
                  <text fg={theme.dim}>{displayPreview(tool.result ?? tool.partialResult, { previewLines: 4, previewChars: 500 })}</text>
                </Show>
              </box>
            )}
          </For>
          <Show when={session().backendError || session().fatalError}>
            <box marginTop={1} border={["left"]} borderColor={theme.error} backgroundColor={theme.panel} paddingLeft={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
              <text fg={theme.error}>{session().fatalError ?? session().backendError}</text>
            </box>
          </Show>
        </scrollbox>
      </box>

      <Show when={notifications().length > 0}>
        <scrollbox
          maxHeight={Math.max(1, Math.min(4, Math.floor(layout().height / 4)))}
          flexShrink={0}
          stickyScroll={true}
          stickyStart="bottom"
          paddingLeft={layout().horizontalPadding + 1}
          paddingRight={layout().horizontalPadding}
          scrollbarOptions={{ visible: false }}
        >
          <For each={notifications()}>
            {(notification) => (
              <text wrapMode="char" fg={notification.type === "error" ? theme.error : notification.type === "warning" ? theme.warning : theme.muted}>{notification.message}</text>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={aboveWidgets().length > 0}>
        <scrollbox
          maxHeight={Math.max(1, Math.min(6, Math.floor(layout().height / 3)))}
          flexShrink={0}
          paddingLeft={layout().horizontalPadding + 1}
          paddingRight={layout().horizontalPadding}
          scrollbarOptions={{ visible: false }}
        >
          <For each={aboveWidgets()}>
            {(widget) => <For each={widget.lines}>{(line) => <text wrapMode="char" fg={theme.muted}>{line}</text>}</For>}
          </For>
        </scrollbox>
      </Show>

      <box width="100%" flexShrink={0} border={["left"]} borderColor={theme.accent} backgroundColor={theme.panel} paddingLeft={2} paddingRight={2} paddingTop={layout().showComposerMeta ? 1 : 0}>
        <textarea
          ref={(value) => (composer = value)}
          width="100%"
          minHeight={1}
          maxHeight={layout().composerMaxHeight}
          placeholder={'Ask anything...  "Fix broken tests"'}
          placeholderColor={theme.dim}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.panel}
          cursorColor={theme.textStrong}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onContentChange={() => {
            if (composer.plainText !== appliedEditorText) appliedEditorText = "";
          }}
          onSubmit={submitComposer}
        />
        <Show when={layout().showComposerMeta}>
          <box height={1} flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={theme.accent}>
              {modeLabel(session().statuses)}<span style={{ fg: theme.dim }}> | </span><span style={{ fg: theme.muted }}>{modelLabel()}</span><Show when={session().thinkingLevel !== "off"}><span style={{ fg: theme.dim }}> | {session().thinkingLevel}</span></Show><Show when={statusLabel()}><span style={{ fg: theme.dim }}> | {statusLabel()}</span></Show>
            </text>
            <Show when={session().pendingMessageCount > 0}>
              <text fg={theme.warning}>{session().pendingMessageCount} queued</text>
            </Show>
          </box>
        </Show>
      </box>
      <box height={1} flexShrink={0} paddingLeft={layout().horizontalPadding + 1} paddingRight={layout().horizontalPadding} flexDirection="row" justifyContent="space-between">
        <text fg={activityActive() ? theme.accent : theme.dim}>
          {activityActive() ? activityFrame(activityFrameIndex()) : "⬝".repeat(8)} <span style={{ fg: activityActive() ? theme.text : theme.dim }}>{activityLabel(session(), toolExecutions())}</span>
        </text>
        <text fg={theme.dim}>{session().isStreaming ? "Ctrl+C abort" : "Ctrl+C exit"}</text>
      </box>
      <For each={belowWidgets()}>
        {(widget) => (
          <box flexShrink={0} paddingLeft={layout().horizontalPadding + 1} paddingRight={layout().horizontalPadding}>
            <For each={widget.lines}>{(line) => <text fg={theme.muted}>{line}</text>}</For>
          </box>
        )}
      </For>

      <Show when={hasDialog()}>
        <box position="absolute" zIndex={3000} left={0} top={0} width={layout().width} height={layout().height} alignItems="center" paddingTop={Math.max(0, Math.floor(layout().height / 4))} backgroundColor={RGBA.fromInts(0, 0, 0, 170)}>
          <box width={layout().modalWidth} maxHeight={Math.max(3, layout().height - 2)} backgroundColor={theme.panelRaised} paddingTop={1} paddingBottom={1} flexShrink={1}>
            <scrollbox maxHeight={Math.max(1, layout().height - 7)} flexShrink={1} paddingLeft={2} paddingRight={2} paddingBottom={1} scrollbarOptions={{ visible: false }}>
              <text fg={theme.textStrong} wrapMode="char">{dialogTitle()}</text>
              <Show when={extensionDialog()?.message}>
                <text fg={theme.muted} wrapMode="char">{extensionDialog()!.message}</text>
              </Show>
            </scrollbox>
            <Show when={options().length > 0}>
              <scrollbox maxHeight={Math.max(1, layout().height - 6)} scrollbarOptions={{ visible: false }}>
                <For each={options()}>
                  {(option, index) => (
                    <box paddingLeft={2} paddingRight={2} backgroundColor={index() === selected() ? theme.accent : theme.panelRaised}>
                      <text fg={index() === selected() ? theme.background : theme.text}>{index() === selected() ? "> " : "  "}{option}</text>
                    </box>
                  )}
                </For>
              </scrollbox>
            </Show>
            <Show when={extensionDialog()?.method === "input" || extensionDialog()?.method === "editor"}>
              <box marginLeft={2} marginRight={2} border={["left"]} borderColor={theme.accent} backgroundColor={theme.panel} paddingLeft={1}>
                <textarea
                  ref={(value) => {
                    modalInput = value;
                    setTimeout(() => value.focus(), 0);
                  }}
                  initialValue={dialogText()}
                  minHeight={1}
                  maxHeight={Math.max(1, Math.min(5, layout().height - 6))}
                  placeholder={extensionDialog()?.placeholder}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  backgroundColor={theme.panel}
                  focusedBackgroundColor={theme.panel}
                  cursorColor={theme.textStrong}
                  onContentChange={() => setDialogText(modalInput?.plainText ?? "")}
                  onSubmit={() => void acceptDialog()}
                />
              </box>
            </Show>
            <Show when={localDialog() === "help"}>
              <box paddingLeft={2} paddingRight={2}><For each={HELP_LINES}>{(line) => <text fg={line.startsWith("/") ? theme.accent : theme.muted}>{line}</text>}</For></box>
            </Show>
            <Show when={localDialog() === "session"}>
              <scrollbox maxHeight={Math.max(1, layout().height - 6)} paddingLeft={2} paddingRight={2} scrollbarOptions={{ visible: false }}><text fg={theme.muted}>{displayText(session().sessionStats ?? dialogResult())}</text></scrollbox>
            </Show>
            <Show when={localDialog() === "export"}>
              <scrollbox maxHeight={Math.max(1, layout().height - 6)} paddingLeft={2} paddingRight={2} scrollbarOptions={{ visible: false }}><text fg={theme.muted}>{displayText(dialogResult())}</text></scrollbox>
            </Show>
            <box paddingLeft={2} paddingRight={2} paddingTop={1}>
              <text fg={theme.dim}>{options().length ? "Up/Down select | Enter confirm | Esc cancel" : "Enter close | Esc cancel"}</text>
            </box>
          </box>
        </box>
      </Show>
    </box>
  );
}
