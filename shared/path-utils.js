const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeComponent(value, fallback = "untitled", maxLength = 120) {
  let clean = String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!clean || clean === "." || clean === "..") {
    clean = fallback;
  }
  if (WINDOWS_RESERVED.test(clean)) {
    clean = `_${clean}`;
  }
  if (clean.length > maxLength) {
    clean = clean.slice(0, maxLength).replace(/[. ]+$/g, "");
  }
  return clean || fallback;
}

export function sanitizeRoot(root) {
  const parts = String(root ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => sanitizeComponent(part, "downloads", 60));

  return parts.length ? parts.join("/") : "탭 다운로더 A";
}

export function buildDownloadFilename(root, type, title, filename, folder = "") {
  const safeRoot = sanitizeRoot(root);
  const safeType = sanitizeComponent(type, "site", 60);
  const rootParts = safeRoot.split("/");
  const lastRoot = rootParts.at(-1).toLowerCase();
  const normalizedType = safeType.toLowerCase();

  // 저장 폴더에 사이트 타입이 중복으로 붙지 않도록 한다.
  const alreadyTyped =
    lastRoot === normalizedType || lastRoot.endsWith(`_${normalizedType}`);

  const directory = [
    safeRoot,
    alreadyTyped ? null : safeType,
    sanitizeComponent(title, "untitled", 120),
    folder ? sanitizeComponent(folder, "folder", 120) : null,
  ].filter(Boolean);

  const rawFilename = String(filename ?? "image.jpg");
  const dot = rawFilename.lastIndexOf(".");
  const stem = dot > 0 ? rawFilename.slice(0, dot) : rawFilename;
  const extension = dot > 0 ? rawFilename.slice(dot).toLowerCase() : ".jpg";
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".jpg";
  const safeFilename = `${sanitizeComponent(stem, "image", 80)}${safeExtension}`;

  return [...directory, safeFilename].join("/");
}
