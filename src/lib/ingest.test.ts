import { describe, it, expect, vi } from "vitest";

// downloadDir is only exercised in resolveDest; stub it so the module imports
// cleanly under vitest (no Tauri runtime).
vi.mock("@tauri-apps/api/path", () => ({ downloadDir: () => Promise.resolve("/Downloads") }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
// The native save dialog has no Tauri runtime under vitest; default it to a no-op
// (each test that needs it injects its own `saveDialog` dep, so this just lets the
// module import).
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: () => Promise.resolve(null) }));

import {
  accountIdForKind,
  itemForUrl,
  ingest,
  headersForPayload,
  suggestedName,
  splitSavePath,
  YTDLP_ACCOUNT_ID,
  type IngestPayload,
} from "./ingest";
import { HTTP_ACCOUNT_ID } from "../store/transfers";

/** Default deps: no prompt (ask-where off) + a stub dialog, so the default-folder
 *  path is taken unless a test overrides them. */
const noPrompt = { askWhereToSave: () => false, saveDialog: () => Promise.resolve(null) };

describe("accountIdForKind", () => {
  it("maps media -> yt-dlp", () => {
    expect(accountIdForKind("media")).toBe(YTDLP_ACCOUNT_ID);
    expect(accountIdForKind("media")).toBe("ytdlp");
  });
  it("maps file -> http", () => {
    expect(accountIdForKind("file")).toBe(HTTP_ACCOUNT_ID);
    expect(accountIdForKind("file")).toBe("http");
  });
});

describe("itemForUrl", () => {
  it("derives a filename from the URL path", () => {
    const it1 = itemForUrl("https://example.com/path/clip.mp4?token=abc");
    expect(it1.name).toBe("clip.mp4");
    expect(it1.path).toBe("");
    expect(it1.isDir).toBe(false);
    expect(it1.size).toBe(0);
    expect(it1.id).toBe("https://example.com/path/clip.mp4?token=abc");
    expect(it1.headers).toBeUndefined();
  });
  it("falls back to 'download' for path-less URLs", () => {
    expect(itemForUrl("https://example.com").name).toBe("download");
  });
  it("uses an explicit name and attaches headers when given", () => {
    const it1 = itemForUrl("https://h/x", "real.zip", { Referer: "https://h" });
    expect(it1.name).toBe("real.zip");
    expect(it1.headers).toEqual({ Referer: "https://h" });
  });
});

describe("headersForPayload", () => {
  it("emits only the present headers", () => {
    expect(
      headersForPayload({ url: "u", kind: "file", referrer: "https://r", ua: "UA/1" }),
    ).toEqual({ Referer: "https://r", "User-Agent": "UA/1" });
  });
  it("maps all three when present", () => {
    expect(
      headersForPayload({ url: "u", kind: "file", referrer: "r", cookie: "c=1", ua: "UA" }),
    ).toEqual({ Referer: "r", Cookie: "c=1", "User-Agent": "UA" });
  });
  it("returns undefined when none are present", () => {
    expect(headersForPayload({ url: "u", kind: "file" })).toBeUndefined();
  });
});

describe("suggestedName", () => {
  it("prefers the explicit filename", () => {
    expect(suggestedName({ url: "https://h/a/derived.bin", kind: "file", filename: "Nice Name.zip" })).toBe(
      "Nice Name.zip",
    );
  });
  it("falls back to the URL-derived name", () => {
    expect(suggestedName({ url: "https://h/a/derived.bin", kind: "file" })).toBe("derived.bin");
  });
});

describe("splitSavePath", () => {
  it("splits a POSIX path", () => {
    expect(splitSavePath("/Users/me/Downloads/file.zip")).toEqual({
      dir: "/Users/me/Downloads",
      name: "file.zip",
    });
  });
  it("splits a Windows path", () => {
    expect(splitSavePath("C:\\Users\\me\\Downloads\\file.zip")).toEqual({
      dir: "C:\\Users\\me\\Downloads",
      name: "file.zip",
    });
  });
  it("treats a bare name as name-only", () => {
    expect(splitSavePath("file.zip")).toEqual({ dir: "", name: "file.zip" });
  });
});

