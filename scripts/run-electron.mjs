// Launches Electron for this project.
// Clears ELECTRON_RUN_AS_NODE, which some hosts (e.g. VS Code extension terminals)
// set and which would make Electron behave as plain Node.
import { spawn } from "node:child_process";
import electronPath from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
