import {
  GHOSTTY_KEY_CODE_BY_BROWSER_CODE,
  ghosttyModsFromKeyboardEvent,
  unshiftedCodepointFromKeyboardEvent,
} from "./keyCodes";

const DEFAULT_WASM_URL = "/libghostty/ghostty-vt.wasm";
const GHOSTTY_SUCCESS = 0;
const GHOSTTY_FORMATTER_FORMAT_PLAIN = 0;
const GHOSTTY_FORMATTER_FORMAT_HTML = 2;
const GHOSTTY_KEY_ACTION_PRESS = 1;
const GHOSTTY_KEY_ACTION_REPEAT = 2;

interface TypeLayoutField {
  offset: number;
  size: number;
  type: string;
}

interface TypeLayoutStruct {
  size: number;
  fields: Record<string, TypeLayoutField>;
}

type TypeLayout = Record<string, TypeLayoutStruct>;

interface GhosttyWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  ghostty_type_json: () => number;
  ghostty_wasm_alloc_opaque: () => number;
  ghostty_wasm_free_opaque: (ptr: number) => void;
  ghostty_wasm_alloc_usize: () => number;
  ghostty_wasm_free_usize: (ptr: number) => void;
  ghostty_wasm_alloc_u8_array: (len: number) => number;
  ghostty_wasm_free_u8_array: (ptr: number, len: number) => void;
  ghostty_terminal_new: (allocator: number, terminalPtr: number, optionsPtr: number) => number;
  ghostty_terminal_free: (terminal: number) => void;
  ghostty_terminal_reset: (terminal: number) => void;
  ghostty_terminal_resize: (
    terminal: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number,
  ) => number;
  ghostty_terminal_vt_write: (terminal: number, dataPtr: number, dataLen: number) => void;
  ghostty_formatter_terminal_new: (
    allocator: number,
    formatterPtr: number,
    terminal: number,
    optionsPtr: number,
  ) => number;
  ghostty_formatter_format_alloc: (
    formatter: number,
    allocator: number,
    outPtrPtr: number,
    outLenPtr: number,
  ) => number;
  ghostty_formatter_free: (formatter: number) => void;
  ghostty_free: (allocator: number, ptr: number, len: number) => void;
  ghostty_key_encoder_new: (allocator: number, encoderPtr: number) => number;
  ghostty_key_encoder_free: (encoder: number) => void;
  ghostty_key_encoder_setopt_from_terminal: (encoder: number, terminal: number) => void;
  ghostty_key_encoder_encode: (
    encoder: number,
    event: number,
    outBuf: number,
    outBufSize: number,
    outLenPtr: number,
  ) => number;
  ghostty_key_event_new: (allocator: number, eventPtr: number) => number;
  ghostty_key_event_free: (event: number) => void;
  ghostty_key_event_set_action: (event: number, action: number) => void;
  ghostty_key_event_set_key: (event: number, key: number) => void;
  ghostty_key_event_set_mods: (event: number, mods: number) => void;
  ghostty_key_event_set_composing: (event: number, composing: number) => void;
  ghostty_key_event_set_utf8: (event: number, ptr: number, len: number) => void;
  ghostty_key_event_set_unshifted_codepoint: (event: number, codepoint: number) => void;
}

export interface CreateGhosttyWasmTerminalOptions {
  cols: number;
  rows: number;
  scrollback: number;
  cellWidth: number;
  cellHeight: number;
  wasmUrl?: string;
}

export class GhosttyWasmTerminal {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly exports: GhosttyWasmExports;
  private readonly layout: TypeLayout;
  private terminalPtr: number;
  private keyEncoderPtr: number;

  private constructor(input: {
    exports: GhosttyWasmExports;
    layout: TypeLayout;
    terminalPtr: number;
    keyEncoderPtr: number;
  }) {
    this.exports = input.exports;
    this.layout = input.layout;
    this.terminalPtr = input.terminalPtr;
    this.keyEncoderPtr = input.keyEncoderPtr;
  }

