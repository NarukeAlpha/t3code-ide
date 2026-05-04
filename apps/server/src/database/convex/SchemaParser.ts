import { readFile } from "node:fs/promises";

import { type DatabaseConvexSchemaFilePath, type DatabaseTableName } from "@t3tools/contracts";

import { resolveProjectRelativePathWithinRoot, toDatabaseError } from "./shared.ts";

export interface ConvexSchemaTableDefinition {
  readonly name: DatabaseTableName;
  readonly fieldNames: ReadonlyArray<string>;
}

export interface ConvexSchemaDefinition {
  readonly schemaFilePath: DatabaseConvexSchemaFilePath;
  readonly tables: ReadonlyArray<ConvexSchemaTableDefinition>;
}

interface ScanState {
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inBacktickQuote: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
}

function createInitialScanState(): ScanState {
  return {
    inSingleQuote: false,
    inDoubleQuote: false,
    inBacktickQuote: false,
    inLineComment: false,
    inBlockComment: false,
  };
}

function advanceScanState(text: string, index: number, state: ScanState) {
  const character = text[index];
  const nextCharacter = text[index + 1];

  if (state.inLineComment) {
    if (character === "\n") {
      state.inLineComment = false;
    }
    return;
  }

  if (state.inBlockComment) {
    if (character === "*" && nextCharacter === "/") {
      state.inBlockComment = false;
    }
    return;
  }

  if (state.inSingleQuote) {
    if (character === "\\") {
      return;
    }
    if (character === "'") {
      state.inSingleQuote = false;
    }
    return;
  }

  if (state.inDoubleQuote) {
    if (character === "\\") {
      return;
    }
    if (character === '"') {
      state.inDoubleQuote = false;
    }
    return;
  }

  if (state.inBacktickQuote) {
    if (character === "\\") {
      return;
    }
    if (character === "`") {
      state.inBacktickQuote = false;
    }
    return;
  }

  if (character === "/" && nextCharacter === "/") {
    state.inLineComment = true;
    return;
  }

  if (character === "/" && nextCharacter === "*") {
    state.inBlockComment = true;
    return;
  }

  if (character === "'") {
    state.inSingleQuote = true;
    return;
  }

  if (character === '"') {
    state.inDoubleQuote = true;
    return;
  }

  if (character === "`") {
    state.inBacktickQuote = true;
  }
}

function isInsideCommentOrString(state: ScanState) {
  return (
    state.inSingleQuote ||
    state.inDoubleQuote ||
    state.inBacktickQuote ||
    state.inLineComment ||
    state.inBlockComment
  );
}

function findMatchingDelimiter(
  text: string,
  startIndex: number,
  openCharacter: string,
  closeCharacter: string,
) {
  const state = createInitialScanState();
  let depth = 0;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (isInsideCommentOrString(state)) {
      advanceScanState(text, index, state);
      continue;
    }

    if (character === openCharacter) {
      depth += 1;
      advanceScanState(text, index, state);
      continue;
    }

    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      advanceScanState(text, index, state);
      continue;
    }

    advanceScanState(text, index, state);
  }

  return -1;
}

function splitTopLevelSegments(text: string) {
  const segments: string[] = [];
  const state = createInitialScanState();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let segmentStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (isInsideCommentOrString(state)) {
      advanceScanState(text, index, state);
      continue;
    }

    switch (character) {
      case "{":
        braceDepth += 1;
        break;
      case "}":
        braceDepth -= 1;
        break;
      case "[":
        bracketDepth += 1;
        break;
      case "]":
        bracketDepth -= 1;
        break;
      case "(":
        parenthesisDepth += 1;
        break;
      case ")":
        parenthesisDepth -= 1;
        break;
      case ",":
        if (braceDepth === 0 && bracketDepth === 0 && parenthesisDepth === 0) {
          const segment = text.slice(segmentStart, index).trim();
          if (segment.length > 0) {
            segments.push(segment);
          }
          segmentStart = index + 1;
        }
        break;
    }

    advanceScanState(text, index, state);
  }

  const finalSegment = text.slice(segmentStart).trim();
  if (finalSegment.length > 0) {
    segments.push(finalSegment);
  }

  return segments;
}

function findTopLevelColonIndex(text: string) {
  const state = createInitialScanState();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (isInsideCommentOrString(state)) {
      advanceScanState(text, index, state);
      continue;
    }

    switch (character) {
      case "{":
        braceDepth += 1;
        break;
      case "}":
        braceDepth -= 1;
        break;
      case "[":
        bracketDepth += 1;
        break;
      case "]":
        bracketDepth -= 1;
        break;
      case "(":
        parenthesisDepth += 1;
        break;
      case ")":
        parenthesisDepth -= 1;
        break;
      case ":":
        if (braceDepth === 0 && bracketDepth === 0 && parenthesisDepth === 0) {
          return index;
        }
        break;
    }

    advanceScanState(text, index, state);
  }

  return -1;
}

