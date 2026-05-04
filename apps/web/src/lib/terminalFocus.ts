export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.classList.contains("ghostty-terminal-input")) return true;
  return (
    activeElement.closest('.thread-terminal-drawer [data-terminal-engine="ghostty-vt"]') !== null
  );
}
