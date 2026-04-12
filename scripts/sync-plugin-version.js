import { readFileSync, writeFileSync } from "node:fs";

const pkgVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;
const pluginPath = "plugins/claude-overnight/.claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(pluginPath, "utf-8"));

if (plugin.version !== pkgVersion) {
  plugin.version = pkgVersion;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`synced plugin.json version → ${pkgVersion}`);
}
