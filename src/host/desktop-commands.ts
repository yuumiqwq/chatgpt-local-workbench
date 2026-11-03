import { z } from "zod";

const text = z.string().max(8192).refine(value => !value.includes("\0"), "NUL is not supported");
const name = text.pipe(z.string().min(1).max(512));
const ref = z.string().regex(/^@s[a-zA-Z0-9_-]{1,96}:e[0-9]+$/u)
  .describe("Exact fully-qualified ref from this namespace's snapshot, such as @s8f3k2p9:e8; bare @e8 is invalid.");
const namespace = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u)
  .describe("Choose a unique task namespace and reuse it for observations and actions. Ref lookup never crosses namespaces.");
const scope = { app: name.optional(), window_id: name.optional() };
const surface = z.enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert", "desktop",
  "taskbar", "system-tray", "quick-settings", "notification-center", "toolbar", "dock", "spotlight",
  "menu-bar-extras", "system-tray-overflow", "start-menu", "action-center"]);
const budget = z.number().int().min(100).max(40_000).default(10_000);
const coordinate = z.number().int().min(-100_000).max(100_000);
const headed = z.boolean().default(false).describe("Explicit user-authorized foreground/physical delivery only; also requires host policy. Never enable as an automatic fallback.");
const ns = { namespace };
const target = { ...ns, ref };
const observe = { ...ns, ...scope, root: ref.optional(), surface: surface.default("window"), timeout_ms: budget };

