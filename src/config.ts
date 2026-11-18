import * as vscode from "vscode";
import { TransferEncoding } from "./codec";

export interface MfConfig {
  host: string;
  port: number;
  tlsMode: "explicit" | "implicit";
  rejectUnauthorized: boolean;
  tlsServerName: string;
  user: string;
  passcodeOrder: "pinThenToken" | "tokenThenPin";
  rememberPin: boolean;
  keepAliveSeconds: number;
  idleDisconnectMinutes: number;
  timeoutSeconds: number;
  siteCommands: string[];
  autoUploadOnSave: boolean;
  fileExtensions: string[];
  transferEncoding: TransferEncoding;
  hostCodePage: string;
  recordLength: number;
  pollSeconds: number;
  pollMaxMinutes: number;
  spoolStripAsa: boolean;
}

/** Um servidor da lista `mainframeFtps.hosts`. */
export interface ServerDef {
  name: string;
  host: string;
  port: number;
}

/**
 * Interpreta a lista de servidores: "PROD=mvs1.empresa.pt;TESTE=mvs2.empresa.pt:991;mvs3.empresa.pt".
 * Nome e porta são opcionais (sem nome usa o host; sem porta usa defaultPort).
 * Também aceita vírgulas e mudanças de linha como separadores.
 */
export function parseHosts(text: string, defaultPort: number): ServerDef[] {
  const out: ServerDef[] = [];
  for (const raw of text.split(/[;,\n]/)) {
    const item = raw.trim();
    if (!item) {
      continue;
    }
    const eq = item.indexOf("=");
    const name = eq > 0 ? item.slice(0, eq).trim() : "";
    let addr = (eq > 0 ? item.slice(eq + 1) : item).trim();
    let port = defaultPort;
    const m = /^(.*):(\d{1,5})$/.exec(addr);
    if (m) {
      addr = m[1].trim();
      port = parseInt(m[2], 10);
    }
    if (!addr) {
      continue;
    }
    const finalName = name || addr;
    if (!out.some((s) => s.name.toUpperCase() === finalName.toUpperCase())) {
      out.push({ name: finalName, host: addr, port });
    }
  }
  return out;
}

const ACTIVE_KEY = "mainframeFtps.activeServer";
let state: vscode.Memento | undefined;

/** Chamado no activate: o servidor ativo fica guardado entre sessões do VS Code. */
export function initServers(context: vscode.ExtensionContext): void {
  state = context.globalState;
}

/**
 * Servidores disponíveis: os de `mainframeFtps.hosts` e, se estiver preenchido e não
 * constar da lista, o `mainframeFtps.host` antigo (fica em primeiro lugar).
 */
export function servers(): ServerDef[] {
  const c = vscode.workspace.getConfiguration("mainframeFtps");
  const defaultPort = c.get<number>("port", 990);
  const list = parseHosts(c.get<string>("hosts", ""), defaultPort);
  const legacy = c.get<string>("host", "").trim();
  if (legacy && !list.some((s) => s.host.toLowerCase() === legacy.toLowerCase() && s.port === defaultPort)) {
    list.unshift({ name: legacy, host: legacy, port: defaultPort });
  }
  return list;
}

/** Servidor em uso: o último escolhido, se ainda existir na lista, senão o primeiro. */
export function activeServer(): ServerDef | undefined {
  const list = servers();
  const chosen = state?.get<string>(ACTIVE_KEY, "");
  return list.find((s) => s.name === chosen) ?? list[0];
}

export async function setActiveServer(name: string): Promise<void> {
  await state?.update(ACTIVE_KEY, name);
}

export function getConfig(): MfConfig {
  const c = vscode.workspace.getConfiguration("mainframeFtps");
  const active = activeServer();
  return {
    host: active?.host ?? "",
    port: active?.port ?? c.get("port", 990),
    tlsMode: c.get("tlsMode", "explicit"),
    rejectUnauthorized: c.get("rejectUnauthorizedCertificates", true),
    tlsServerName: c.get("tlsServerName", ""),
    user: c.get("user", ""),
    passcodeOrder: c.get("passcodeOrder", "pinThenToken"),
    rememberPin: c.get("rememberPin", false),
    keepAliveSeconds: c.get("keepAliveSeconds", 60),
    idleDisconnectMinutes: c.get("idleDisconnectMinutes", 0),
    timeoutSeconds: c.get("timeoutSeconds", 30),
    siteCommands: c.get("siteCommands", []),
    autoUploadOnSave: c.get("autoUploadOnSave", true),
    fileExtensions: c.get("fileExtensions", [".jcl", ".ezt", ".cbl", ".cpy", ".proc"]).map((e) => e.toLowerCase()),
    transferEncoding: c.get<TransferEncoding>("transferEncoding", "iso8859-15"),
    hostCodePage: c.get("hostCodePage", "IBM-1147"),
    recordLength: c.get("recordLength", 80),
    pollSeconds: c.get("jobPollSeconds", 5),
    pollMaxMinutes: c.get("jobPollMaxMinutes", 10),
    spoolStripAsa: c.get("spoolStripAsa", true),
  };
}
