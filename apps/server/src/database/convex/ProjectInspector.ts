import * as Path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  DatabaseConvexGatewayBaseUrl,
  DatabaseConvexSchemaFilePath,
  DatabaseInspectConvexProjectResult,
} from "@t3tools/contracts";

import {
  CONVEX_DEFAULT_SCHEMA_FILE_PATH,
  CONVEX_PREFILL_ENV_VARS,
  deriveConvexGatewayBaseUrl,
  fileExists,
} from "./shared.ts";

const CONVEX_ENV_FILES = [".env.local", ".env"] as const;

function asInspectionNote(note: string) {
  return note as DatabaseInspectConvexProjectResult["notes"][number];
}

function asDetectedString(value: string | null) {
  return value as DatabaseInspectConvexProjectResult["detectedFromEnvFile"];
}

function parseEnvValue(rawValue: string) {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const firstCharacter = trimmed[0];
  if (
    (firstCharacter === '"' || firstCharacter === "'" || firstCharacter === "`") &&
    trimmed.endsWith(firstCharacter)
  ) {
    return trimmed.slice(1, -1);
  }

  const inlineCommentIndex = trimmed.search(/\s#/);
  return inlineCommentIndex >= 0 ? trimmed.slice(0, inlineCommentIndex).trimEnd() : trimmed;
}

function parseDotEnv(text: string) {
  const entries = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const exportPrefix = trimmedLine.startsWith("export ")
      ? trimmedLine.slice("export ".length).trimStart()
      : trimmedLine;
    const separatorIndex = exportPrefix.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = exportPrefix.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    const value = parseEnvValue(exportPrefix.slice(separatorIndex + 1));
    if (value.length > 0) {
      entries.set(key, value);
    }
  }

  return entries;
}

export async function inspectConvexProject(input: {
  readonly projectRoot: string;
}): Promise<DatabaseInspectConvexProjectResult> {
  const notes: Array<DatabaseInspectConvexProjectResult["notes"][number]> = [];

  const schemaAbsolutePath = Path.resolve(input.projectRoot, CONVEX_DEFAULT_SCHEMA_FILE_PATH);
  const schemaExists = await fileExists(schemaAbsolutePath);
  if (schemaExists) {
    notes.push(asInspectionNote(`Found Convex schema at ${CONVEX_DEFAULT_SCHEMA_FILE_PATH}.`));
  } else {
    notes.push(
      asInspectionNote(`Convex schema was not found at ${CONVEX_DEFAULT_SCHEMA_FILE_PATH}.`),
    );
  }

  let detectedFromEnvFile: string | null = null;
  let detectedFromEnvVar: string | null = null;
  let detectedGatewaySource: string | null = null;

  for (const envFileName of CONVEX_ENV_FILES) {
    const envFilePath = Path.resolve(input.projectRoot, envFileName);
    if (!(await fileExists(envFilePath))) {
      continue;
    }

    const envFileContents = await readFile(envFilePath, "utf8");
    const envEntries = parseDotEnv(envFileContents);
    for (const envVarName of CONVEX_PREFILL_ENV_VARS) {
      const value = envEntries.get(envVarName);
      if (!value) {
        continue;
      }

      detectedFromEnvFile = envFileName;
      detectedFromEnvVar = envVarName;
      detectedGatewaySource = value;
      break;
    }

    if (detectedGatewaySource !== null) {
      break;
    }
  }

  if (detectedGatewaySource === null) {
    notes.push(asInspectionNote("No Convex deployment URL was found in .env.local or .env."));
    notes.push(
      asInspectionNote(
        "Enter the Convex gateway base URL manually if the project uses a nonstandard setup.",
      ),
    );
  } else {
    notes.push(
      asInspectionNote(
        `Detected Convex deployment URL from ${detectedFromEnvFile} via ${detectedFromEnvVar}.`,
      ),
    );
  }

  const gatewayBaseUrl =
    detectedGatewaySource === null ? null : deriveConvexGatewayBaseUrl(detectedGatewaySource);
  if (detectedGatewaySource !== null && gatewayBaseUrl !== null) {
    notes.push(asInspectionNote(`Derived Convex gateway base URL ${gatewayBaseUrl}.`));
  } else if (detectedGatewaySource !== null) {
    notes.push(
      asInspectionNote(
        "Detected a Convex deployment URL but could not derive a matching .convex.site gateway URL automatically.",
      ),
    );
    notes.push(asInspectionNote("Enter the Convex gateway base URL manually."));
  }

  return {
    schemaFilePath: schemaExists
      ? (CONVEX_DEFAULT_SCHEMA_FILE_PATH as DatabaseConvexSchemaFilePath)
      : null,
    gatewayBaseUrl: gatewayBaseUrl as DatabaseConvexGatewayBaseUrl | null,
    detectedFromEnvFile: asDetectedString(detectedFromEnvFile),
    detectedFromEnvVar:
      detectedFromEnvVar as DatabaseInspectConvexProjectResult["detectedFromEnvVar"],
    notes,
    canScaffold: true,
  };
}
