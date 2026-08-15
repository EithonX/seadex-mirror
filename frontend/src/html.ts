export function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function query<T extends Element>(selector: string) {
  const node = document.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Missing required node: ${selector}`);
  }
  return node;
}

export function debounce(callback: () => void | Promise<void>, delayMs: number) {
  let timeoutId: number | null = null;
  return () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      void callback();
    }, delayMs);
  };
}

export function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

const DEFAULT_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:"]);

export function safeExternalUrl(
  value: string | null | undefined,
  allowedProtocols: ReadonlySet<string> = DEFAULT_EXTERNAL_PROTOCOLS,
) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return allowedProtocols.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
