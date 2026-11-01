import type { DocumentSyncMode } from "./documents/types.ts";
/** Conservative fallback when a provider exposes no tokenizer: ASCII prose /3,
 * non-ASCII by UTF-8 byte count, avoiding an English chars/4 assumption for Chinese. */
export function subjectTokenEstimate(text: string) {
  let ascii = 0,
    other = 0;
  for (const c of text) {
    if (c.codePointAt(0)! < 128) ascii++;
    else other += new TextEncoder().encode(c).length;
  }
  return Math.ceil(ascii / 3) + other;
}
export function subjectContextBudget(
  contextWindow: number,
  system: string,
  history: string,
  outputReserve = 4096,
) {
  return Math.min(
    8000,
    Math.max(
      0,
      Math.floor(
        (contextWindow -
          subjectTokenEstimate(system) -
          subjectTokenEstimate(history) -
          outputReserve -
          2048) *
          0.15,
      ),
    ),
  );
}
export const SUBJECT_LIMITS = {
  noteBytes: 5 * 1024 * 1024,
  notes: 10000,
  entries: 25000,
  bytes: 250 * 1024 * 1024,
  depth: 32,
  batch: 100,
} as const;
export interface SubjectGroup {
  id: string;
  chatId: string;
  title: string;
  items: Array<{ documentId: string; proposalId: string }>;
  createdAt: string;
}
export interface SubjectNote {
  id: string;
  path: string;
}
export interface Subject {
  version: 1;
  groups?: SubjectGroup[];
  id: string;
  name: string;
  mode: DocumentSyncMode;
  notes: SubjectNote[];
  exclusions: string[];
  roles: { sources: string[]; checkpoint?: string; log?: string };
  chatIds: string[];
  logging: boolean;
  updatedAt: string;
}
export interface FolderSelection {
  handle: string;
  name: string;
  kind: "desktop" | "android";
  writable: boolean;
}
export interface FolderEntry {
  name: string;
  directory: boolean;
  size?: number;
  identity?: string;
  error?: string;
}
export interface ScanState {
  phase: "idle" | "scanning" | "partial" | "ready" | "error" | "cancelled";
  visited: number;
  indexed: number;
  bytes: number;
  issues: Array<{ path: string; reason: string }>;
  lastScannedAt?: string;
  error?: string;
}
export interface SubjectView extends Subject {
  bound: boolean;
  writable: boolean;
  scan: ScanState;
  pending: number;
}
export function relativeNotePath(value: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    /[\u0000-\u001f:]/.test(value) ||
    value.startsWith("/") ||
    (!allowEmpty && !value)
  )
    throw Error("Choose a relative path inside the subject folder.");
  if (
    value &&
    value
      .split("/")
      .some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))
  )
    throw Error("Invalid subject path.");
  return value;
}
export function excludedSubjectPath(
  value: string,
  exclusions: string[] = [],
): boolean {
  return (
    value
      .split("/")
      .some(
        (p) =>
          p.startsWith(".") ||
          /^(node_modules|\$RECYCLE\.BIN|trash|runtime|build|dist)$/i.test(p),
      ) ||
    /\.(bak|backup|tmp|swp)$/i.test(value) ||
    exclusions.some(
      (p) => value === p || value.startsWith(p.replace(/\/$/, "") + "/"),
    )
  );
}
export function validSubject(value: any): value is Subject {
  if (
    !value ||
    value.version !== 1 ||
    !/^ws_[a-zA-Z0-9_-]+$/.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.length > 200 ||
    !["external", "app"].includes(value.mode) ||
    !Array.isArray(value.notes) ||
    value.notes.length > SUBJECT_LIMITS.notes ||
    !Array.isArray(value.exclusions) ||
    !Array.isArray(value.chatIds) ||
    typeof value.logging !== "boolean" ||
    !value.roles ||
    !Array.isArray(value.roles.sources)
  )
    return false;
  try {
    const ids = new Set<string>(),
      paths = new Set<string>();
    for (const n of value.notes) {
      relativeNotePath(n.path);
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(n.id) ||
        !n.path.toLowerCase().endsWith(".md") ||
        ids.has(n.id) ||
        paths.has(n.path)
      )
        return false;
      ids.add(n.id);
      paths.add(n.path);
    }
    return (
      [...value.roles.sources, value.roles.checkpoint, value.roles.log]
        .filter(Boolean)
        .every((id) => ids.has(id)) &&
      value.exclusions.every(
        (p: unknown) => typeof p === "string" && relativeNotePath(p),
      ) &&
      value.chatIds.every(
        (id: unknown) =>
          typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id),
      )
    );
  } catch {
    return false;
  }
}
/** Resolve only included notes; callers can report ambiguity without guessing. */
export function resolveSubjectLink(
  notes: Array<SubjectNote & { aliases?: string[] }>,
  from: string,
  raw: string,
): {
  status: "resolved" | "missing" | "ambiguous" | "unsupported";
  noteId?: string;
  anchor?: string;
} {
  let target = raw
    .replace(/^!?(?:\[\[)/, "")
    .replace(/\]\]$/, "")
    .split("|")[0]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    return { status: "unsupported" };
  }
  if (/^[a-z]+:|^\/|\\/i.test(target)) return { status: "unsupported" };
  const [file, anchor] = target.split("#");
  let candidates: SubjectNote[];
  if (!file) candidates = notes.filter((n) => n.path === from);
  else {
    const parts = from.split("/").slice(0, -1);
    for (const p of file.split("/")) {
      if (p === "..") {
        if (!parts.length) return { status: "unsupported" };
        parts.pop();
      } else if (p !== ".") parts.push(p);
    }
    const exact = parts.join("/").replace(/\.md$/i, "");
    candidates = notes.filter((n) => n.path.replace(/\.md$/i, "") === exact);
    if (!candidates.length && !file.includes("/"))
      candidates = notes.filter(
        (n) =>
          n.path.split("/").at(-1)?.replace(/\.md$/i, "") ===
            file.replace(/\.md$/i, "") || n.aliases?.includes(file),
      );
  }
  return candidates.length === 1
    ? { status: "resolved", noteId: candidates[0]!.id, anchor }
    : { status: candidates.length ? "ambiguous" : "missing" };
}
