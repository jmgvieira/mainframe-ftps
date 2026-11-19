import * as vscode from "vscode";
import { TransferEncoding } from "./codec";

export interface MfConfig {
  host: string;
  port: number;
  tlsMode: "explicit" | "implicit";
  rejectUnauthorized: boolean;
  tlsServerName: string;
  /** Versão máxima de TLS: auto (negociada), TLSv1.2 ou TLSv1.3. */
  tlsMaxVersion: string;
  user: string;
  passcodeOrder: "pinThenToken" | "tokenThenPin";
  rememberPin: boolean;
  keepAliveSeconds: number;
  idleDisconnectMinutes: number;
  timeoutSeconds: number;
  siteCommands: string[];
  autoUploadOnSave: boolean;
  /** Pedir confirmação antes de cada gravação no mainframe. */
  confirmUpload: boolean;
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

/** Servidores disponíveis (`mainframeFtps.hosts`). */
export function servers(): ServerDef[] {
  const c = vscode.workspace.getConfiguration("mainframeFtps");
  return parseHosts(c.get<string>("hosts", ""), c.get<number>("port", 990));
}

/**
 * Até à 0.4.x havia um só servidor em `mainframeFtps.host`. Ao arrancar, esse valor passa
 * para `mainframeFtps.hosts` (se ainda estiver vazio no mesmo nível) e o `host` é apagado.
 */
export async function migrateLegacyHost(log: (msg: string) => void): Promise<void> {
  const c = vscode.workspace.getConfiguration("mainframeFtps");
  const host = c.inspect<string>("host");
  const hosts = c.inspect<string>("hosts");
  const levels: Array<[vscode.ConfigurationTarget, string | undefined, string | undefined]> = [
    [vscode.ConfigurationTarget.Global, host?.globalValue, hosts?.globalValue],
    [vscode.ConfigurationTarget.Workspace, host?.workspaceValue, hosts?.workspaceValue],
  ];
  for (const [target, oldHost, current] of levels) {
    const value = (oldHost ?? "").trim();
    if (!value) {
      continue;
    }
    try {
      if (!(current ?? "").trim()) {
        await c.update("hosts", value, target);
        log(`Setting mainframeFtps.host (${value}) moved to mainframeFtps.hosts.`);
      } else {
        log(`Setting mainframeFtps.host (${value}) removed: mainframeFtps.hosts is already filled in.`);
      }
      await c.update("host", undefined, target);
    } catch (err) {
      log(`Could not migrate mainframeFtps.host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
    tlsMaxVersion: c.get("tlsMaxVersion", "auto"),
    user: c.get("user", ""),
    passcodeOrder: c.get("passcodeOrder", "pinThenToken"),
    rememberPin: c.get("rememberPin", false),
    keepAliveSeconds: c.get("keepAliveSeconds", 60),
    idleDisconnectMinutes: c.get("idleDisconnectMinutes", 0),
    timeoutSeconds: c.get("timeoutSeconds", 30),
    siteCommands: c.get("siteCommands", []),
    autoUploadOnSave: c.get("autoUploadOnSave", true),
    confirmUpload: c.get("confirmUpload", true),
    fileExtensions: c.get("fileExtensions", [".jcl", ".ezt", ".cbl", ".cpy", ".proc"]).map((e) => e.toLowerCase()),
    transferEncoding: c.get<TransferEncoding>("transferEncoding", "iso8859-15"),
    hostCodePage: c.get("hostCodePage", "IBM-1147"),
    recordLength: c.get("recordLength", 80),
    pollSeconds: c.get("jobPollSeconds", 5),
    pollMaxMinutes: c.get("jobPollMaxMinutes", 10),
    spoolStripAsa: c.get("spoolStripAsa", true),
  };
}
