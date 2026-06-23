import { describe, it, expect } from "vitest";
import { categoryFor, CATEGORIES, type Category } from "./categories";

describe("categoryFor", () => {
  const cases: [string, Category][] = [
    // Video
    ["movie.mp4", "Video"],
    ["clip.MOV", "Video"],
    ["show.mkv", "Video"],
    ["stream.webm", "Video"],
    ["old.avi", "Video"],
    ["phone.m4v", "Video"],
    // Audio
    ["song.mp3", "Audio"],
    ["voice.m4a", "Audio"],
    ["take.wav", "Audio"],
    ["master.flac", "Audio"],
    ["sound.aac", "Audio"],
    ["podcast.ogg", "Audio"],
    // Document
    ["report.pdf", "Document"],
    ["letter.doc", "Document"],
    ["letter.docx", "Document"],
    ["data.xls", "Document"],
    ["data.xlsx", "Document"],
    ["deck.ppt", "Document"],
    ["deck.pptx", "Document"],
    ["notes.txt", "Document"],
    ["rows.csv", "Document"],
    // Application / installers
    ["setup.exe", "Application"],
    ["app.dmg", "Application"],
    ["installer.msi", "Application"],
    ["bundle.pkg", "Application"],
    ["Mail.app", "Application"],
    ["pkg.deb", "Application"],
    ["mobile.apk", "Application"],
    // Image
    ["photo.jpg", "Image"],
    ["photo.jpeg", "Image"],
    ["icon.png", "Image"],
    ["anim.gif", "Image"],
    ["pic.webp", "Image"],
    ["iphone.heic", "Image"],
    ["logo.svg", "Image"],
    ["art.psd", "Image"],
    ["vector.ai", "Image"],
    ["sensor.raw", "Image"],
    ["canon.cr2", "Image"],
    ["sony.arw", "Image"],
    // Archive
    ["bundle.zip", "Archive"],
    ["packed.rar", "Archive"],
    ["packed.7z", "Archive"],
    ["backup.tar", "Archive"],
    ["log.gz", "Archive"],
    ["disk.iso", "Archive"],
  ];

  it.each(cases)("classifies %s as %s", (name, expected) => {
    expect(categoryFor(name)).toBe(expected);
  });

  it("is case-insensitive on the extension", () => {
    expect(categoryFor("CLIP.MP4")).toBe("Video");
    expect(categoryFor("Photo.JPEG")).toBe("Image");
  });

  it("falls back to Other for unknown or extensionless names", () => {
    expect(categoryFor("README")).toBe("Other");
    expect(categoryFor("file.unknownext")).toBe("Other");
    expect(categoryFor("archive")).toBe("Other");
    expect(categoryFor("")).toBe("Other");
  });

  it("treats a leading-dot dotfile as having no extension", () => {
    expect(categoryFor(".env")).toBe("Other");
    expect(categoryFor(".gitignore")).toBe("Other");
  });

  it("uses the LAST extension and tolerates query/hash and paths", () => {
    expect(categoryFor("archive.tar.gz")).toBe("Archive");
    expect(categoryFor("video.mp4?token=abc")).toBe("Video");
    expect(categoryFor("song.mp3#t=10")).toBe("Audio");
    expect(categoryFor("/some/dir/report.pdf")).toBe("Document");
    expect(categoryFor("C:\\Users\\me\\photo.png")).toBe("Image");
  });

  it("exports every produced category in CATEGORIES (incl. Other)", () => {
    const produced = new Set(cases.map(([, c]) => c));
    produced.add("Other");
    for (const c of produced) expect(CATEGORIES).toContain(c);
    expect(CATEGORIES).toContain("Other");
  });
});
