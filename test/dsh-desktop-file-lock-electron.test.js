"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { DSH_CMD_TEMPLATE } = require("./dsh-desktop-fixtures");

const discoveryFixture = path.join(__dirname, "fixtures", "dsh-desktop-discovery.js");

test("Windows desktop discovery leaves the ASAR replaceable while Node and Electron stay alive", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async (t) => {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "clawd-dsh-file-lock-"));
  t.after(() => {
    assert.equal(path.dirname(root), tempRoot);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const appRoot = path.join(root, "DeepSeek Harness");
  const binDir = path.join(appRoot, "resources", "runtime", "cli", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "DeepSeek Harness.exe"), "exe");
  fs.writeFileSync(path.join(binDir, "dsh.cmd"), `${DSH_CMD_TEMPLATE.join("\r\n")}\r\n`);
  const sourceDir = path.join(root, "source");
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, "package.json"), '{"name":"dsh-lock-test"}');
  const sourceArchive = path.join(root, "source.asar");
  await require("@electron/asar").createPackage(sourceDir, sourceArchive);
  const archive = path.join(appRoot, "resources", "app.asar");

  // "injected" is the detector's shape: fs: require("fs"). Under Electron that
  // is the patched fs, so the probe must still reach the physical filesystem.
  // Electron runs as a real main process, never --run-as-node: the patched fs
  // that retains the archive handle is the one it installs in that mode.
  const childEnv = {
    ...process.env,
    CLAWD_DSH_INSTALLER: path.resolve(__dirname, "../hooks/dsh-install.js"),
    CLAWD_DSH_APP_ROOT: appRoot,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const triggerFile = path.join(root, "recheck");
  const recheck = () => fs.writeFileSync(triggerFile, String(Date.now()));
  for (const [name, executable, injectDefaultFs] of [
    ["Node (default fs)", process.execPath, false],
    ["Node (injected fs)", process.execPath, true],
    ["Electron main (default fs)", require("electron"), false],
    ["Electron main (injected fs)", require("electron"), true],
  ]) {
    await t.test(name, async (t) => {
      fs.copyFileSync(sourceArchive, archive);
      const child = spawn(executable, [
        discoveryFixture,
        `--user-data-dir=${path.join(root, "electron-user-data")}`,
      ], {
        env: {
          ...childEnv,
          CLAWD_DSH_RECHECK_FILE: triggerFile,
          ...(injectDefaultFs ? { CLAWD_DSH_INJECT_DEFAULT_FS: "1" } : {}),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise((resolve) => {
        child.once("exit", resolve);
        child.once("error", resolve);
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      const lines = createInterface({ input: child.stdout });
      t.after(async () => {
        child.kill();
        await exited;
        lines.close();
      });
      const nextStatus = async () => {
        for (;;) {
          const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
          assert.equal(child.exitCode, null, stderr);
          assert.equal(child.signalCode, null, stderr);
          // A real Electron main process opens with a blank stdout line.
          if (line.trim()) return line.trim();
        }
      };
      assert.equal(await nextStatus(), "found", stderr);

      const previous = `${archive}.previous`;
      fs.renameSync(archive, previous);
      fs.copyFileSync(sourceArchive, archive);
      fs.unlinkSync(previous);
      const rediscovered = nextStatus();
      recheck();
      assert.equal(await rediscovered, "found", stderr);

      fs.unlinkSync(archive);
      const missing = nextStatus();
      recheck();
      assert.equal(await missing, "not-found", stderr);
    });
  }
});
