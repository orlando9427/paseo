import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

describe("OpenCode native attachment replay", () => {
  test("retains file/image-only user content and exact native references during replay", async () => {
    const runtime = new TestOpenCodeHarness();
    const native = new TestOpenCodeClient();
    const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
    const fileUrl = "file:///shared/uploads/notes%20for%20review.txt";
    native.sessionMessagesResponse = {
      data: [
        {
          info: {
            id: "user-files",
            sessionID: "session-1",
            role: "user",
            time: { created: 1778762475873 },
          },
          parts: [
            {
              id: "image",
              type: "file",
              messageID: "user-files",
              sessionID: "session-1",
              mime: "image/png",
              filename: "screen.png",
              url: imageUrl,
            },
            {
              id: "file",
              type: "file",
              messageID: "user-files",
              sessionID: "session-1",
              mime: "text/plain",
              filename: "notes for review.txt",
              url: fileUrl,
            },
          ],
        },
      ],
    };
    runtime.enqueueClient(native);
    const client = new OpenCodeAgentClient(
      createTestLogger(),
      { serverUrl: runtime.server.url },
      { serverManager: runtime, createClient: runtime.createClient },
    );
    const session = await client.resumeSession({
      provider: "opencode",
      sessionId: "session-1",
      metadata: { cwd: "/workspace/repo", openCodeServerUrl: runtime.server.url },
    });
    try {
      const history = [];
      for await (const event of session.streamHistory()) history.push(event);
      expect(history).toEqual([
        {
          type: "timeline",
          provider: "opencode",
          timestamp: "2026-05-14T12:41:15.873Z",
          item: {
            type: "user_message",
            messageId: "user-files",
            text: `\n[screen.png](${imageUrl})\nMIME: image/png\n\n[notes for review.txt](${fileUrl})\nMIME: text/plain\n`,
          },
        },
      ]);
      expect(native.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await session.close();
    }
    expect(native.calls.sessionAbort).toEqual([]);
  });

  test("sends inline image bytes and a usable shared file path to the SDK adapter", async () => {
    const native = new TestOpenCodeClient();
    const runtime = new TestOpenCodeHarness();
    runtime.enqueueClient(native);
    const client = new OpenCodeAgentClient(
      createTestLogger(),
      { serverUrl: runtime.server.url },
      { serverManager: runtime, createClient: runtime.createClient },
    );
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    try {
      await session.run([
        { type: "text", text: "Review these" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        {
          type: "uploaded_file",
          fileName: "notes for review.txt",
          path: "/shared/uploads/notes for review.txt",
          mimeType: "text/plain",
          size: 12,
        },
      ]);
      expect(native.calls.sessionPromptAsync).toMatchObject([
        {
          parts: [
            { type: "text", text: "Review these" },
            {
              type: "file",
              mime: "image/png",
              filename: "attachment-1.png",
              url: "data:image/png;base64,iVBORw0KGgo=",
            },
            {
              type: "text",
              text: "Uploaded file: notes for review.txt\nPath: /shared/uploads/notes for review.txt\nMIME: text/plain\nSize: 12 bytes",
            },
          ],
        },
      ]);
    } finally {
      await session.close();
    }
  });
});
