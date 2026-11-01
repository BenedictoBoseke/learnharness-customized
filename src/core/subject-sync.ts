import { validSubject, type Subject } from "./subjects.ts";
export function portableSubject(value: unknown): Subject {
  if (!validSubject(value)) throw Error("Invalid subject record.");
  const w = value;
  return {
    version: 1,
    id: w.id,
    name: w.name,
    mode: w.mode,
    notes: w.notes.map((n) => ({ id: n.id, path: n.path })),
    roles: {
      sources: [...w.roles.sources],
      ...(w.roles.checkpoint ? { checkpoint: w.roles.checkpoint } : {}),
      ...(w.roles.log ? { log: w.roles.log } : {}),
    },
    chatIds: [...w.chatIds],
    exclusions: [...w.exclusions],
    logging: w.logging,
    updatedAt: w.updatedAt,
    ...(w.groups
      ? {
          groups: w.groups.map((g) => ({
            id: g.id,
            chatId: g.chatId,
            title: w.mode === "external" ? "Related note changes" : g.title,
            items: g.items.map((i) => ({
              documentId: i.documentId,
              proposalId: i.proposalId,
            })),
            createdAt: g.createdAt,
          })),
        }
      : {}),
  };
}
/** Preserve valid tool-call/result pairing and ordinary lesson speech, not raw source-tool payloads. */
export function externalSubjectTranscript<T>(
  record: T,
  externalNoteIds: Set<string>,
  externalChat: boolean,
): T {
  const copy = structuredClone(record) as any;
  if (!Array.isArray(copy.messages)) return copy;
  const privateCalls = new Set<string>(),
    isSubjectTool = (name: string) =>
      /^(list_subject_notes|search_subject_notes|read_subject_note|propose_subject_edit|create_subject_edit_group)$/.test(
        name,
      );
  for (const m of copy.messages)
    if (m.role === "assistant" && Array.isArray(m.content))
      for (const call of m.content) {
        if (call.type !== "toolCall") continue;
        const noteId = call.arguments?.noteId || call.arguments?.documentId;
        const redact =
          (externalChat &&
            (isSubjectTool(call.name) ||
              ["read", "ls", "grep"].includes(call.name))) ||
          (["read_linked_document", "propose_document_edit"].includes(
            call.name,
          ) &&
            (externalNoteIds.has(noteId) || (!noteId && externalChat)));
        if (redact) {
          privateCalls.add(call.id);
          call.arguments = {
            ...(noteId ? { noteId } : {}),
            sourceContent:
              "Device-local external note payload omitted; re-read the original on this device after Resume here.",
          };
        }
      }
  for (const m of copy.messages)
    if (m.role === "toolResult" && privateCalls.has(m.toolCallId)) {
      m.content = [
        {
          type: "text",
          text: "External note source payload is device-local. Re-read the included original note before using or editing it.",
        },
      ];
      delete m.details;
    }
  return copy;
}
