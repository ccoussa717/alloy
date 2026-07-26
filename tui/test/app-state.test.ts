import { describe, expect, it } from "bun:test";
import {
  appLayout,
  cancelExtensionDialog,
  cancelExtensionDialogById,
  createAppState,
  extensionDialogOptions,
  extensionDialogResponse,
  latestNotifications,
  reduceAppRpcMessage,
} from "../src/app";

describe("integrated app state", () => {
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
});
