import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createVibeProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createVibeProvider());
  return () => {};
}
