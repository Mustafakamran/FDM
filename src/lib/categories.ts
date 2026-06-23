/**
 * File-category classification by extension.
 *
 * A pure, dependency-free counterpart to `file-types.ts` (which resolves a
 * colored icon). Here we bucket a filename into one of a small, fixed set of
 * human categories used by the GENERAL DOWNLOADS view's filter tabs and the
 * per-download detail panel.
 *
 * Unknown / extensionless names fall back to "Other".
 */

export type Category =
  | "Video"
  | "Audio"
  | "Document"
  | "Application"
  | "Image"
  | "Archive"
  | "Other";

/** Ordered category list (without the implicit "Other" bucket last). Exported
 * so the UI can build filter tabs without hard-coding the strings. */
export const CATEGORIES: Category[] = [
  "Video",
  "Audio",
  "Document",
  "Application",
  "Image",
  "Archive",
  "Other",
];

/** Extension (no dot, lowercase) → category. */
const BY_EXT: Record<string, Category> = {
  // Video
  mp4: "Video", mov: "Video", mkv: "Video", webm: "Video", avi: "Video", m4v: "Video",
  mts: "Video", mpg: "Video", mpeg: "Video", wmv: "Video", flv: "Video", "3gp": "Video",
  mxf: "Video", braw: "Video", r3d: "Video", ts: "Video", ogv: "Video",
  // Audio
  mp3: "Audio", m4a: "Audio", wav: "Audio", flac: "Audio", aac: "Audio", ogg: "Audio",
  oga: "Audio", aiff: "Audio", aif: "Audio", wma: "Audio", opus: "Audio", mid: "Audio",
  // Document
  pdf: "Document", doc: "Document", docx: "Document", xls: "Document", xlsx: "Document",
  ppt: "Document", pptx: "Document", txt: "Document", csv: "Document", rtf: "Document",
  odt: "Document", ods: "Document", odp: "Document", pages: "Document", numbers: "Document",
  key: "Document", md: "Document", epub: "Document", tsv: "Document",
  // Application / installers
  exe: "Application", dmg: "Application", msi: "Application", pkg: "Application", app: "Application",
  deb: "Application", apk: "Application", rpm: "Application", appimage: "Application", bin: "Application",
  jar: "Application", bat: "Application", sh: "Application",
  // Image
  jpg: "Image", jpeg: "Image", png: "Image", gif: "Image", webp: "Image", heic: "Image",
  heif: "Image", svg: "Image", psd: "Image", ai: "Image", raw: "Image", cr2: "Image",
  arw: "Image", nef: "Image", dng: "Image", tiff: "Image", tif: "Image", bmp: "Image",
  ico: "Image", avif: "Image",
  // Archive
  zip: "Archive", rar: "Archive", "7z": "Archive", tar: "Archive", gz: "Archive", iso: "Archive",
  bz2: "Archive", xz: "Archive", tgz: "Archive", zst: "Archive", cab: "Archive",
};

/** Lowercase extension (without the dot) of a filename, or "" if none. */
function extOf(filename: string): string {
  const base = filename.split(/[?#]/)[0]; // tolerate URL-ish names
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  const name = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or dotfile like ".env"
  return name.slice(dot + 1).toLowerCase();
}

/** Classify a filename into a {@link Category}. Pure; no dependencies. */
export function categoryFor(filename: string): Category {
  return BY_EXT[extOf(filename)] ?? "Other";
}
