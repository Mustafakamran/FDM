import {
  Folder,
  FileText,
  FileSpreadsheet,
  Presentation,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  File as FileIcon,
  type LucideIcon,
} from "lucide-react";

export interface FileType {
  Icon: LucideIcon;
  color: string;
  label: string;
}

const VIDEO = { Icon: FileVideo, color: "#7c93ff", label: "Video" };
const IMAGE = { Icon: FileImage, color: "#b07bdc", label: "Image" };
const AUDIO = { Icon: FileAudio, color: "#d98ad6", label: "Audio" };
const SHEET = { Icon: FileSpreadsheet, color: "#3fa463", label: "Spreadsheet" };
const SLIDES = { Icon: Presentation, color: "#e8893c", label: "Slides" };
const PDF = { Icon: FileText, color: "#f15b50", label: "PDF" };
const DOC = { Icon: FileText, color: "#4a8cff", label: "Document" };
const ARCHIVE = { Icon: FileArchive, color: "#aeb4bd", label: "Archive" };

const BY_EXT: Record<string, FileType> = {
  mxf: VIDEO, mov: VIDEO, mp4: VIDEO, avi: VIDEO, braw: VIDEO, r3d: VIDEO, mkv: VIDEO, m4v: VIDEO, mts: VIDEO,
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE, bmp: IMAGE, svg: IMAGE, heic: IMAGE, heif: IMAGE,
  tiff: IMAGE, dng: IMAGE, cr2: IMAGE, cr3: IMAGE, arw: IMAGE, nef: IMAGE, raf: IMAGE, orf: IMAGE, rw2: IMAGE,
  wav: AUDIO, mp3: AUDIO, aac: AUDIO, aiff: AUDIO, flac: AUDIO,
  xlsx: SHEET, xls: SHEET, csv: SHEET, numbers: SHEET,
  pptx: SLIDES, ppt: SLIDES, key: SLIDES,
  pdf: PDF,
  doc: DOC, docx: DOC, txt: DOC, rtf: DOC, pages: DOC,
  zip: ARCHIVE, rar: ARCHIVE, "7z": ARCHIVE, tar: ARCHIVE, gz: ARCHIVE,
};

/** Resolve a colored icon + a human Type label for an entry. */
export function fileType(name: string, isDir: boolean): FileType {
  if (isDir) return { Icon: Folder, color: "var(--accent)", label: "Folder" };
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return BY_EXT[ext] ?? { Icon: FileIcon, color: "var(--text-3)", label: ext ? ext.toUpperCase() : "File" };
}
