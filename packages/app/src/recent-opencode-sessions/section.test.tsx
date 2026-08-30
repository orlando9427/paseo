/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { RecentOpenCodeSession } from "./query";
import { RecentOpenCodeSessionsSection } from "./section";

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

function session(): RecentOpenCodeSession {
  return {
    serverId: "host-1",
    serverName: "Main host",
    entry: {
      providerId: "opencode",
      providerLabel: "OpenCode",
      providerHandleId: "session-1",
      cwd: "/work/project",
      title: "Fix the tests",
      firstPromptPreview: "Fix the tests",
      lastPromptPreview: "Run the focused test",
      lastActivityAt: "2026-08-30T10:00:00.000Z",
    },
  };
}

function openSessionNoop(): Promise<void> {
  return Promise.resolve();
}

function renderSection(input: {
  onOpen?: (value: RecentOpenCodeSession) => Promise<void>;
  errors?: Parameters<typeof RecentOpenCodeSessionsSection>[0]["errors"];
}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RecentOpenCodeSessionsSection
          sessions={[session()]}
          errors={input.errors ?? []}
          isLoading={false}
          showHost={false}
          onOpen={input.onOpen ?? openSessionNoop}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => cleanup());

describe("RecentOpenCodeSessionsSection", () => {
  it("marks the row busy while opening, then exposes failure and allows retry", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const onOpen = vi
      .fn<(value: RecentOpenCodeSession) => Promise<void>>()
      .mockImplementationOnce(() => firstAttempt)
      .mockResolvedValueOnce(undefined);
    renderSection({ onOpen });

    const row = screen.getByTestId("opencode-session-host-1-session-1");
    fireEvent.click(row);

    await screen.findByText("Opening...");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(row.style.opacity).toBe("0.5");

    await act(async () => {
      rejectFirst(new Error("open failed"));
      await Promise.resolve();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Unable to open this OpenCode session. Try again.");
    await waitFor(() => expect(row.getAttribute("aria-disabled")).not.toBe("true"));

    fireEvent.click(row);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
  });

  it("renders unsupported hosts as an update alert", () => {
    renderSection({
      errors: [{ serverId: "old", serverName: "Old host", reason: "unsupported" }],
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "Update Old host to show OpenCode sessions",
    );
  });
});
