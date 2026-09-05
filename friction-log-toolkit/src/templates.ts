import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reusable note templates, saved per-directory in their own JSON file
 * (`.friction-log-templates.json`) — separate from `.friction-log.json` for
 * the same reason `.friction-logrc.json` is separate: a template is a
 * reusable *shape* for future entries, not itself a logged entry, and
 * shouldn't be touched by `init --force` clearing the log.
 *
 * A template's text can contain `{placeholder}` tokens (bare word
 * characters between curly braces); `template use` fills them in from
 * `--set key=value` pairs before logging the result as a normal entry.
 */

export const TEMPLATES_FILE_NAME = ".friction-log-templates.json";

export interface Template {
  name: string;
  /** Raw text, may contain `{placeholder}` tokens. */
  text: string;
  /** Tag applied by `template use` when neither the template nor a `--tag` override supplies a tag. */
  tag?: string;
}

interface TemplatesFile {
  version: 1;
  templates: Template[];
}

export class TemplateNotFoundError extends Error {
  constructor(name: string) {
    super(`No template named "${name}" found. Run "friction-log template list" to see saved templates.`);
    this.name = "TemplateNotFoundError";
  }
}

function templatesFilePath(dir: string): string {
  return join(dir, TEMPLATES_FILE_NAME);
}

function readTemplatesFile(dir: string): TemplatesFile {
  const path = templatesFilePath(dir);
  if (!existsSync(path)) return { version: 1, templates: [] };
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.templates)) {
      throw new Error("malformed");
    }
    return parsed as TemplatesFile;
  } catch {
    throw new Error(`Could not parse ${path} as JSON. The file may be corrupted.`);
  }
}

function writeTemplatesFile(dir: string, file: TemplatesFile): void {
  writeFileSync(templatesFilePath(dir), JSON.stringify(file, null, 2) + "\n", "utf8");
}

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

/** Names of every `{placeholder}` appearing in `text`, de-duplicated, in first-seen order. */
export function extractPlaceholders(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(PLACEHOLDER_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Substitutes every `{placeholder}` in `text` with the matching value from
 * `values`. Throws (listing every missing key at once, not just the first)
 * if any placeholder has no corresponding value — a partially-filled note
 * silently saved with a literal `{key}` still in it would be a worse
 * failure mode than a clear error up front.
 */
export function fillTemplate(text: string, values: Record<string, string>): string {
  const missing = new Set<string>();
  const filled = text.replace(PLACEHOLDER_RE, (_full, key: string) => {
    if (!(key in values)) {
      missing.add(key);
      return `{${key}}`;
    }
    return values[key];
  });
  if (missing.size > 0) {
    throw new Error(
      `Missing value(s) for placeholder(s): ${Array.from(missing).join(", ")}. Pass --set <key>=<value> for each.`
    );
  }
  return filled;
}

/** Saves (or replaces, if `name` already exists) a template. */
export function addTemplate(dir: string, name: string, text: string, tag?: string): Template {
  const trimmedName = name.trim();
  const trimmedText = text.trim();
  if (trimmedName.length === 0) {
    throw new Error("Template name cannot be empty.");
  }
  if (trimmedText.length === 0) {
    throw new Error("Template text cannot be empty.");
  }
  const trimmedTag = tag && tag.trim().length > 0 ? tag.trim() : undefined;
  const template: Template = { name: trimmedName, text: trimmedText, ...(trimmedTag ? { tag: trimmedTag } : {}) };

  const file = readTemplatesFile(dir);
  const idx = file.templates.findIndex((t) => t.name === trimmedName);
  if (idx === -1) {
    file.templates.push(template);
  } else {
    file.templates[idx] = template; // re-adding the same name replaces it
  }
  writeTemplatesFile(dir, file);
  return template;
}

/** All saved templates, in the order they were added (or last replaced). */
export function listTemplates(dir: string): Template[] {
  return readTemplatesFile(dir).templates;
}

/** Looks up one template by exact name. Throws `TemplateNotFoundError` if it doesn't exist. */
export function getTemplate(dir: string, name: string): Template {
  const template = readTemplatesFile(dir).templates.find((t) => t.name === name);
  if (!template) {
    throw new TemplateNotFoundError(name);
  }
  return template;
}