function parsePropertyName(text: string) {
  const trimmed = text.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) {
    return trimmed;
  }
  const quotedMatch = /^(['"])(?<value>(?:\\.|(?!\1).)+)\1$/u.exec(trimmed);
  return quotedMatch?.groups?.value ?? null;
}

function findFirstTopLevelObjectStart(text: string) {
  const state = createInitialScanState();
  let bracketDepth = 0;
  let parenthesisDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (isInsideCommentOrString(state)) {
      advanceScanState(text, index, state);
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth -= 1;
    } else if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      parenthesisDepth -= 1;
    } else if (character === "{" && bracketDepth === 0 && parenthesisDepth === 0) {
      return index;
    }

    advanceScanState(text, index, state);
  }

  return -1;
}

function extractObjectBody(text: string) {
  const objectStartIndex = findFirstTopLevelObjectStart(text);
  if (objectStartIndex < 0) {
    return null;
  }

  const objectEndIndex = findMatchingDelimiter(text, objectStartIndex, "{", "}");
  if (objectEndIndex < 0) {
    throw toDatabaseError("Convex schema contains an unterminated object literal.");
  }

  return text.slice(objectStartIndex + 1, objectEndIndex);
}

function extractSchemaTables(schemaBody: string): ReadonlyArray<ConvexSchemaTableDefinition> {
  const tables: ConvexSchemaTableDefinition[] = [];

  for (const segment of splitTopLevelSegments(schemaBody)) {
    const colonIndex = findTopLevelColonIndex(segment);
    if (colonIndex < 0) {
      continue;
    }

    const propertyName = parsePropertyName(segment.slice(0, colonIndex));
    if (!propertyName) {
      continue;
    }

    const valueText = segment.slice(colonIndex + 1).trimStart();
    if (!valueText.startsWith("defineTable(")) {
      continue;
    }

    const defineTableOpenParenthesisIndex = valueText.indexOf("(");
    const defineTableCloseParenthesisIndex = findMatchingDelimiter(
      valueText,
      defineTableOpenParenthesisIndex,
      "(",
      ")",
    );
    if (defineTableCloseParenthesisIndex < 0) {
      throw toDatabaseError(`Convex table "${propertyName}" has an unterminated defineTable call.`);
    }

    const defineTableArguments = valueText.slice(
      defineTableOpenParenthesisIndex + 1,
      defineTableCloseParenthesisIndex,
    );
    const fieldObjectBody = extractObjectBody(defineTableArguments);
    const fieldNames =
      fieldObjectBody === null
        ? []
        : splitTopLevelSegments(fieldObjectBody)
            .map((fieldSegment) => {
              const fieldColonIndex = findTopLevelColonIndex(fieldSegment);
              if (fieldColonIndex < 0) {
                return null;
              }
              return parsePropertyName(fieldSegment.slice(0, fieldColonIndex));
            })
            .filter((fieldName): fieldName is string => fieldName !== null);

    tables.push({
      name: propertyName as DatabaseTableName,
      fieldNames,
    });
  }

  if (tables.length === 0) {
    throw toDatabaseError(
      "Convex schema parsing currently supports only `export default defineSchema({ tableName: defineTable(...) })` shapes.",
    );
  }

  return tables;
}

export async function parseConvexSchema(input: {
  readonly projectRoot: string;
  readonly schemaFilePath: DatabaseConvexSchemaFilePath;
}): Promise<ConvexSchemaDefinition> {
  const resolvedPath = resolveProjectRelativePathWithinRoot(
    input.projectRoot,
    input.schemaFilePath,
  );
  const fileContents = await readFile(resolvedPath.absolutePath, "utf8").catch((cause) => {
    throw toDatabaseError(`Failed to read Convex schema file ${resolvedPath.relativePath}.`, cause);
  });

  const exportDefaultIndex = fileContents.indexOf("export default");
  const defineSchemaIndex = fileContents.indexOf(
    "defineSchema",
    exportDefaultIndex >= 0 ? exportDefaultIndex : 0,
  );
  if (defineSchemaIndex < 0) {
    throw toDatabaseError(
      "Convex schema parsing requires an `export default defineSchema(...)` declaration.",
    );
  }

  const defineSchemaOpenParenthesisIndex = fileContents.indexOf(
    "(",
    defineSchemaIndex + "defineSchema".length,
  );
  if (defineSchemaOpenParenthesisIndex < 0) {
    throw toDatabaseError("Convex schema parsing could not find the defineSchema argument list.");
  }

  const defineSchemaCloseParenthesisIndex = findMatchingDelimiter(
    fileContents,
    defineSchemaOpenParenthesisIndex,
    "(",
    ")",
  );
  if (defineSchemaCloseParenthesisIndex < 0) {
    throw toDatabaseError("Convex schema parsing found an unterminated defineSchema call.");
  }

  const defineSchemaArguments = fileContents.slice(
    defineSchemaOpenParenthesisIndex + 1,
    defineSchemaCloseParenthesisIndex,
  );
  const schemaBody = extractObjectBody(defineSchemaArguments);
  if (schemaBody === null) {
    throw toDatabaseError(
      "Convex schema parsing requires the first defineSchema argument to be an object literal.",
    );
  }

  return {
    schemaFilePath: resolvedPath.relativePath as DatabaseConvexSchemaFilePath,
    tables: extractSchemaTables(schemaBody),
  };
}
