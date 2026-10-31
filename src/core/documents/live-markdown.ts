import type { ChatRecord } from "../contracts.ts";
import type { LhMessage } from "../native-messages.ts";
import { failedOutputCallIds } from "../native-messages.ts";
import { messageMarkdown, type MarkdownContext } from "../session-markdown.ts";
import { parseQuestionInput } from "../tool-parts.ts";
import {
  normalizeOptions,
  shuffleOptions,
  seededRandom,
} from "../question-core.ts";
import type { LiveDocumentBlock } from "./types.ts";
/** Projects the learner's visible state, never raw tool arguments or thinking. */
export function liveDocumentBlocks(record: ChatRecord): LiveDocumentBlock[] {
  const calls: MarkdownContext["calls"] = new Map();
  const errors = new Set<string>();
  for (const m of record.messages) {
    if (m.role === "assistant")
      for (const p of m.content)
        if (p.type === "toolCall")
          calls.set(p.id, { name: p.name, args: p.arguments });
    if (m.role === "toolResult" && m.isError) errors.add(m.toolCallId);
  }
  const ctx: MarkdownContext = {
    messages: record.messages,
    calls,
    failedOutputCalls: failedOutputCallIds(record.messages),
  };
  const blocks: LiveDocumentBlock[] = [];
  for (const [index, m] of record.messages.entries()) {
    const mid = m.id || `legacy-${index}`;
    if (m.role === "user" || m.role === "assistant") {
      const prose = messageMarkdown(m, mid, false, ctx);
      if (prose) blocks.push({ id: `${mid}:prose`, markdown: prose });
      if (m.role === "assistant")
        for (const p of m.content) {
          if (p.type !== "toolCall" || errors.has(p.id)) continue;
          const input = parseQuestionInput(p.name, p.arguments);
          if (!input) continue;
          const options =
            "options" in input ? normalizeOptions(input.options || []) : [];
          const ordered =
            p.name === "quiz"
              ? shuffleOptions(options, seededRandom(p.id))
              : options;
          const body = [
            `### ${p.name === "ask_user_question" ? "Question" : "Quiz"}`,
            input.question,
            input.details || "",
            ...ordered.map((o, i) => `${i + 1}. ${o.label}`),
          ]
            .filter(Boolean)
            .join("\n\n");
          blocks.push({ id: `${p.id}:question`, markdown: body });
        }
    } else if (m.role === "custom" && m.customType === "practice-thinking") {
      const text = (m.details as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim())
        blocks.push({
          id: `${mid}:thinking`,
          markdown: "### Your thinking\n\n" + text,
        });
    } else if (m.role === "toolResult" && !m.isError) {
      if (
        ![
          "quiz",
          "probe",
          "recall",
          "explain",
          "ask_user_question",
          "problem",
          "conclude",
        ].includes(m.toolName)
      )
        continue;
      let body = messageMarkdown(m, mid, false, ctx);
      if (!body) continue;
      // Feedback is released only after the actual submitted result exists.
      if (["quiz", "probe", "recall", "explain"].includes(m.toolName)) {
        const d = m.details as Record<string, unknown> | undefined;
        if (Array.isArray(d?.answers) && d.answers.length)
          body +=
            "\n\nYour answer: " +
            d.answers
              .map((a) =>
                typeof a === "object" && a
                  ? String((a as { label?: unknown }).label || "")
                  : String(a),
              )
              .join(", ");
        if (typeof d?.readingThinking === "string" && d.readingThinking)
          body += "\n\nYour reasoning: " + d.readingThinking;
        if (
          Array.isArray(d?.options) &&
          Array.isArray(d?.correctIndices) &&
          !d?.dismissed
        ) {
          const labels = d.correctIndices
            .map((i) =>
              d.options instanceof Array
                ? d.options.find(
                    (o) =>
                      o &&
                      typeof o === "object" &&
                      (o as { index?: unknown }).index === i,
                  )
                : null,
            )
            .filter(Boolean)
            .map((o) => String((o as { label?: unknown }).label || ""));
          if (labels.length) body += "\n\nCorrect answer: " + labels.join(", ");
        }
        const input = parseQuestionInput(
          m.toolName,
          calls.get(m.toolCallId)?.args,
        );
        const submitted = Boolean(
          d &&
            (Array.isArray(d.answers) ||
              typeof d.correct === "boolean" ||
              d.kind === "explain"),
        );
        if (
          submitted &&
          input &&
          !d?.dismissed &&
          "explanation" in input &&
          typeof input.explanation === "string"
        )
          body += "\n\n" + input.explanation;
        if (
          submitted &&
          input &&
          m.toolName === "explain" &&
          !d?.dismissed &&
          "correctAnswer" in input
        )
          body += "\n\nReference answer: " + String(input.correctAnswer);
      }
      blocks.push({ id: `${m.toolCallId}:result`, markdown: body });
    }
  }
  return blocks;
}
