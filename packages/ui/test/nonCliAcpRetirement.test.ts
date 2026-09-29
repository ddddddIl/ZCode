import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
} from "../../shared/src/validationAppSettings.js";
import { zcodeTaskMetaSchema } from "../../shared/src/validation.js";
import { readAskUserQuestionAnswers } from "../src/lib/askUserQuestion.js";
import {
  getAgentPrimaryText,
  getAgentKindLabel,
} from "../src/ToolCallBlocks/renderers/agentHelpers.js";
import { getToolCallErrorText } from "../src/lib/toolError.js";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import { extractStructuredDiff } from "../src/lib/toolDiffPreview.js";

const meta = {
  taskId: "session-example",
  traceId: "trace-example",
  title: "Example",
  workspacePath: "/example/workspace",
  createdAt: 1,
  updatedAt: 2,
  mode: "build",
  provider: "glm",
};

test("current task metadata is accepted without upgrading third-party Agent identities", () => {
  assert.equal(zcodeTaskMetaSchema.parse(meta).provider, "glm");
  for (const provider of ["claude", "codex", "gemini", "opencode"]) {
    assert.equal(zcodeTaskMetaSchema.safeParse({ ...meta, provider }).success, false, provider);
  }
});

test("obsolete Agent settings are stripped without dropping current user preferences", () => {
  const settings = {
    enabledBuiltinAgentCliProviders: ["claude", "codex"],
    localePreference: "en-US",
  };
  for (const schema of [appSettingsSchema, appSettingsPatchSchema]) {
    const parsed = schema.parse(settings);
    assert.equal(parsed.localePreference, "en-US");
    assert.equal("enabledBuiltinAgentCliProviders" in parsed, false);
  }
});

test("current question results work while Claude ACP text is no longer interpreted as answers", () => {
  const input = { question: "Choose", options: [{ label: "One" }, { label: "Two" }] };
  assert.deepEqual(
    readAskUserQuestionAnswers({ input, output: { type: "answered", selected: "One" } }),
    { Choose: "One" },
  );
  assert.deepEqual(
    readAskUserQuestionAnswers({ input, output: { type: "answered_custom", text: "Custom" } }),
    { Choose: "Custom" },
  );
  assert.deepEqual(readAskUserQuestionAnswers({ output: { answers: { Choose: "Two" } } }), {
    Choose: "Two",
  });
  for (const output of ['"Choose"="One"', { content: [{ text: '"Choose"="One"' }] }]) {
    assert.equal(readAskUserQuestionAnswers({ input, output }), undefined);
    assert.equal(readAskUserQuestionAnswers({ input, raw: { output } }), undefined);
    assert.equal(readAskUserQuestionAnswers({ input, raw: { rawOutput: output } }), undefined);
  }
});

test("v4 projected AskUserQuestion rows expose answers via merged input", () => {
  // 修复后：permission modify 把用户答案合入 toolCall.input（实时投影 + 持久化冷恢复），
  // UI 从 input.answers 读回答案，而不是依赖 output 的模型叙事文本。
  const questions = [
    { question: "Choose", header: "Choice", options: [{ label: "One" }, { label: "Two" }] },
  ];
  const answeredInput = {
    questions,
    answers: { Choose: "One" },
    metadata: { source: "test" },
  };
  assert.deepEqual(readAskUserQuestionAnswers({ input: answeredInput }), {
    Choose: "One",
  });
  // output 仍是模型叙事文本（User has answered...）；不能因此丢失 input.answers。
  assert.deepEqual(
    readAskUserQuestionAnswers({
      input: answeredInput,
      output: 'User has answered your questions: "Choose"="One".',
    }),
    { Choose: "One" },
  );
  // 多题多选：answers 按问题文本键控，数组值拼接展示。
  const multiInput = {
    questions: [
      {
        question: "Features",
        header: "Feat",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
    answers: { Features: "A, B" },
  };
  assert.deepEqual(readAskUserQuestionAnswers({ input: multiInput }), { Features: "A, B" });
});

test("ZCode subagent identity wins over retired Codex nicknames", () => {
  const tool = {
    id: "tool-example",
    kind: "Agent",
    title: "Agent",
    status: "completed" as const,
    input: { subagent_type: "researcher", description: "Inspect sources" },
    raw: { nickname: "retired nickname" },
  };
  assert.equal(getAgentPrimaryText(tool, "Agent"), "Inspect sources");
  assert.equal(getAgentKindLabel(tool, "Agent"), "researcher");
  assert.equal(resolveToolCallIdentity({ toolName: "Task" }).family, "agent");
  assert.equal(resolveToolCallIdentity({ kind: "spawn_agent" }).family, "unknown");
});

test("current tool errors remain available without Claude ACP status overrides", () => {
  assert.equal(
    getToolCallErrorText({ status: "failed", error: "Permission denied" }),
    "Permission denied",
  );
  assert.equal(
    getToolCallErrorText({
      status: "failed",
      output: "<tool_use_error>Invalid input</tool_use_error>",
    }),
    "Invalid input",
  );
  assert.equal(
    getToolCallErrorText({
      status: "completed",
      raw: { status: "failed", rawOutput: "legacy error" },
    }),
    undefined,
  );
});

test("generic structured diffs still accept current tool content", () => {
  const diff = { type: "diff", path: "/example/file.ts", oldText: "before", newText: "after" };
  assert.deepEqual(extractStructuredDiff({ content: [diff] }), {
    path: diff.path,
    oldText: diff.oldText,
    newText: diff.newText,
  });
});
