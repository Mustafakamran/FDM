import { describe, it, expect, beforeEach } from "vitest";
import { useNotifications, unreadCount, type FolderNotification } from "./notifications";

function notif(id: string): FolderNotification {
  return {
    id,
    accountId: "drive_x",
    provider: "drive",
    accountLabel: "Client A",
    folderName: "October Shoot",
    path: "October Shoot",
    modTime: "2026-06-19T00:00:00Z",
    size: null,
    uploader: null,
    at: 1,
    read: false,
  };
}

beforeEach(() => useNotifications.setState({ items: [], panelOpen: false }));

describe("notifications store", () => {
  it("adds items, dedupes by id, and tracks unread", () => {
    const s = useNotifications.getState();
    s.add(notif("a"));
    s.add(notif("a")); // duplicate id ignored
    s.add(notif("b"));
    const items = useNotifications.getState().items;
    expect(items).toHaveLength(2);
    expect(unreadCount(items)).toBe(2);
  });

  it("marks all read when the panel opens", () => {
    const s = useNotifications.getState();
    s.add(notif("a"));
    s.togglePanel(true);
    expect(unreadCount(useNotifications.getState().items)).toBe(0);
  });

  it("enriches an item via update", () => {
    const s = useNotifications.getState();
    s.add(notif("a"));
    s.update("a", { size: 5000, uploader: "Alex" });
    const it = useNotifications.getState().items[0];
    expect(it.size).toBe(5000);
    expect(it.uploader).toBe("Alex");
  });
});