  static async create(options: CreateGhosttyWasmTerminalOptions): Promise<GhosttyWasmTerminal> {
    const wasmUrl = options.wasmUrl ?? DEFAULT_WASM_URL;
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(
        `libghostty-vt WebAssembly module not found at ${wasmUrl}. Run bun run build:libghostty-vt.`,
      );
    }
    const bytes = await response.arrayBuffer();
    const instanceRef: { current?: WebAssembly.Instance } = {};
    const module = await WebAssembly.instantiate(bytes, {
      env: {
        log: (ptr: number, len: number) => {
          const instance = instanceRef.current;
          const memory = instance?.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) return;
          const text = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
          console.debug("[libghostty-vt]", text);
        },
      },
    });
    instanceRef.current = module.instance;
    const exports = module.instance.exports as GhosttyWasmExports;
    const layout = readTypeLayout(exports);
    const terminalPtr = createTerminal(exports, layout, options);
    const keyEncoderPtr = createKeyEncoder(exports);
    return new GhosttyWasmTerminal({ exports, layout, terminalPtr, keyEncoderPtr });
  }

  dispose(): void {
    if (this.keyEncoderPtr !== 0) {
      this.exports.ghostty_key_encoder_free(this.keyEncoderPtr);
      this.keyEncoderPtr = 0;
    }
    if (this.terminalPtr !== 0) {
      this.exports.ghostty_terminal_free(this.terminalPtr);
      this.terminalPtr = 0;
    }
  }

  reset(): void {
    if (this.terminalPtr === 0) return;
    this.exports.ghostty_terminal_reset(this.terminalPtr);
  }

  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
    if (this.terminalPtr === 0) return;
    const result = this.exports.ghostty_terminal_resize(
      this.terminalPtr,
      Math.max(1, Math.min(1000, Math.floor(cols))),
      Math.max(1, Math.min(500, Math.floor(rows))),
      Math.max(1, Math.floor(cellWidth)),
      Math.max(1, Math.floor(cellHeight)),
    );
    assertSuccess(result, "ghostty_terminal_resize");
  }

  feed(data: string): void {
    if (this.terminalPtr === 0 || data.length === 0) return;
    const bytes = this.encoder.encode(data);
    const ptr = this.allocBytes(bytes);
    try {
      this.exports.ghostty_terminal_vt_write(this.terminalPtr, ptr, bytes.length);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    }
  }

  formatPlain(): string {
    return this.format(GHOSTTY_FORMATTER_FORMAT_PLAIN);
  }

  formatHtml(): string {
    return this.format(GHOSTTY_FORMATTER_FORMAT_HTML);
  }

  encodeKeyboardEvent(event: KeyboardEvent): string | null {
    if (this.terminalPtr === 0 || this.keyEncoderPtr === 0) return null;
    const key = GHOSTTY_KEY_CODE_BY_BROWSER_CODE[event.code] ?? 0;
    if (key === 0 && event.key.length !== 1) return null;

    this.exports.ghostty_key_encoder_setopt_from_terminal(this.keyEncoderPtr, this.terminalPtr);

    const eventPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    let eventPtr = 0;
    let utf8Ptr = 0;
    let utf8Len = 0;
    try {
      assertSuccess(this.exports.ghostty_key_event_new(0, eventPtrPtr), "ghostty_key_event_new");
      eventPtr = this.readPointer(eventPtrPtr);
      this.exports.ghostty_key_event_set_action(
        eventPtr,
        event.repeat ? GHOSTTY_KEY_ACTION_REPEAT : GHOSTTY_KEY_ACTION_PRESS,
      );
      this.exports.ghostty_key_event_set_key(eventPtr, key);
      this.exports.ghostty_key_event_set_mods(eventPtr, ghosttyModsFromKeyboardEvent(event));
      this.exports.ghostty_key_event_set_composing(eventPtr, event.isComposing ? 1 : 0);

      if (event.key.length === 1) {
        const utf8 = this.encoder.encode(event.key);
        utf8Len = utf8.length;
        utf8Ptr = this.allocBytes(utf8);
        this.exports.ghostty_key_event_set_utf8(eventPtr, utf8Ptr, utf8Len);
      }

      const unshifted = unshiftedCodepointFromKeyboardEvent(event);
      if (unshifted !== 0) {
        this.exports.ghostty_key_event_set_unshifted_codepoint(eventPtr, unshifted);
      }

      const requiredPtr = this.exports.ghostty_wasm_alloc_usize();
      try {
        this.exports.ghostty_key_encoder_encode(this.keyEncoderPtr, eventPtr, 0, 0, requiredPtr);
        const required = this.readUsize(requiredPtr);
        if (required === 0) return null;

        const outPtr = this.exports.ghostty_wasm_alloc_u8_array(required);
        const writtenPtr = this.exports.ghostty_wasm_alloc_usize();
        try {
          const result = this.exports.ghostty_key_encoder_encode(
            this.keyEncoderPtr,
            eventPtr,
            outPtr,
            required,
            writtenPtr,
          );
          if (result !== GHOSTTY_SUCCESS) return null;
          const written = this.readUsize(writtenPtr);
          if (written === 0) return null;
          return this.decoder.decode(new Uint8Array(this.exports.memory.buffer, outPtr, written));
        } finally {
          this.exports.ghostty_wasm_free_usize(writtenPtr);
          this.exports.ghostty_wasm_free_u8_array(outPtr, required);
        }
      } finally {
        this.exports.ghostty_wasm_free_usize(requiredPtr);
      }
    } finally {
      if (utf8Ptr !== 0) {
        this.exports.ghostty_wasm_free_u8_array(utf8Ptr, utf8Len);
      }
      if (eventPtr !== 0) {
        this.exports.ghostty_key_event_free(eventPtr);
      }
      this.exports.ghostty_wasm_free_opaque(eventPtrPtr);
    }
  }

  private format(format: number): string {
    if (this.terminalPtr === 0) return "";
    const optsSize = structLayout(this.layout, "GhosttyFormatterTerminalOptions").size;
    const optsPtr = this.exports.ghostty_wasm_alloc_u8_array(optsSize);
    let formatterPtr = 0;
    try {
      new Uint8Array(this.exports.memory.buffer, optsPtr, optsSize).fill(0);
      const view = new DataView(this.exports.memory.buffer, optsPtr, optsSize);
      setField(view, this.layout, "GhosttyFormatterTerminalOptions", "size", optsSize);
      setField(view, this.layout, "GhosttyFormatterTerminalOptions", "emit", format);
      setField(view, this.layout, "GhosttyFormatterTerminalOptions", "unwrap", 0);
      setField(view, this.layout, "GhosttyFormatterTerminalOptions", "trim", 0);
      setFormatterExtraSizes(view, this.layout);

      const formatterPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
      try {
        const result = this.exports.ghostty_formatter_terminal_new(
          0,
          formatterPtrPtr,
          this.terminalPtr,
          optsPtr,
        );
        assertSuccess(result, "ghostty_formatter_terminal_new");
        formatterPtr = this.readPointer(formatterPtrPtr);
      } finally {
        this.exports.ghostty_wasm_free_opaque(formatterPtrPtr);
      }

      const outPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
      const outLenPtr = this.exports.ghostty_wasm_alloc_usize();
      try {
        const result = this.exports.ghostty_formatter_format_alloc(
          formatterPtr,
          0,
          outPtrPtr,
          outLenPtr,
        );
        assertSuccess(result, "ghostty_formatter_format_alloc");
        const outPtr = this.readPointer(outPtrPtr);
        const outLen = this.readUsize(outLenPtr);
        try {
          return this.decoder.decode(new Uint8Array(this.exports.memory.buffer, outPtr, outLen));
        } finally {
          this.exports.ghostty_free(0, outPtr, outLen);
        }
      } finally {
        this.exports.ghostty_wasm_free_opaque(outPtrPtr);
        this.exports.ghostty_wasm_free_usize(outLenPtr);
      }
    } finally {
      if (formatterPtr !== 0) {
        this.exports.ghostty_formatter_free(formatterPtr);
      }
      this.exports.ghostty_wasm_free_u8_array(optsPtr, optsSize);
    }
  }

  private allocBytes(bytes: Uint8Array): number {
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
    return ptr;
  }

  private readPointer(ptr: number): number {
    return new DataView(this.exports.memory.buffer).getUint32(ptr, true);
  }

  private readUsize(ptr: number): number {
    return new DataView(this.exports.memory.buffer).getUint32(ptr, true);
  }
}

