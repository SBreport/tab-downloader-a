"use strict";

const path = require("path");

function folderOpenCommand(platform = process.platform, environment = process.env) {
  if (platform === "darwin") return "/usr/bin/open";
  if (platform === "win32") {
    return path.win32.join(environment.WINDIR || "C:\\Windows", "explorer.exe");
  }
  return "xdg-open";
}

function folderOpenSpawnOptions() {
  return {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  };
}

module.exports = { folderOpenCommand, folderOpenSpawnOptions };
