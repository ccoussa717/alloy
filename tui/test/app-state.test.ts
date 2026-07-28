import { describe, expect, it } from "bun:test";
import {
  appLayout,
  cancelExtensionDialog,
  cancelExtensionDialogById,
  copySelectionToClipboard,
  createAppState,
  extensionDialogOptions,
  extensionDialogOptionPresentation,
  extensionDialogResponse,
  fusionResultLayout,
  fusionLiveCompact,
  fusionLiveLayout,
  fusionLiveOutputPreview,
  fusionLiveRoleActivity,
  fusionLiveStatusGlyph,
  fusionWidgetTone,
  initialDialogSelection,
  latestNotifications,
  modelProviderOptions,
  modelsForProvider,
  reduceAppRpcMessage,
  sidebarLayout,
} from "../src/app";

describe("integrated app state", () => {
  it("copies completed mouse selections to the terminal clipboard", () => {
    const copied: string[] = [];
    let cleared = 0;
    const renderer = {
      copyToClipboardOSC52(text: string) {
        copied.push(text);
        return true;
      },
      clearSelection() {
        cleared++;
      },
    };

    expect(copySelectionToClipboard(renderer, { getSelectedText: () => "https://auth.example.test" })).toBe(true);
    expect(copied).toEqual(["https://auth.example.test"]);
    expect(cleared).toBe(1);
    expect(copySelectionToClipboard(renderer, { getSelectedText: () => "" })).toBe(false);
    expect(copied).toEqual(["https://auth.example.test"]);
    expect(cleared).toBe(1);
  });

  it("reduces every backend message through the existing session reducer", () => {
    const initial = createAppState();
    const next = reduceAppRpcMessage(initial, {
      type: "extension_ui_request",
      id: "approval-1",
      method: "confirm",
      title: "Allow tool?",
      message: "Run the command",
    });

    expect(next.session.extensionDialogs.byId["approval-1"]).toMatchObject({
      id: "approval-1",
      method: "confirm",
      title: "Allow tool?",
    });
    expect(initial.session.extensionDialogs).toEqual({ order: [], byId: {} });
  });

  it("displays the first queued dialog and defaults confirmation to deny", () => {
    let state = reduceAppRpcMessage(createAppState(), {
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Allow?",
    });
    state = reduceAppRpcMessage(state, {
      type: "extension_ui_request",
      id: "input-2",
      method: "input",
      title: "Later",
    });

    expect(cancelExtensionDialog(state)).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      cancelled: true,
    });
    expect(cancelExtensionDialogById(state, "input-2")).toEqual({
      type: "extension_ui_response",
      id: "input-2",
      cancelled: true,
    });
    expect(cancelExtensionDialogById(state, "missing")).toBeNull();
    const dialog = state.session.extensionDialogs.byId[state.session.extensionDialogs.order[0]!]!;
    expect(extensionDialogOptions(dialog)).toEqual(["Deny", "Allow"]);
    expect(extensionDialogResponse(dialog, 0, "")).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: false,
    });
    expect(extensionDialogResponse(dialog, 1, "")).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: true,
    });
  });

  it("separates provider configuration status from the selectable value", () => {
    expect(extensionDialogOptionPresentation("Anthropic (anthropic)\tconfigured")).toEqual({
      label: "Anthropic (anthropic)",
      status: "configured",
    });
    expect(extensionDialogOptionPresentation("OpenAI Codex (openai-codex)\tnot configured")).toEqual({
      label: "OpenAI Codex (openai-codex)",
      status: "not configured",
    });
    expect(extensionDialogOptionPresentation("ordinary option")).toEqual({ label: "ordinary option" });
    expect(extensionDialogResponse({
      id: "provider-select",
      method: "select",
      title: "Login with OAuth",
      options: ["Anthropic (anthropic)\tconfigured"],
    }, 0, "")).toEqual({
      type: "extension_ui_response",
      id: "provider-select",
      value: "Anthropic (anthropic)\tconfigured",
    });
  });

  it("closes a dialog when the RPC host resolves it without client input", () => {
    let state = reduceAppRpcMessage(createAppState(), {
      type: "extension_ui_request",
      id: "oauth-fallback",
      method: "input",
      title: "Complete login",
    });
    state = reduceAppRpcMessage(state, {
      type: "extension_ui_request",
      id: "oauth-fallback",
      method: "close",
    });

    expect(state.session.extensionDialogs).toEqual({ order: [], byId: {} });
  });

  it("keeps at least the latest eight notifications visible", () => {
    const notifications = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      message: `notice ${index}`,
      type: "info" as const,
    }));
    expect(latestNotifications(notifications).map((item) => item.id)).toEqual([
      "2", "3", "4", "5", "6", "7", "8", "9",
    ]);
  });

  it("groups models by provider before listing that provider's models", () => {
    const models = [
      { id: "grok-4", provider: "xai", name: "Grok 4" },
      { id: "claude-opus", provider: "anthropic", name: "Opus" },
      { id: "grok-3", provider: "xai", name: "Grok 3" },
    ];

    expect(modelProviderOptions(models)).toEqual(["anthropic", "xai"]);
    expect(modelsForProvider(models, "xai").map((model) => model.id)).toEqual(["grok-3", "grok-4"]);
    expect(modelsForProvider(models, undefined)).toEqual([]);
  });

  it("never applies provider selection state to an extension dialog with a colliding id", () => {
    const providers = ["anthropic", "xai"];
    expect(initialDialogSelection(null, "model-provider", providers, "xai")).toBe(1);
    expect(initialDialogSelection({ id: "model-provider", method: "confirm", title: "Allow?" }, "model-provider", providers, "xai")).toBe(0);
  });

  it("cancels extension dialogs fail-closed", () => {
    const state = reduceAppRpcMessage(createAppState(), {
      type: "extension_ui_request",
      id: "input-1",
      method: "input",
      title: "Required value",
    });

    expect(cancelExtensionDialog(state)).toEqual({
      type: "extension_ui_response",
      id: "input-1",
      cancelled: true,
    });
    expect(cancelExtensionDialog(createAppState())).toBeNull();
  });

  it("keeps a usable one-row composer at 40x10", () => {
    expect(appLayout(40, 10)).toEqual({
      width: 40,
      height: 10,
      horizontalPadding: 1,
      showIdentity: false,
      showComposerMeta: false,
      composerMaxHeight: 1,
      modalWidth: 38,
    });
    expect(appLayout(80, 24)).toMatchObject({
      horizontalPadding: 2,
      showIdentity: true,
      showComposerMeta: true,
      composerMaxHeight: 6,
      modalWidth: 60,
    });
  });

  it("auto-shows a 42-column rail only above 120 columns and overlays narrow terminals", () => {
    expect(sidebarLayout(120, null)).toEqual({ visible: false, overlay: false, width: 0, mainWidth: 120 });
    expect(sidebarLayout(121, null)).toEqual({ visible: true, overlay: false, width: 42, mainWidth: 79 });
    expect(sidebarLayout(80, true)).toEqual({ visible: true, overlay: true, width: 42, mainWidth: 80 });
    expect(sidebarLayout(40, true)).toEqual({ visible: true, overlay: true, width: 40, mainWidth: 40 });
    expect(sidebarLayout(160, false)).toEqual({ visible: false, overlay: false, width: 0, mainWidth: 160 });
  });

  it("renders Fusion results side by side only when Alloy's transcript is wide enough", () => {
    const wideSidebar = sidebarLayout(140, null);
    const wideLayout = appLayout(wideSidebar.mainWidth, 30);
    const wideTranscript = wideLayout.width - wideLayout.horizontalPadding * 2 - 3;
    const mediumLayout = appLayout(sidebarLayout(80, null).mainWidth, 24);
    const mediumTranscript = mediumLayout.width - mediumLayout.horizontalPadding * 2 - 3;
    const compactLayout = appLayout(sidebarLayout(40, null).mainWidth, 10);
    const compactTranscript = compactLayout.width - compactLayout.horizontalPadding * 2 - 3;

    expect(fusionResultLayout(wideTranscript)).toBe("columns");
    expect(fusionResultLayout(mediumTranscript)).toBe("stack");
    expect(fusionResultLayout(compactTranscript)).toBe("stack");
  });

  it("uses the README green hierarchy for live Fusion role panes", () => {
    const lines = [
      "ALLOY FUSION · fusion-1 · PROPOSING",
      "┌────────┬────────┐",
      "│Architect│Builder │",
      "│planning │building│",
    ];

    expect(fusionWidgetTone(lines, lines[0]!, 0)).toBe("accent");
    expect(fusionWidgetTone(lines, lines[1]!, 1)).toBe("accentDim");
    expect(fusionWidgetTone(lines, lines[2]!, 2)).toBe("accent");
    expect(fusionWidgetTone(lines, lines[3]!, 3)).toBe("muted");
    expect(fusionWidgetTone(["ALLOY AUTO"], "ALLOY AUTO", 0)).toBe("muted");
  });

  it("keeps the native Fusion dashboard side by side without hiding the compact composer", () => {
    expect(fusionLiveLayout(80, 24)).toEqual({ columns: true, maxHeight: 12 });
    expect(fusionLiveLayout(40, 10)).toEqual({ columns: false, maxHeight: 4 });
    expect(fusionLiveCompact(80, 24, true)).toBe(false);
    expect(fusionLiveCompact(80, 11, true)).toBe(true);
    expect(fusionLiveCompact(50, 24, true)).toBe(true);
    expect(fusionLiveCompact(50, 30, true)).toBe(false);
  });

  it("bounds live role output to a single newest-line preview", () => {
    const preview = fusionLiveOutputPreview(`old\n${"detail ".repeat(100)}CURRENT END`, 36);
    expect(preview.length).toBeLessThanOrEqual(36);
    expect(preview).toEndWith("CURRENT END");
    expect(preview).not.toContain("\n");
    const widePreview = fusionLiveOutputPreview("old 漢字😀 newest", 10);
    expect(Bun.stringWidth(widePreview)).toBeLessThanOrEqual(10);
    expect(widePreview).toEndWith("newest");
  });

  it("keeps terminal Fusion statuses visually distinct", () => {
    expect(fusionLiveStatusGlyph("pending")).toBe("·");
    expect(fusionLiveStatusGlyph("running")).toBe("●");
    expect(fusionLiveStatusGlyph("ok")).toBe("✓");
    expect(fusionLiveStatusGlyph("fail")).toBe("×");
    expect(fusionLiveStatusGlyph("skip")).toBe("○");
    const agent = {
      role: "architect" as const,
      status: "fail" as const,
      model: "",
      effort: "",
      activity: "child timed out",
      output: "",
      events: [{ tool: "read", detail: "src/auth.ts", status: "running" as const }],
    };
    expect(fusionLiveRoleActivity(agent)).toBe("child timed out");
    expect(fusionLiveRoleActivity({ ...agent, status: "running" })).toBe("using read · src/auth.ts");
  });
});