function readTypeLayout(exports: GhosttyWasmExports): TypeLayout {
  const jsonPtr = exports.ghostty_type_json();
  const memory = new Uint8Array(exports.memory.buffer);
  let end = jsonPtr;
  while (end < memory.length && memory[end] !== 0) {
    end += 1;
  }
  return JSON.parse(new TextDecoder().decode(memory.subarray(jsonPtr, end))) as TypeLayout;
}

function createTerminal(
  exports: GhosttyWasmExports,
  layout: TypeLayout,
  options: CreateGhosttyWasmTerminalOptions,
): number {
  const optsSize = structLayout(layout, "GhosttyTerminalOptions").size;
  const optsPtr = exports.ghostty_wasm_alloc_u8_array(optsSize);
  const terminalPtrPtr = exports.ghostty_wasm_alloc_opaque();
  try {
    new Uint8Array(exports.memory.buffer, optsPtr, optsSize).fill(0);
    const view = new DataView(exports.memory.buffer, optsPtr, optsSize);
    setField(view, layout, "GhosttyTerminalOptions", "cols", options.cols);
    setField(view, layout, "GhosttyTerminalOptions", "rows", options.rows);
    setField(view, layout, "GhosttyTerminalOptions", "max_scrollback", options.scrollback);
    const result = exports.ghostty_terminal_new(0, terminalPtrPtr, optsPtr);
    assertSuccess(result, "ghostty_terminal_new");
    const terminalPtr = new DataView(exports.memory.buffer).getUint32(terminalPtrPtr, true);
    assertSuccess(
      exports.ghostty_terminal_resize(
        terminalPtr,
        options.cols,
        options.rows,
        Math.max(1, Math.floor(options.cellWidth)),
        Math.max(1, Math.floor(options.cellHeight)),
      ),
      "ghostty_terminal_resize",
    );
    return terminalPtr;
  } finally {
    exports.ghostty_wasm_free_u8_array(optsPtr, optsSize);
    exports.ghostty_wasm_free_opaque(terminalPtrPtr);
  }
}

