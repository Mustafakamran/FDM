import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { AccountsView } from "./AccountsView";
import { useApp } from "../store/app";
import type { Account } from "../lib/tauri/commands";

const drive: Account = { id: "drive_client_a", provider: "drive", label: "client_a" };

function resetStore(accounts: Account[]) {
  useApp.setState({ accounts, openTabs: [], view: { kind: "accounts" }, accountsLoaded: true });
}

describe("AccountsView", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore([]);
  });

  it("shows the empty state when no accounts", () => {
    render(<AccountsView />);
    expect(screen.queryByText("No accounts connected")).not.toBeNull();
  });

  it("renders account cards from the store", () => {
    resetStore([drive]);
    render(<AccountsView />);
    expect(screen.queryByText("client_a")).not.toBeNull();
    expect(screen.queryByText("Google Drive")).not.toBeNull();
  });

  it("removes an account after confirmation", async () => {
    resetStore([drive]);
    invokeMock.mockResolvedValue([]); // remove_account + subsequent list_accounts
    render(<AccountsView />);

    fireEvent.click(screen.getByLabelText("Remove client_a"));
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("remove_account", { id: "drive_client_a" });
    });
  });
});
