import { tool } from "langchain";
import * as z from "zod";

export const QUESTION_TOOL_NAME = "marea_ask_user";

const QuestionSchema = z
  .object({
    text: z.string().trim().min(1).max(4096),
    choices: z.array(z.string().min(1).max(1024)).max(20),
    required: z.boolean(),
  })
  .strict();

const QuestionsSchema = z.array(QuestionSchema).min(1).max(12);
export type StudentQuestion = z.infer<typeof QuestionSchema>;

export interface QuestionRequest {
  readonly interruptId: string;
  readonly questions: readonly StudentQuestion[];
}

export function parseQuestions(
  arguments_: Readonly<Record<string, string>>,
): readonly StudentQuestion[] {
  return QuestionsSchema.parse(JSON.parse(z.string().parse(arguments_.questions)));
}

export function questionAnswers(
  questions: readonly StudentQuestion[],
  input: readonly string[],
): readonly string[] {
  z.array(z.unknown()).length(questions.length).parse(input);
  return questions.map((question, index) => {
    const value = z.string().max(4096).parse(input[index]);
    if (question.required && value.trim() === "") throw new Error("A required answer is missing.");
    return value;
  });
}

export function executeQuestion(arguments_: Readonly<Record<string, string>>): string {
  const questions = parseQuestions(arguments_);
  const values = questionAnswers(
    questions,
    z.array(z.string()).parse(JSON.parse(z.string().parse(arguments_.answers))),
  );
  return JSON.stringify({ answers: values });
}

export function createQuestionTools(enabled: boolean) {
  return enabled
    ? [
        tool(executeQuestion, {
          name: QUESTION_TOOL_NAME,
          description:
            "Ask the student structured questions and wait. Supply questions as a JSON array of {text, choices: string[], required: boolean}. Do not supply answers.",
          schema: z.object({
            questions: z.string().max(65536),
            answers: z.string().max(65536).optional(),
          }),
        }),
      ]
    : [];
}

export function questionInterrupts(enabled: boolean) {
  return enabled
    ? {
        [QUESTION_TOOL_NAME]: {
          allowedDecisions: ["approve", "edit", "reject"] as ("approve" | "edit" | "reject")[],
        },
      }
    : {};
}