function createKeyEncoder(exports: GhosttyWasmExports): number {
  const encoderPtrPtr = exports.ghostty_wasm_alloc_opaque();
  try {
    assertSuccess(exports.ghostty_key_encoder_new(0, encoderPtrPtr), "ghostty_key_encoder_new");
    return new DataView(exports.memory.buffer).getUint32(encoderPtrPtr, true);
  } finally {
    exports.ghostty_wasm_free_opaque(encoderPtrPtr);
  }
}

function structLayout(layout: TypeLayout, structName: string): TypeLayoutStruct {
  const struct = layout[structName];
  if (!struct) {
    throw new Error(`libghostty-vt type layout missing ${structName}`);
  }
  return struct;
}

function field(layout: TypeLayout, structName: string, fieldName: string): TypeLayoutField {
  const struct = structLayout(layout, structName);
  const value = struct?.fields[fieldName];
  if (!value) {
    throw new Error(`libghostty-vt type layout missing ${structName}.${fieldName}`);
  }
  return value;
}

function setField(
  view: DataView,
  layout: TypeLayout,
  structName: string,
  fieldName: string,
  value: number,
): void {
  const info = field(layout, structName, fieldName);
  switch (info.type) {
    case "u8":
    case "bool":
      view.setUint8(info.offset, value);
      return;
    case "u16":
      view.setUint16(info.offset, value, true);
      return;
    case "u32":
    case "enum":
      view.setUint32(info.offset, value, true);
      return;
    case "u64":
      view.setBigUint64(info.offset, BigInt(value), true);
      return;
    case "usize":
      if (info.size === 8) {
        view.setBigUint64(info.offset, BigInt(value), true);
        return;
      }
      view.setUint32(info.offset, value, true);
      return;
    default:
      throw new Error(`Unsupported libghostty-vt field type: ${info.type}`);
  }
}

function setFormatterExtraSizes(view: DataView, layout: TypeLayout): void {
  const optionsExtra = field(layout, "GhosttyFormatterTerminalOptions", "extra").offset;
  const extraSize = structLayout(layout, "GhosttyFormatterTerminalExtra").size;
  const extraSizeField = field(layout, "GhosttyFormatterTerminalExtra", "size");
  view.setUint32(optionsExtra + extraSizeField.offset, extraSize, true);

  const screenOffset = field(layout, "GhosttyFormatterTerminalExtra", "screen").offset;
  const screenSize = structLayout(layout, "GhosttyFormatterScreenExtra").size;
  const screenSizeField = field(layout, "GhosttyFormatterScreenExtra", "size");
  view.setUint32(optionsExtra + screenOffset + screenSizeField.offset, screenSize, true);
}

function assertSuccess(result: number, operation: string): void {
  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`${operation} failed with libghostty-vt result ${result}`);
  }
}
