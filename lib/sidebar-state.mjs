const EMPTY_LSP = Object.freeze({ supported: false, enabled: false, items: [] });

let state = {
  mcp: [],
  lsp: EMPTY_LSP,
  todos: [],
};
let publisher;

function snapshot() {
  return {
    mcp: state.mcp.map((item) => ({ ...item })),
    lsp: { ...state.lsp, items: state.lsp.items.map((item) => ({ ...item })) },
    todos: state.todos.map((item) => ({ ...item })),
  };
}

export function publishSidebarState() {
  publisher?.(snapshot());
}

export function bindSidebarPublisher(nextPublisher) {
  publisher = nextPublisher;
  publishSidebarState();
  return () => {
    if (publisher === nextPublisher) publisher = undefined;
  };
}

export function setSidebarMcp(mcp) {
  state = {
    ...state,
    mcp: mcp.map((item) => {
      const name = typeof item.name === "string" ? item.name.trim().slice(0, 200) : "";
      if (!name) return { name: "(unnamed)", status: "failed", error: "server name is empty" };
      const transport = ["stdio", "http", "sse"].includes(item.transport) ? item.transport : undefined;
      const { transport: _transport, ...rest } = item;
      return { ...rest, name, ...(transport ? { transport } : {}) };
    }),
  };
  publishSidebarState();
}

export function resetSidebarState() {
  state = { mcp: [], lsp: EMPTY_LSP, todos: [] };
  publishSidebarState();
}