export const desktopSchemas = {
  desktop_status: z.object({ command: z.enum(["status", "version", "permissions"]).default("status") }).strict(),
  desktop_list: z.object({ command: z.enum(["list-apps", "list-windows", "list-displays", "list-surfaces"]), app: name.optional() }).strict(),
  desktop_snapshot: z.object({ ...observe, max_depth: z.number().int().min(1).max(50).default(10),
    interactive_only: z.boolean().default(true), compact: z.boolean().default(true),
    skeleton: z.boolean().default(false), include_bounds: z.boolean().default(false) }).strict(),
  desktop_find: z.object({ ...observe, role: name.optional(), name: name.optional(), text: name.optional(),
    value: text.optional(), description: name.optional(), native_id: name.optional(), exact: z.boolean().default(false),
    state: z.array(z.string().regex(/^(visible|enabled|checked|focused|expanded|selected|offscreen)(=(true|false))?$/u)).max(12).default([]),
    limit: z.number().int().min(1).max(200).default(50) }).strict(),
  desktop_read: z.discriminatedUnion("command", [
    z.object({ command: z.literal("get"), ...target, property: z.enum(["text", "value", "title", "bounds", "role", "states"]).default("text") }).strict(),
    z.object({ command: z.literal("is"), ...target, property: z.enum(["visible", "enabled", "checked", "focused", "expanded", "selected"]).default("visible") }).strict()
  ]),
  desktop_act: z.discriminatedUnion("command", [
    z.object({ command: z.enum(["click", "right-click", "double-click", "triple-click", "clear", "focus", "toggle", "check", "uncheck", "expand", "collapse", "scroll-to"]), ...target, headed, timeout_ms: budget }).strict(),
    z.object({ command: z.enum(["type", "set-value", "select"]), ...target, text, headed, timeout_ms: budget }).strict(),
    z.object({ command: z.literal("scroll"), ...target, direction: z.enum(["up", "down", "left", "right"]).default("down"),
      amount: z.number().int().min(1).max(100).default(3), headed, timeout_ms: budget }).strict()
  ]),
  desktop_window: z.discriminatedUnion("command", [
    z.object({ command: z.literal("launch"), app_key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u), timeout_ms: budget }).strict(),
    z.object({ command: z.literal("close-app"), app: name }).strict(),
    z.object({ command: z.enum(["focus-window", "minimize", "maximize", "restore"]), window_id: name, headed }).strict(),
    z.object({ command: z.literal("resize-window"), window_id: name, width: z.number().int().min(1).max(32768), height: z.number().int().min(1).max(32768), headed }).strict(),
    z.object({ command: z.literal("move-window"), window_id: name, x: coordinate, y: coordinate, headed }).strict(),
    z.object({ command: z.literal("open-system-surface"), surface, headed: z.literal(true) }).strict()
  ]),
  desktop_clipboard: z.discriminatedUnion("command", [
    z.object({ command: z.literal("clipboard-get") }).strict(),
    z.object({ command: z.literal("clipboard-set"), text }).strict(),
    z.object({ command: z.literal("clipboard-clear") }).strict()
  ]),
  desktop_screenshot: z.object({ window_id: name }).strict(),
  desktop_wait: z.discriminatedUnion("condition", [
    z.object({ condition: z.literal("element"), ...target, predicate: z.enum(["exists", "enabled", "visible", "actionable", "value"]).default("exists"), value: text.optional(), timeout_ms: budget }).strict(),
    z.object({ condition: z.literal("text"), ...ns, app: name, text: name, timeout_ms: budget }).strict(),
    z.object({ condition: z.literal("window"), app: name, title: name, timeout_ms: budget }).strict(),
    z.object({ condition: z.enum(["menu", "menu-closed"]), ...ns, app: name, timeout_ms: budget }).strict(),
    z.object({ condition: z.literal("event"), event: z.enum(["window-opened", "window-closed", "app-launched", "app-terminated", "focus-changed", "surface-appeared", "surface-dismissed"]), app: name, timeout_ms: budget }).strict()
  ]),
  desktop_input: z.discriminatedUnion("command", [
    z.object({ command: z.literal("press"), window_id: name, combo: z.string().regex(/^(?:(?:ctrl|alt|shift|cmd|meta|win)\+){0,4}(?:[a-z0-9]|f(?:[1-9]|1[0-2])|return|enter|escape|tab|space|delete|backspace|up|down|left|right|home|end|pageup|pagedown)$/u), headed: z.literal(true) }).strict(),
    z.object({ command: z.literal("mouse-click"), x: coordinate, y: coordinate, button: z.enum(["left", "right", "middle"]).default("left"), count: z.number().int().min(1).max(3).default(1), headed: z.literal(true) }).strict(),
    z.object({ command: z.literal("mouse-move"), x: coordinate, y: coordinate, headed: z.literal(true) }).strict(),
    z.object({ command: z.literal("mouse-wheel"), x: coordinate, y: coordinate, dx: z.number().int().min(-100).max(100).default(0), dy: z.number().int().min(-100).max(100).default(-3), headed: z.literal(true) }).strict(),
    z.object({ command: z.literal("drag"), ...ns, from: ref, to: ref, duration_ms: z.number().int().min(100).max(5000).default(500), headed: z.literal(true) }).strict()
  ])
};

export type DesktopTool = keyof typeof desktopSchemas;

// Requests are flat typed records. Bound them before Zod traverses a supplied
// collection, not just after validation in the CLI adapter.
export function desktopRequestWithinLimit(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  let fields = 0;
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue;
    if (++fields > 32 || key.length > 64) return false;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") { if (value.length > 8192) return false; }
    else if (Array.isArray(value)) {
      if (value.length > 12 || value.some(item => typeof item !== "string" || item.length > 128)) return false;
    } else if (value !== undefined && typeof value !== "boolean" && typeof value !== "number") return false;
  }
  return Buffer.byteLength(JSON.stringify(input), "utf8") <= 16_384;
}
export interface DesktopCommand {
  command: string; args: string[]; timeoutMs: number; mutation: boolean;
  headed: boolean; physical: boolean; namespace?: string; launchKey?: string;
}

