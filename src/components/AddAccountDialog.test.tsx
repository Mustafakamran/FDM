import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { AddAccountDialog } from "./AddAccountDialog";
import { useApp } from "../store/app";

beforeEach(() => {
  invokeMock.mockReset();
  useApp.setState({ accounts: [], openTabs: [], view: { kind: "accounts" }, accountsLoaded: true });
});

describe("AddAccountDialog", () => {
  it("blocks and prompts for credentials when none are stored", async () => {
    // get_secret -> null for both id + secret
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_secret") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    render(<AddAccountDialog provider="drive" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Client A"), { target: { value: "Client A" } });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(screen.queryByText(/Set your Google Drive API credentials/i)).not.toBeNull();
    });
    expect(invokeMock).not.toHaveBeenCalledWith("add_account", expect.anything());
  });

  it("calls add_account with the right args when credentials exist", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_secret") {
        return Promise.resolve(args?.key === "google_client_id" ? "CID" : "CSECRET");
      }
      if (cmd === "add_account") {
        return Promise.resolve({ id: "drive_client_a", provider: "drive", label: "client_a" });
      }
      if (cmd === "list_accounts") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(<AddAccountDialog provider="drive" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Client A"), { target: { value: "Client A" } });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("add_account", {
        provider: "drive",
        label: "Client A",
        clientId: "CID",
        clientSecret: "CSECRET",
      });
    });
  });
});
