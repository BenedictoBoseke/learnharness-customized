export type DocumentSyncMode = "app" | "external";
export interface LinkedDocument {
  id: string;
  name: string;
  chatIds: string[];
  mode: DocumentSyncMode;
  logging: boolean;
  text: string;
  revision: string;
  updatedAt: string;
  blockHashes: Record<string, string>;
  error?: string;
}
export interface DocumentView {
  id: string;
  name: string;
  chatIds: string[];
  mode: DocumentSyncMode;
  logging: boolean;
  revision: string;
  updatedAt: string;
  bound: boolean;
  writable: boolean;
  error?: string;
  proposals: DocumentProposal[];
}
export interface DocumentProposal {
  id: string;
  documentId: string;
  chatId: string;
  baseRevision: string;
  before: string;
  after: string;
  reason: string;
  status: "pending" | "applied" | "rejected" | "undone";
  createdAt: string;
  appliedRevision?: string;
}
export interface DocumentBinding {
  documentId: string;
  kind: "desktop" | "android";
  handle: string;
  writable: boolean;
  lastWrittenRevision?: string;
}
export interface DocumentNativeAdapter {
  read(handle: string): Promise<string>;
  write(handle: string, text: string, expectedHash: string): Promise<void>;
}
/** Exact replacement prevents an ambiguous model edit from modifying an unintended paragraph. */
export function replaceExact(
  text: string,
  before: string,
  after: string,
): string {
  if (!before || before === after)
    throw new Error("Choose existing text and a different replacement.");
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) >= 0)
    throw new Error(
      "The selected text has changed or is ambiguous. Read the document again and propose a focused edit.",
    );
  return text.slice(0, index) + after + text.slice(index + before.length);
}
export interface LiveDocumentBlock {
  id: string;
  markdown: string;
}
