// A stub browser object, so the popup and the background run on a plain
// http page where WebDriver BiDi can take screenshots. Only the parts the
// demo uses are here. The real E2E run uses the real Firefox APIs.
(() => {
  const listeners = [];
  const data = {};
  window.browser = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => listeners[0](message, { url: location.href }),
    },
    storage: {
      local: {
        get: async (key) => (key === null ? structuredClone(data) : key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (items) => void Object.assign(data, structuredClone(items)),
      },
    },
    // Enough for the demo grant on *.example.com. Not a public suffix list.
    publicSuffix: { getDomain: (host) => (host.includes(".") ? host : null) },
  };
})();
