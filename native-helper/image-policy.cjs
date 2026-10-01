"use strict";

const path = require("path");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);

function filenameExtension(filename, label) {
  const extension = path.extname(String(filename || "")).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`지원하지 않는 ${label} 이미지 확장자입니다.`);
  return extension;
}

function validateReferer(raw, { hostname, hostnamePattern, pathPattern, label }) {
  const url = new URL(raw);
  const hostAllowed = hostname ? url.hostname === hostname : hostnamePattern.test(url.hostname);
  if (url.protocol !== "https:" || !hostAllowed || !pathPattern.test(url.pathname) || url.hash) {
    throw new Error(`허용되지 않은 ${label} Referer입니다.`);
  }
  return url.href;
}

function validateTwitterReferer(raw) {
  return validateReferer(raw, {
    hostname: "x.com",
    pathPattern: /^\/[^/]+\/status\/\d+\/?$/i,
    label: "X",
  });
}

function validateTwitterImageUrl(raw, filename) {
  const url = new URL(raw);
  const extension = filenameExtension(filename, "X");
  const expectedFormat = extension === ".jpeg" ? "jpg" : extension.slice(1);
  if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/") ||
      url.searchParams.get("name") !== "orig" || url.searchParams.get("format") !== expectedFormat || url.hash) {
    throw new Error("허용되지 않은 X 원본 이미지 URL입니다.");
  }
  return { url: url.href, extension };
}

function validateInstagramImageUrl(raw, filename) {
  const url = new URL(raw);
  const extension = filenameExtension(filename, "Instagram");
  const hostAllowed = /(?:^|\.)cdninstagram\.com$/.test(url.hostname) || /^scontent[.-][a-z0-9.-]+\.fbcdn\.net$/.test(url.hostname);
  if (url.protocol !== "https:" || !hostAllowed || url.username || url.password || url.port || url.hash ||
      path.extname(url.pathname).toLowerCase() !== extension) {
    throw new Error("허용되지 않은 Instagram 이미지 URL입니다.");
  }
  return { url: url.href, extension };
}

function imagePolicy(type) {
  if (type === "instagram") {
    return { label: "Instagram", referer: "https://www.instagram.com/", validate: validateInstagramImageUrl, contentType: (value) => value.startsWith("image/") };
  }
  if (type === "twitter") {
    return {
      label: "X",
      validate: validateTwitterImageUrl,
      validateReferer: validateTwitterReferer,
      contentType: (value) => value.split(";", 1)[0].trim().startsWith("image/"),
    };
  }
  throw new Error("허용되지 않은 이미지 작업 타입입니다.");
}

function normalizedFilename(raw, index, extension) {
  const value = String(raw || "");
  if (/^\d{4}\.[a-z0-9]{2,5}$/i.test(value) && path.extname(value).toLowerCase() === extension) return value;
  return `${String(index + 1).padStart(4, "0")}${extension}`;
}

function normalizedFolder(raw) {
  if (raw == null || raw === "") return "";
  const value = String(raw).trim();
  if (!value || value.length > 150 || value === "." || value === ".." || /[\\/\u0000-\u001f]/.test(value)) {
    throw new Error("이미지 하위 폴더 이름이 올바르지 않습니다.");
  }
  return value;
}

function validateImageAssets(type, assets) {
  const policy = imagePolicy(type);
  if (!Array.isArray(assets) || !assets.length || assets.length > 5000) {
    throw new Error(`${policy.label} 이미지 수는 1~5000개만 허용됩니다.`);
  }
  return assets.map((asset, index) => {
    const referer = policy.referer
      ? asset.referer === policy.referer ? policy.referer : null
      : policy.validateReferer(asset.referer);
    if (!referer) throw new Error(`${policy.label} Referer가 올바르지 않습니다.`);
    const image = policy.validate(asset.url, asset.filename, referer);
    return {
      ...image,
      filename: normalizedFilename(asset.filename, index, image.extension),
      folder: normalizedFolder(asset.folder),
      referer,
    };
  });
}

module.exports = { imagePolicy, validateImageAssets };
