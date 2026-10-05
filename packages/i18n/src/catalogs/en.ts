import type { CompleteCatalog } from "../keys.js";

const englishCatalog = {
  "bootstrap.checking-connection": "Checking the connection to the teacher server…",
  "bootstrap.connection-failed":
    "Could not connect to the teacher server. Check your connection and try again.",
  "bootstrap.login-required": "Sign in to connect Marea to your teacher server.",
  "bootstrap.ready": "Marea is ready.",
  "bootstrap.resuming-session": "Resuming your session…",
  "bootstrap.starting-session": "Starting your session…",
  "errors.auth.invalid": "Authentication failed. Sign in again.",
  "errors.protocol.incompatible": "This client is not compatible with the teacher server.",
  "errors.request.invalid": "The request could not be understood.",
  "errors.run.unavailable": "The session is no longer available.",
  "errors.server.error": "The teacher server could not complete the request.",
  "student.auth.class": "Which class are you working in?",
  "student.auth.display-name-label": "Name shown to your teacher",
  "student.auth.external": "Sign in with {{provider}}",
  "student.auth.external-complete": "You can close this window and return to Marea.",
  "student.auth.external-failed":
    "Sign-in could not be completed. Close this window and try again from Marea.",
  "student.auth.external-open": "Open this address in your browser to continue: {{url}}",
  "student.auth.enroll": "Create my account with an invitation",
  "student.auth.invitation-label": "Invitation code",
  "student.auth.login": "Sign in",
  "student.auth.login-label": "Username",
  "student.auth.method": "How would you like to continue?",
  "student.auth.method-rejected":
    "Your saved session is no longer valid. How would you like to continue?",
  "student.auth.password-label": "Password",
  "student.auth.required": "This field is required.",
  "student.cli.help":
    "Usage: marea [--lang <locale>] [--no-mouse]\n       marea feedback\n       marea feedback --ack <notice-id>\n\nOpen Marea in the current project, read pending teacher feedback, or mark one notice as read. Use --lang automatic, es, en, or eu for this run.",
  "student.cli.invalid-language":
    "Invalid language option {{option}}. Use automatic, es, en, or eu.",
  "student.cli.language-save-failed":
    "The interface language could not be saved. It is active for this session only.",
  "student.cli.server-url-missing": "Marea does not have a teacher server address yet.",
  "student.cli.unexpected-error": "Marea could not start. Try again.",
  "student.feedback.ack-hint": "After reading it, mark it as read with: {{command}}",
  "student.feedback.acknowledged": "Feedback marked as read.",
  "student.feedback.empty": "No pending teacher feedback.",
  "student.feedback.failed":
    "Feedback could not be confirmed. Retry the same command; it is safe to repeat.",
  "student.feedback.heading": "Pending teacher feedback (up to 32 notices)",
  "student.feedback.login-required":
    "No saved student login for this server and project. Sign in with marea first.",
  "student.git.cancel": "Cancel",
  "student.git.cancelled": "Create the repository when you are ready, then start Marea again.",
  "student.git.confirm":
    "Marea needs a Git repository to record your changes and show them to your teacher. Create one in this folder?",
  "student.git.create": "Yes, create repository",
  "student.git.missing": "Marea needs Git to record your work. Install Git and start Marea again.",
  "student.git.not-root": "Start Marea from the repository root so it records only this project.",
  "student.conversation.approve": "Y approve",
  "student.conversation.input-placeholder": "Write a message",
  "student.conversation.marea-label": "Marea",
  "student.conversation.reject": "N reject",
  "student.conversation.retry": "Type /retry to retry",
  "student.conversation.status-cancelled": "Turn cancelled",
  "student.conversation.status-failed": "Turn failed",
  "student.conversation.student-label": "You",
  "student.conversation.title": "Marea · classroom",
  "student.tui.approval.approve": "Authorize",
  "student.tui.approval.approved": "Authorized",
  "student.tui.approval.cancelled": "Cancelled",
  "student.tui.approval.collapse": "v collapse",
  "student.tui.approval.edit-after": "+ after",
  "student.tui.approval.edit-before": "- before",
  "student.tui.approval.edit-all": "every occurrence",
  "student.tui.approval.edit-one": "one occurrence",
  "student.tui.approval.execute-warning":
    "The command runs with your system permissions and may modify files outside the project.",
  "student.tui.approval.expand": "> show everything",
  "student.tui.approval.lines": "{{count}} line(s)",
  "student.tui.approval.lines.one": "{{count}} line",
  "student.tui.approval.lines.other": "{{count}} lines",
  "student.tui.approval.reason-placeholder": "Optional reason; Enter to confirm",
  "student.tui.approval.reject": "Reject",
  "student.tui.approval.rejected": "Rejected",
  "student.tui.approval.rejected-with-reason": "Rejected: {{reason}}",
  "student.tui.approval.title": "Authorize · {{name}}",
  "student.tui.banner.branch": "branch",
  "student.tui.banner.directory": "directory",
  "student.tui.banner.footer": "/help for the commands · /exit to finish",
  "student.tui.banner.model": "model",
  "student.tui.banner.repository": "repository",
  "student.tui.command.details-description": "switch between compact and detailed outputs",
  "student.tui.command.exit-description": "leave Marea",
  "student.tui.command.help-description": "show the commands and shortcuts",
  "student.tui.command.language-description": "change the interface language",
  "student.tui.command.retry-description": "resume the last interrupted turn",
  "student.tui.composer.placeholder": "Write to Marea…",
  "student.tui.failure.recovery-pending": "A saved turn is waiting for explicit resumption.",
  "student.tui.failure.deadline-exceeded":
    "The configured time limit for this request was reached.",
  "student.tui.failure.budget-exhausted":
    "The session has insufficient budget for another request.",
  "student.tui.failure.concurrency-limited":
    "Another request is in progress. Wait for it to finish.",
  "student.tui.failure.provider-interrupted": "The provider interrupted the answer.",
  "student.tui.failure.resume-detail": "You can resume the turn from the last saved point.",
  "student.tui.help": `## Commands

- \`/help\` — shows this help.
- \`/retry\` — resumes the last interrupted turn without repeating your message.
- \`/details\` — switches between compact and full outputs.
- \`/language\` — cycles the interface language and saves the preference.
- \`/exit\` — ends the session.

## Keyboard

- **Enter** sends the message; **Shift+Enter** or **Ctrl+J** add a line.
- You can draft your next message while Marea answers; it is not sent until the turn ends.
- **Tab** and **Shift+Tab** move through the actions; **Enter** or **Space** activate them.
- **PageUp** and **PageDown** scroll the conversation.
- **Ctrl+O** expands or collapses the last output.
- With an empty prompt, **Ctrl+E** expands or collapses every output of the turn.
- **Escape** interrupts the current turn.
- The wheel or the trackpad scroll the conversation.
- Select text with the mouse to copy it automatically on release.
- Start Marea with \`--no-mouse\` if you need the terminal's own selection.
- **Ctrl+D** closes Marea.
- In an authorization, **y** authorizes and **n** lets you reject with a reason.
`,
  "student.tui.hint.approval": "Y authorize · N reject · Shift+Tab review",
  "student.tui.hint.questions": "Tab move · Enter continue",
  "student.tui.hint.ready": "Ctrl+O last output · PgUp/PgDn conversation · /help",
  "student.tui.hint.turn": "Esc interrupt",
  "student.tui.notice.clipboard": "Text copied to the clipboard",
  "student.tui.notice.quit-hint": "Press Ctrl+D to quit.",
  "student.tui.notice.draft-kept": "You can send it when Marea finishes responding.",
  "student.tui.notice.no-outputs": "There are no outputs yet",
  "student.tui.notice.no-retry": "There is no interrupted turn to retry",
  "student.tui.notice.no-turn-outputs": "This turn has no outputs yet",
  "student.tui.notice.language-changed": "Interface language: {{language}}",
  "student.tui.notice.language-save-failed":
    "The new interface language is active, but could not be saved.",
  "student.tui.notice.outputs-compact": "Compact outputs",
  "student.tui.notice.outputs-detailed": "Detailed outputs",
  "student.tui.notice.retrying": "↻ Retrying the interrupted turn…",
  "student.tui.question.cancelled": "Cancelled",
  "student.tui.question.next": "Next",
  "student.tui.question.placeholder": "Option number or answer",
  "student.tui.question.previous": "Previous",
  "student.tui.question.progress": "Question {{index}} of {{total}}",
  "student.tui.question.required": "This question is required.",
  "student.tui.question.send": "Send answers",
  "student.tui.question.sent": "Answers sent",
  "student.tui.question.title": "The agent needs you to decide",
  "student.tui.status.detail": "{{seconds}}s",
  "student.tui.status.finishing": "finishing",
  "student.tui.status.preparing": "Preparing the session…",
  "student.tui.status.ready": "ready",
  "student.tui.status.responding": "answering",
  "student.tui.status.retrying": "retrying",
  "student.tui.status.reviewing": "reviewing the project",
  "student.tui.status.starting": "preparing",
  "student.tui.status.thinking": "thinking",
  "student.tui.status.unrecoverable": "unrecoverable error",
  "student.tui.status.waiting-answer": "waiting for your answer",
  "student.tui.status.waiting-approval": "waiting for authorization",
  "student.tui.tool.empty-output": "(no output)",
  "student.tui.tool.lines-read": "{{count}} lines read",
  "student.tui.tool.lines-read.one": "{{count}} line read",
  "student.tui.tool.lines-read.other": "{{count}} lines read",
  "student.tui.tool.omitted-many": "… {{count}} earlier lines",
  "student.tui.tool.omitted-many.one": "… {{count}} earlier line",
  "student.tui.tool.omitted-many.other": "… {{count}} earlier lines",
  "student.tui.tool.omitted-one": "… 1 earlier line",
  "student.tui.tool.output": "output",
  "student.tui.tool.question": "question",
  "student.tui.tool.see-content": "Ctrl+O to see the contents",
  "student.tui.tool.see-output": "Ctrl+O to see the whole output",
  "student.tui.tool.subagent": "subagent",
  "student.tui.turn.driver-failed": "The interface could not finish the turn.",
  "student.tui.turn.interrupted": "Turn interrupted.",
  "student.tui.turn.retry": "Retry / continue",
  "student.tui.turn.retry-started": "Retry started",
  "skills.allowed-tools.forbidden":
    "Remove `allowed-tools`; educational skill metadata cannot grant tool permissions.",
  "skills.criteria.duplicate": "Give each criterion a unique `codigo` within the skill.",
  "skills.criteria.forbidden":
    "Remove `criterios`; evaluation skills define evaluation method, not learning criteria.",
  "skills.frontmatter.invalid": "Invalid frontmatter in {{location}}. {{action}}",
  "skills.frontmatter.missing": "Add YAML frontmatter delimited by `---` at the start of SKILL.md.",
  "skills.module.forbidden": "Remove `module`; Marea educational skills cannot execute code.",
  "skills.name.invalid":
    "Use a 1-64 character portable name containing only ASCII lowercase letters, numbers, and single hyphens.",
  "skills.name.mismatch": "Rename the directory to '{{name}}' or set name to '{{directory}}'.",
} as const satisfies CompleteCatalog;

export const ENGLISH_CATALOG = Object.freeze(englishCatalog);
