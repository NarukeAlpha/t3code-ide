import { GhosttyWasmTerminal } from "./wasm";

export interface GhosttyTerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
  scrollbarSliderBackground?: string;
  scrollbarSliderHoverBackground?: string;
  scrollbarSliderActiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

interface GhosttyTerminalOptions {
  cursorBlink?: boolean;
  lineHeight?: number;
  fontSize?: number;
  scrollback?: number;
  fontFamily?: string;
  theme?: GhosttyTerminalTheme;
  wasmUrl?: string;
}

interface Disposable {
  dispose(): void;
}

interface GhosttyTerminalLinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

interface GhosttyTerminalLink {
  text: string;
  range: GhosttyTerminalLinkRange;
  activate(event: MouseEvent): void;
}

interface GhosttyTerminalLinkProvider {
  provideLinks(
    bufferLineNumber: number,
    callback: (links: GhosttyTerminalLink[] | undefined) => void,
  ): void;
}

interface GhosttyBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

interface GhosttyBufferState {
  viewportY: number;
  baseY: number;
  getLine(bufferLineIndex: number): GhosttyBufferLine | undefined;
}

type DataListener = (data: string) => void;
type SelectionListener = () => void;
type CustomKeyEventHandler = (event: KeyboardEvent) => boolean;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_SCROLLBACK = 5_000;
const DEFAULT_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
const CELL_WIDTH_SAMPLE = "W".repeat(40);
const TERMINAL_ID_ATTRIBUTE = "data-ghostty-terminal-id";
const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\))`,
  "g",
);

let nextTerminalDomId = 0;

export class GhosttyFitAddon {
  private terminal: GhosttyTerminal | null = null;

  activate(terminal: GhosttyTerminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.terminal = null;
  }

  fit(): void {
    this.terminal?.fitToContainer();
  }
}

export class GhosttyTerminal {
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;
  readonly options: GhosttyTerminalOptions;
  readonly buffer: { active: GhosttyBufferState };

  private readonly domId = `ghostty-terminal-${++nextTerminalDomId}`;
  private readonly dataListeners = new Set<DataListener>();
  private readonly selectionListeners = new Set<SelectionListener>();
  private engine: GhosttyWasmTerminal | null = null;
  private mountElement: HTMLElement | null = null;
  private rootElement: HTMLDivElement | null = null;
  private viewportElement: HTMLDivElement | null = null;
  private contentElement: HTMLDivElement | null = null;
  private inputElement: HTMLTextAreaElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private linkProvider: GhosttyTerminalLinkProvider | null = null;
  private customKeyEventHandler: CustomKeyEventHandler | null = null;
  private pendingInput = "";
  private fallbackPlainText = "";
  private lineCache: string[] = [""];
  private cellWidth = 7;
  private cellHeight = DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT;
  private renderScheduled = false;
  private scrollToBottomAfterRender = true;
  private disposed = false;
  private loadError: string | null = null;

  constructor(options: GhosttyTerminalOptions = {}) {
    this.options = {
      cursorBlink: options.cursorBlink ?? true,
      lineHeight: options.lineHeight ?? DEFAULT_LINE_HEIGHT,
      fontSize: options.fontSize ?? DEFAULT_FONT_SIZE,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
      ...(options.theme ? { theme: options.theme } : {}),
      ...(options.wasmUrl ? { wasmUrl: options.wasmUrl } : {}),
    };
    this.buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: (bufferLineIndex) => {
          const text = this.lineCache[bufferLineIndex];
          if (text === undefined) return undefined;
          return {
            isWrapped: false,
            translateToString: (trimRight = false) => (trimRight ? text.trimEnd() : text),
          };
        },
      },
    };
  }

  loadAddon(addon: { activate?: (terminal: GhosttyTerminal) => void }): void {
    addon.activate?.(this);
  }

  open(mountElement: HTMLElement): void {
    if (this.disposed) return;

    this.mountElement = mountElement;
    mountElement.textContent = "";

    const root = document.createElement("div");
    root.className = "ghostty-terminal-root";
    root.dataset.terminalEngine = "ghostty-vt";
    root.setAttribute(TERMINAL_ID_ATTRIBUTE, this.domId);

    const viewport = document.createElement("div");
    viewport.className = "ghostty-terminal-viewport";

    const content = document.createElement("div");
    content.className = "ghostty-terminal-content";
    viewport.append(content);

    const input = document.createElement("textarea");
    input.className = "ghostty-terminal-input";
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Terminal input");
    input.setAttribute("autocorrect", "off");

    root.append(viewport, input);
    mountElement.append(root);

    this.rootElement = root;
    this.viewportElement = viewport;
    this.contentElement = content;
    this.inputElement = input;

    this.applyTheme();
    this.measureCellSize();
    this.installDomListeners();
    this.resizeObserver = new ResizeObserver(() => this.fitToContainer());
    this.resizeObserver.observe(mountElement);
    this.fitToContainer();
    this.renderNow();
    void this.loadEngine();
  }

  write(data: string): void {
    if (this.disposed || data.length === 0) return;
    const wasAtBottom = this.isScrolledToBottom();

    this.pendingInput += this.engine === null ? data : "";
    this.fallbackPlainText = appendPlainFallback(
      this.fallbackPlainText,
      data,
      this.options.scrollback,
    );
    this.engine?.feed(data);

    if (wasAtBottom) {
      this.scrollToBottomAfterRender = true;
    }
    this.scheduleRender();
  }

  clear(): void {
    if (this.disposed) return;
    this.pendingInput = "";
    this.fallbackPlainText = "";
    this.lineCache = [""];
    this.engine?.reset();
    this.scrollToBottomAfterRender = true;
    this.scheduleRender();
  }

  clearSelection(): void {
    const selection = window.getSelection();
    if (!selection || !this.selectionBelongsToTerminal(selection)) return;
    selection.removeAllRanges();
    this.emitSelectionChange();
  }

  focus(): void {
    this.inputElement?.focus({ preventScroll: true });
  }

  refresh(_start: number, _end: number): void {
    this.applyTheme();
    this.scheduleRender();
  }

  scrollToBottom(): void {
    const viewport = this.viewportElement;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    this.updateScrollState();
  }

  hasSelection(): boolean {
    const selection = window.getSelection();
    return selection !== null && this.selectionBelongsToTerminal(selection);
  }

  getSelection(): string {
    const selection = window.getSelection();
    if (!selection || !this.selectionBelongsToTerminal(selection)) return "";
    return selection.toString();
  }

  getSelectionPosition(): {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null {
    const selection = this.getSelection();
    if (selection.length === 0) return null;

    const plainText = this.lineCache.join("\n");
    const selectionIndex = plainText.indexOf(selection.replace(/\r\n/g, "\n"));
    if (selectionIndex < 0) return null;

    return {
      start: textIndexToBufferPosition(plainText, selectionIndex),
      end: textIndexToBufferPosition(plainText, selectionIndex + selection.length),
    };
  }

  attachCustomKeyEventHandler(handler: CustomKeyEventHandler): void {
    this.customKeyEventHandler = handler;
  }

  registerLinkProvider(provider: GhosttyTerminalLinkProvider): Disposable {
    this.linkProvider = provider;
    return {
      dispose: () => {
        if (this.linkProvider === provider) {
          this.linkProvider = null;
        }
      },
    };
  }

  onData(listener: DataListener): Disposable {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  onSelectionChange(listener: SelectionListener): Disposable {
    this.selectionListeners.add(listener);
    return {
      dispose: () => {
        this.selectionListeners.delete(listener);
      },
    };
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(1, Math.floor(rows));
    if (this.cols === nextCols && this.rows === nextRows) return;

    this.cols = nextCols;
    this.rows = nextRows;
    this.engine?.resize(this.cols, this.rows, this.cellWidth, this.cellHeight);
    this.scheduleRender();
  }

  fitToContainer(): void {
    const mount = this.mountElement;
    if (!mount) return;

    this.measureCellSize();
    const bounds = mount.getBoundingClientRect();
    const cols = Math.max(2, Math.floor(bounds.width / this.cellWidth));
    const rows = Math.max(1, Math.floor(bounds.height / this.cellHeight));
    this.resize(cols, rows);
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    this.engine?.dispose();
    this.engine = null;
    this.rootElement?.remove();
    this.mountElement = null;
    this.rootElement = null;
    this.viewportElement = null;
    this.contentElement = null;
    this.inputElement = null;
    this.dataListeners.clear();
    this.selectionListeners.clear();
    this.linkProvider = null;
    this.customKeyEventHandler = null;
  }

  private async loadEngine(): Promise<void> {
    try {
      const engine = await GhosttyWasmTerminal.create({
        cols: this.cols,
        rows: this.rows,
        scrollback: this.options.scrollback ?? DEFAULT_SCROLLBACK,
        cellWidth: this.cellWidth,
        cellHeight: this.cellHeight,
        ...(this.options.wasmUrl ? { wasmUrl: this.options.wasmUrl } : {}),
      });
      if (this.disposed) {
        engine.dispose();
        return;
      }

      this.engine = engine;
      if (this.pendingInput.length > 0) {
        engine.feed(this.pendingInput);
        this.pendingInput = "";
      }
      this.loadError = null;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "Failed to load libghostty-vt";
    }

    this.scheduleRender();
  }

  private installDomListeners(): void {
    const root = this.rootElement;
    const viewport = this.viewportElement;
    const input = this.inputElement;
    const content = this.contentElement;
    if (!root || !viewport || !input || !content) return;

    viewport.addEventListener("scroll", () => this.updateScrollState());
    root.addEventListener("click", () => {
      if (!this.hasSelection()) {
        this.focus();
      }
    });
    content.addEventListener("click", (event) => this.handleLinkClick(event));
    input.addEventListener("keydown", (event) => this.handleKeyDown(event));
    input.addEventListener("paste", (event) => this.handlePaste(event));
    input.addEventListener("copy", (event) => this.handleCopy(event));
    document.addEventListener("selectionchange", this.handleSelectionChange);
  }

  private readonly handleSelectionChange = (): void => {
    this.emitSelectionChange();
  };

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.customKeyEventHandler?.(event) === false) {
      return;
    }

    if (isCopyShortcut(event) && this.hasSelection()) {
      return;
    }

    if (isPasteShortcut(event)) {
      return;
    }

    const data = this.engine?.encodeKeyboardEvent(event) ?? fallbackKeyboardData(event);
    if (data === null || data.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    this.emitData(data);
  }

  private handlePaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;
    event.preventDefault();
    this.emitData(text);
  }

  private handleCopy(event: ClipboardEvent): void {
    const selection = this.getSelection();
    if (selection.length === 0) return;
    event.clipboardData?.setData("text/plain", selection);
    event.preventDefault();
  }

  private handleLinkClick(event: MouseEvent): void {
    if (!this.linkProvider || !this.viewportElement) return;

    const bufferPosition = this.bufferPositionFromPointer(event);
    if (!bufferPosition) return;

    this.linkProvider.provideLinks(bufferPosition.y, (links) => {
      const link = links?.find((candidate) =>
        bufferPositionIntersectsRange(bufferPosition, candidate.range),
      );
      link?.activate(event);
    });
  }

  private bufferPositionFromPointer(event: MouseEvent): { x: number; y: number } | null {
    const viewport = this.viewportElement;
    if (!viewport) return null;

    const bounds = viewport.getBoundingClientRect();
    const y = Math.floor((event.clientY - bounds.top + viewport.scrollTop) / this.cellHeight) + 1;
    const x = Math.floor((event.clientX - bounds.left + viewport.scrollLeft) / this.cellWidth) + 1;
    if (x < 1 || y < 1) return null;
    return { x, y };
  }

  private emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  private emitSelectionChange(): void {
    for (const listener of this.selectionListeners) {
      listener();
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    const content = this.contentElement;
    if (!content) return;

    const html = this.engine
      ? this.scopeGhosttyHtml(this.engine.formatHtml())
      : `<div>${escapeHtml(this.loadError ?? this.fallbackPlainText)}</div>`;
    const plainText = this.engine?.formatPlain() ?? this.fallbackPlainText;

    content.innerHTML = html;
    this.lineCache = splitTerminalLines(plainText);
    this.updateScrollState();

    if (this.scrollToBottomAfterRender) {
      this.scrollToBottomAfterRender = false;
      this.scrollToBottom();
    }
  }

  private scopeGhosttyHtml(html: string): string {
    return html.replace("<style>:root{", `<style>[${TERMINAL_ID_ATTRIBUTE}="${this.domId}"]{`);
  }

  private applyTheme(): void {
    const root = this.rootElement;
    if (!root) return;
    const theme = this.options.theme;
    root.style.fontFamily = this.options.fontFamily ?? DEFAULT_FONT_FAMILY;
    root.style.fontSize = `${this.options.fontSize ?? DEFAULT_FONT_SIZE}px`;
    root.style.lineHeight = String(this.options.lineHeight ?? DEFAULT_LINE_HEIGHT);
    root.style.setProperty("--ghostty-terminal-background", theme?.background ?? "transparent");
    root.style.setProperty("--ghostty-terminal-foreground", theme?.foreground ?? "inherit");
    root.style.setProperty("--ghostty-terminal-cursor", theme?.cursor ?? "currentColor");
    root.style.setProperty(
      "--ghostty-terminal-selection",
      theme?.selectionBackground ?? "rgba(120, 160, 220, 0.28)",
    );
    root.style.setProperty(
      "--ghostty-terminal-scrollbar",
      theme?.scrollbarSliderBackground ?? "rgba(0, 0, 0, 0.15)",
    );
    root.style.setProperty(
      "--ghostty-terminal-scrollbar-hover",
      theme?.scrollbarSliderHoverBackground ?? "rgba(0, 0, 0, 0.25)",
    );
  }

  private measureCellSize(): void {
    const root = this.rootElement;
    if (!root) {
      const fontSize = this.options.fontSize ?? DEFAULT_FONT_SIZE;
      this.cellHeight = fontSize * (this.options.lineHeight ?? DEFAULT_LINE_HEIGHT);
      this.cellWidth = Math.max(1, fontSize * 0.6);
      return;
    }

    const sample = document.createElement("span");
    sample.textContent = CELL_WIDTH_SAMPLE;
    sample.style.position = "absolute";
    sample.style.visibility = "hidden";
    sample.style.whiteSpace = "pre";
    root.append(sample);
    const bounds = sample.getBoundingClientRect();
    sample.remove();

    const fontSize = this.options.fontSize ?? DEFAULT_FONT_SIZE;
    this.cellWidth = Math.max(1, bounds.width / CELL_WIDTH_SAMPLE.length || fontSize * 0.6);
    this.cellHeight = Math.max(1, fontSize * (this.options.lineHeight ?? DEFAULT_LINE_HEIGHT));
  }

  private updateScrollState(): void {
    const viewport = this.viewportElement;
    const activeBuffer = this.buffer.active;
    activeBuffer.baseY = Math.max(0, this.lineCache.length - this.rows);
    activeBuffer.viewportY = viewport
      ? Math.min(activeBuffer.baseY, Math.floor(viewport.scrollTop / this.cellHeight))
      : activeBuffer.baseY;
  }

  private isScrolledToBottom(): boolean {
    const viewport = this.viewportElement;
    if (!viewport) return true;
    return viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - this.cellHeight;
  }

  private selectionBelongsToTerminal(selection: Selection): boolean {
    if (selection.isCollapsed || selection.toString().length === 0) return false;
    const root = this.rootElement;
    if (!root) return false;

    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return anchor !== null && focus !== null && root.contains(anchor) && root.contains(focus);
  }
}

function splitTerminalLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  return lines.length > 0 ? lines : [""];
}

function appendPlainFallback(
  current: string,
  data: string,
  scrollback = DEFAULT_SCROLLBACK,
): string {
  let next = data.includes("\u001bc") ? "" : current;
  next += stripAnsi(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = next.split("\n");
  if (lines.length <= scrollback) return next;
  return lines.slice(lines.length - scrollback).join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", "<br>");
}

function textIndexToBufferPosition(text: string, index: number): { x: number; y: number } {
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return {
    x: lines.at(-1)?.length ?? 0,
    y: lines.length - 1,
  };
}

function bufferPositionIntersectsRange(
  position: { x: number; y: number },
  range: GhosttyTerminalLinkRange,
): boolean {
  if (position.y < range.start.y || position.y > range.end.y) return false;
  if (range.start.y === range.end.y) {
    return position.x >= range.start.x && position.x <= range.end.x;
  }
  if (position.y === range.start.y) return position.x >= range.start.x;
  if (position.y === range.end.y) return position.x <= range.end.x;
  return true;
}

function fallbackKeyboardData(event: KeyboardEvent): string | null {
  if (event.key.length === 1 && event.ctrlKey && !event.altKey && !event.metaKey) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(code - 64);
    }
  }

  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) return event.key;

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Backspace":
      return "\x7f";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Delete":
      return "\x1b[3~";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      return null;
  }
}

function isCopyShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === "c" && (event.metaKey || event.ctrlKey);
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === "v" && (event.metaKey || event.ctrlKey);
}