export function buildDesktopCommand(tool: DesktopTool, input: unknown): DesktopCommand {
  // Parse again here so internal callers have the same strict boundary as MCP.
  const parsed = desktopSchemas[tool].parse(input);
  const p = parsed as Record<string, unknown>;
  const command = typeof p.command === "string" ? p.command : tool.slice("desktop_".length);
  const result: DesktopCommand = { command, args: [], timeoutMs: 15_000,
    mutation: ["desktop_act", "desktop_window", "desktop_input"].includes(tool) ||
      tool === "desktop_clipboard" && command !== "clipboard-get",
    headed: p.headed === true, physical: tool === "desktop_input" ||
      ["double-click", "triple-click"].includes(command) ||
      process.platform === "win32" && ["type", "right-click"].includes(command) };
  const flag = (key: string, cli = key.replaceAll("_", "-")) => {
    const value = p[key];
    if (value === true) result.args.push(`--${cli}`);
    else if (value !== undefined && value !== false) result.args.push(`--${cli}=${String(value)}`);
  };
  const positional = (...values: string[]) => result.args.push("--", ...values);
  if (p.namespace !== undefined) result.namespace = `wb-${String(p.namespace)}`;
  if (typeof p.timeout_ms === "number") result.timeoutMs = p.timeout_ms + 3000;
  if (tool === "desktop_list") {
    if (command === "list-displays" && p.app !== undefined) throw new Error("Invalid app filter");
    flag("app");
  } else if (tool === "desktop_snapshot" || tool === "desktop_find") {
    if (!p.app && !p.window_id && !p.root) throw new Error("An explicit app, window_id or root is required");
    for (const key of ["app", "window_id", "root", "surface", "timeout_ms"]) flag(key);
    if (tool === "desktop_snapshot") {
      if (p.skeleton && p.surface !== "window") throw new Error("Skeleton is for window snapshots");
      for (const key of ["max_depth", "interactive_only", "compact", "skeleton", "include_bounds"]) flag(key);
    } else {
      if (!["role", "name", "text", "value", "description", "native_id"].some(key => p[key] !== undefined) && !(p.state as string[]).length) throw new Error("A search filter is required");
      for (const key of ["role", "name", "text", "value", "description", "native_id", "exact", "limit"]) flag(key);
      for (const state of p.state as string[]) result.args.push(`--state=${state}`);
    }
  } else if (tool === "desktop_read") {
    flag("property"); positional(String(p.ref));
  } else if (tool === "desktop_act") {
    for (const key of ["timeout_ms", "direction", "amount"]) flag(key);
    positional(String(p.ref), ...(typeof p.text === "string" ? [p.text] : []));
  } else if (tool === "desktop_window") {
    if (command === "launch") { result.launchKey = String(p.app_key); flag("timeout_ms", "timeout"); }
    else if (command === "close-app") positional(String(p.app));
    else for (const key of ["window_id", "width", "height", "x", "y", "surface"]) flag(key);
  } else if (tool === "desktop_clipboard") {
    if (command === "clipboard-get") result.args.push("--format=text");
    if (command === "clipboard-set") positional(String(p.text));
  } else if (tool === "desktop_screenshot") {
    flag("window_id"); result.timeoutMs = 30_000;
  } else if (tool === "desktop_wait") {
    flag("timeout_ms", "timeout"); flag("app");
    if (p.condition === "element") {
      if (p.predicate === "value" && p.value === undefined || p.predicate !== "value" && p.value !== undefined) throw new Error("Value requires the value predicate");
      flag("ref", "element"); flag("predicate"); flag("value");
    } else if (p.condition === "window") flag("title", "window");
    else if (p.condition === "text") flag("text");
    else if (p.condition === "event") flag("event");
    else result.args.push(`--${String(p.condition)}`);
  } else if (tool === "desktop_input") {
    if (command === "press") { flag("window_id"); positional(String(p.combo)); }
    else if (command === "drag") {
      flag("from"); flag("to"); flag("duration_ms", "duration"); result.args.push("--timeout-ms=10000");
    } else if (command === "mouse-wheel") for (const key of ["x", "y", "dx", "dy"]) flag(key);
    else { result.args.push(`--xy=${String(p.x)},${String(p.y)}`); flag("button"); flag("count"); }
  }
  return result;
}
