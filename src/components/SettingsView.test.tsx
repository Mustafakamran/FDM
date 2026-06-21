import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { SettingsView } from "./SettingsView";

beforeEach(() => {
  invokeMock.mockReset();
  // get_secret returns null on mount so fields start empty.
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "get_secret" ? Promise.resolve(null) : Promise.resolve(undefined),
  );
});

describe("SettingsView", () => {
  it("saves Google credentials to the keychain under the right keys", async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByText("Google Drive")); // credentials live in their tab
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "my-id" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "my-secret" } });
    fireEvent.click(screen.getByText("Save Google credentials"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_secret", { key: "google_client_id", value: "my-id" });
      expect(invokeMock).toHaveBeenCalledWith("set_secret", { key: "google_client_secret", value: "my-secret" });
    });
  });
});
