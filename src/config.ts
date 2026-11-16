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

export function getConfig(): MfConfig {
  const c = vscode.workspace.getConfiguration("mainframeFtps");
  return {
    host: c.get("host", ""),
    port: c.get("port", 990),
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