describe("ingest", () => {
  it("enqueues media on the ytdlp account and toasts the name", async () => {
    const enqueue = vi.fn();
    const pushToast = vi.fn();
    const payload: IngestPayload = { url: "https://youtu.be/abc/video.mp4", kind: "media" };
    await ingest(payload, { enqueue, pushToast, dest: () => Promise.resolve("/dest"), ...noPrompt });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [accountId, items, dest] = enqueue.mock.calls[0];
    expect(accountId).toBe("ytdlp");
    expect(items[0].name).toBe("video.mp4");
    expect(dest).toBe("/dest");
    expect(pushToast).toHaveBeenCalledWith("Added from browser: video.mp4");
  });

  it("enqueues file kinds on the http account", async () => {
    const enqueue = vi.fn();
    await ingest(
      { url: "https://host/a/file.zip", kind: "file" },
      { enqueue, pushToast: vi.fn(), dest: () => Promise.resolve("/d"), ...noPrompt },
    );
    expect(enqueue.mock.calls[0][0]).toBe("http");
  });

  it("ignores blank URLs", async () => {
    const enqueue = vi.fn();
    await ingest({ url: "   ", kind: "file" }, { enqueue, pushToast: vi.fn(), ...noPrompt });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("threads referrer/cookie/ua onto item.headers", async () => {
    const enqueue = vi.fn();
    await ingest(
      {
        url: "https://mediafire.com/a/file.bin",
        kind: "file",
        referrer: "https://mediafire.com/page",
        cookie: "sess=xyz",
        ua: "Mozilla/5.0",
      },
      { enqueue, pushToast: vi.fn(), dest: () => Promise.resolve("/d"), ...noPrompt },
    );
    const item = enqueue.mock.calls[0][1][0];
    expect(item.headers).toEqual({
      Referer: "https://mediafire.com/page",
      Cookie: "sess=xyz",
      "User-Agent": "Mozilla/5.0",
    });
  });

  it("uses the suggested filename for the default-folder name", async () => {
    const enqueue = vi.fn();
    await ingest(
      { url: "https://h/a/ugly%20id", kind: "file", filename: "Report.pdf" },
      { enqueue, pushToast: vi.fn(), dest: () => Promise.resolve("/Downloads"), ...noPrompt },
    );
    const [, items, dest] = enqueue.mock.calls[0];
    expect(items[0].name).toBe("Report.pdf");
    expect(dest).toBe("/Downloads");
  });

  it("prompts (save dialog) when askWhereToSave is on; uses chosen folder + name", async () => {
    const enqueue = vi.fn();
    const saveDialog = vi.fn().mockResolvedValue("/Users/me/Movies/picked.mp4");
    await ingest(
      { url: "https://h/clip.mp4", kind: "media", filename: "clip.mp4" },
      {
        enqueue,
        pushToast: vi.fn(),
        dest: () => Promise.resolve("/Downloads"),
        askWhereToSave: () => true,
        saveDialog,
      },
    );
    // dialog seeded with <defaultFolder>/<suggested filename>
    expect(saveDialog).toHaveBeenCalledWith({ defaultPath: "/Downloads/clip.mp4" });
    const [, items, dest] = enqueue.mock.calls[0];
    expect(dest).toBe("/Users/me/Movies");
    expect(items[0].name).toBe("picked.mp4");
  });

  it("prompts when payload.prompt is true even if the setting is off", async () => {
    const enqueue = vi.fn();
    const saveDialog = vi.fn().mockResolvedValue("/d/x.bin");
    await ingest(
      { url: "https://h/x.bin", kind: "file", prompt: true },
      { enqueue, pushToast: vi.fn(), dest: () => Promise.resolve("/Downloads"), askWhereToSave: () => false, saveDialog },
    );
    expect(saveDialog).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("aborts (no download) when the user cancels the save dialog", async () => {
    const enqueue = vi.fn();
    const pushToast = vi.fn();
    const saveDialog = vi.fn().mockResolvedValue(null);
    await ingest(
      { url: "https://h/x.bin", kind: "file" },
      { enqueue, pushToast, dest: () => Promise.resolve("/Downloads"), askWhereToSave: () => true, saveDialog },
    );
    expect(saveDialog).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
  });
});
