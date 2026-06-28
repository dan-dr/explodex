// @ts-check

(function installViewsData(global) {
  global.__explodexViewsData = (cleanId, onChange) => {
    let queryClient = null;
    let unsubscribe = null;

    function reactFiber(host) {
      const key = Object.keys(host ?? {}).find(
        (name) => name.startsWith("__reactContainer$") || name.startsWith("__reactFiber$"),
      );
      return key ? host[key] : null;
    }

    function getQueryClient() {
      if (queryClient) return queryClient;
      let fiber = reactFiber(document.querySelector("nav") ?? document.documentElement);
      for (let depth = 0; depth < 220 && fiber; depth += 1) {
        const value = fiber.memoizedProps?.value;
        if (value?.getQueryCache && value?.setQueryData) {
          queryClient = value;
          return value;
        }
        fiber = fiber.return;
      }
      return null;
    }

    function catalog() {
      const client = getQueryClient();
      if (!client) return [];
      const queries = client
        .getQueryCache()
        .getAll()
        .filter((query) => Array.isArray(query.queryKey) && query.queryKey[0] === "recent-conversations-meta")
        .sort((a, b) => (b.state?.dataUpdatedAt ?? 0) - (a.state?.dataUpdatedAt ?? 0));
      return Array.isArray(queries[0]?.state?.data) ? queries[0].state.data : [];
    }

    function byId(id) {
      return catalog().find((item) => cleanId(item?.id) === cleanId(id)) ?? null;
    }

    function messageText(item) {
      if (typeof item?.text === "string") return item.text.trim();
      if (Array.isArray(item?.content)) {
        return item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim();
      }
      if (item?.type === "commandExecution") {
        const command = typeof item.command === "string" ? item.command : "Command";
        const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.trim().slice(-800) : "";
        return [`$ ${command}`, output].filter(Boolean).join("\n");
      }
      if (item?.type === "mcpToolCall") return `${item.server ?? "tool"} · ${item.tool ?? "call"} · ${item.status ?? ""}`;
      if (item?.type === "fileChange") return `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`;
      return "";
    }

    function recentMessages(meta) {
      return (meta?.turns ?? [])
        .flatMap((turn) => turn?.items ?? [])
        .map((item) => ({
          role: item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : "tool",
          text: messageText(item),
        }))
        .filter((item) => item.text)
        .slice(-10);
    }

    function subscribe() {
      const client = getQueryClient();
      if (unsubscribe || !client) return;
      unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event?.query?.queryKey?.[0] === "recent-conversations-meta") onChange();
      });
    }

    return { catalog, byId, recentMessages, subscribe, dispose: () => unsubscribe?.() };
  };
})(window);
