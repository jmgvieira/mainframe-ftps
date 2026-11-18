import * as vscode from "vscode";
import * as path from "path";
import { activeServer } from "./config";

/** Destino de um ficheiro local no mainframe. "IGNORE" = nunca enviar. */
export type Target = string;
export const IGNORE = "IGNORE";

const MAP_FILE = "mainframe-ftps.json";
/** Ficheiro de associações dentro da pasta local da extensão. */
const LOCAL_MAP_FILE = ".mainframe-ftps.json";

/** Um ficheiro de associações e o caminho relativo do ficheiro local dentro dele. */
interface Store {
  file: vscode.Uri;
  rel: string;
}

/**
 * Associação ficheiro local -> data set/membro (e servidor de origem).
 * - Ficheiros dentro da pasta local da extensão: <pasta local>/.mainframe-ftps.json.
 * - Outros ficheiros dentro de uma pasta de workspace: .vscode/mainframe-ftps.json.
 * - Fora de ambas: estado global da extensão.
 * Na leitura também se procura nos sítios usados pelas versões anteriores.
 */
export class TargetMap {
  /** Associações desta sessão do VS Code (não depende de ler o .json). */
  private readonly cache = new Map<string, Target>();
  private readonly serverCache = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Destino de um ficheiro: associação guardada ou, para ficheiros na pasta local
   * da extensão (<pasta>/<PDS>/<MEMBRO> ou <pasta>/<DSN>), o destino deduzido do caminho.
   */
  async get(uri: vscode.Uri): Promise<Target | undefined> {
    return (await this.stored(uri)) ?? targetFromPath(uri, localBase(this.context));
  }

  /** Só a associação guardada, sem deduzir pelo caminho. */
  async stored(uri: vscode.Uri): Promise<Target | undefined> {
    const k = pathKey(uri.fsPath);
    if (this.cache.has(k)) {
      return this.cache.get(k);
    }
    for (const st of this.stores(uri)) {
      const hit = findKey((await this.read(st.file)).files, st.rel);
      if (hit !== undefined) {
        return hit;
      }
    }
    return findKey(this.context.globalState.get<Record<string, string>>("mainframeFtps.map", {}), uri.fsPath);
  }

  /**
   * Associa o ficheiro a um destino. O servidor ativo nesse momento fica registado,
   * para avisar se o ficheiro for gravado ou submetido noutro servidor.
   */
  async set(uri: vscode.Uri, target: Target | undefined): Promise<void> {
    const k = pathKey(uri.fsPath);
    const server = target && target !== IGNORE ? activeServer()?.name : undefined;
    if (target === undefined) {
      this.cache.delete(k);
    } else {
      this.cache.set(k, target);
    }
    if (server) {
      this.serverCache.set(k, server);
    } else {
      this.serverCache.delete(k);
    }
    const stores = this.stores(uri);
    if (stores.length) {
      // grava no primeiro sítio e retira dos antigos, para não haver duas versões
      for (const [i, st] of stores.entries()) {
        const data = await this.read(st.file);
        const had = findKey(data.files, st.rel) !== undefined;
        if (i > 0 && !had) {
          continue;
        }
        delete data.files[st.rel];
        delete data.servers[st.rel];
        if (i === 0) {
          if (target !== undefined) {
            data.files[st.rel] = target;
            if (target !== IGNORE) {
              data.lastPds = pdsOf(target);
            }
          }
          if (server) {
            data.servers[st.rel] = server;
          }
        }
        await this.write(st.file, data);
      }
      return;
    }
    const all = { ...this.context.globalState.get<Record<string, string>>("mainframeFtps.map", {}) };
    const allServers = { ...this.context.globalState.get<Record<string, string>>("mainframeFtps.mapServers", {}) };
    if (target === undefined) {
      delete all[uri.fsPath];
    } else {
      all[uri.fsPath] = target;
    }
    if (server) {
      allServers[uri.fsPath] = server;
    } else {
      delete allServers[uri.fsPath];
    }
    await this.context.globalState.update("mainframeFtps.map", all);
    await this.context.globalState.update("mainframeFtps.mapServers", allServers);
    if (target && target !== IGNORE) {
      await this.context.globalState.update("mainframeFtps.lastPds", pdsOf(target));
    }
  }

  /** Servidor de onde o ficheiro veio (ou para onde foi gravado pela última vez). */
  async serverOf(uri: vscode.Uri): Promise<string | undefined> {
    const k = pathKey(uri.fsPath);
    if (this.serverCache.has(k)) {
      return this.serverCache.get(k);
    }
    for (const st of this.stores(uri)) {
      const hit = findKey((await this.read(st.file)).servers, st.rel);
      if (hit !== undefined) {
        return hit;
      }
    }
    return findKey(this.context.globalState.get<Record<string, string>>("mainframeFtps.mapServers", {}), uri.fsPath);
  }

  async lastPds(uri: vscode.Uri): Promise<string> {
    for (const st of this.stores(uri)) {
      const data = await this.read(st.file);
      if (data.lastPds) {
        return data.lastPds;
      }
    }
    return this.context.globalState.get<string>("mainframeFtps.lastPds", "");
  }

  /** Ficheiros de associações aplicáveis a um ficheiro, por ordem de preferência. */
  private stores(uri: vscode.Uri): Store[] {
    const out: Store[] = [];
    const base = localBase(this.context);
    if (isInside(uri, base)) {
      out.push({ file: vscode.Uri.joinPath(base, LOCAL_MAP_FILE), rel: relPath(base, uri) });
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      out.push({ file: vscode.Uri.joinPath(folder.uri, ".vscode", MAP_FILE), rel: relPath(folder.uri, uri) });
    }
    return out;
  }

  private async read(file: vscode.Uri): Promise<MapData> {
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return { lastPds: parsed.lastPds ?? "", files: parsed.files ?? {}, servers: parsed.servers ?? {} };
    } catch {
      return { lastPds: "", files: {}, servers: {} };
    }
  }

  private async write(file: vscode.Uri, data: MapData): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, ".."));
    const text = JSON.stringify(data, null, 2) + "\n";
    await vscode.workspace.fs.writeFile(file, Buffer.from(text, "utf8"));
  }
}

function isInside(uri: vscode.Uri, base: vscode.Uri): boolean {
  if (uri.scheme !== base.scheme) {
    return false;
  }
  const rel = path.relative(base.fsPath, uri.fsPath);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function relPath(base: vscode.Uri, uri: vscode.Uri): string {
  return path.relative(base.fsPath, uri.fsPath).split(path.sep).join("/");
}

interface MapData {
  lastPds: string;
  files: Record<string, string>;
  /** Servidor de cada ficheiro (mesmas chaves que files). */
  servers: Record<string, string>;
}

const isWindows = process.platform === "win32";

/** Chave para comparar caminhos (no Windows não distingue maiúsculas). */
function pathKey(p: string): string {
  return isWindows ? p.toLowerCase() : p;
}

function findKey(files: Record<string, string>, key: string): string | undefined {
  if (key in files) {
    return files[key];
  }
  if (isWindows) {
    const k = key.toLowerCase();
    const found = Object.keys(files).find((f) => f.toLowerCase() === k);
    return found !== undefined ? files[found] : undefined;
  }
  return undefined;
}

/** Pasta onde ficam as cópias locais dos data sets abertos a partir da vista Mainframe. */
export function localBase(context: vscode.ExtensionContext): vscode.Uri {
  const cfg = vscode.workspace.getConfiguration("mainframeFtps");
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  const configured = cfg.get<string>("localFolder", "").trim();
  if (configured) {
    const resolved = ws ? configured.replace("${workspaceFolder}", ws.fsPath) : configured;
    return ws && !path.isAbsolute(resolved) ? vscode.Uri.joinPath(ws, resolved) : vscode.Uri.file(resolved);
  }
  if (ws) {
    return vscode.Uri.joinPath(ws, "mainframe");
  }
  return vscode.Uri.joinPath(context.globalStorageUri, "mainframe");
}

/**
 * Deduz o destino de um ficheiro dentro da pasta local:
 * <base>/<PDS>/<MEMBRO> -> PDS(MEMBRO); <base>/<DSN> -> DSN.
 */
export function targetFromPath(uri: vscode.Uri, base: vscode.Uri): Target | undefined {
  if (uri.scheme !== base.scheme) {
    return undefined;
  }
  const rel = path.relative(base.fsPath, uri.fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  const parts = rel.split(/[\\/]/);
  if (parts.length === 2) {
    // <PDS>/<MEMBRO> (ou <PDS>/<MEMBRO>.<ext> das versões anteriores)
    const pds = parts[0].toUpperCase();
    let member = parts[1].toUpperCase();
    if (validateMember(member)) {
      member = path.parse(member).name;
    }
    return !validateDsn(pds) && !validateMember(member) ? `${pds}(${member})` : undefined;
  }
  if (parts.length === 1) {
    // <DSN>: o nome do ficheiro é o nome do data set
    const dsn = parts[0].toUpperCase();
    return !validateDsn(dsn) ? dsn : undefined;
  }
  return undefined;
}

export function pdsOf(target: string): string {
  const i = target.indexOf("(");
  return i >= 0 ? target.slice(0, i) : target;
}

export function memberOf(target: string): string {
  const m = /\(([^)]+)\)/.exec(target);
  return m ? m[1] : "";
}

const QUAL = /^[A-Z#@$][A-Z0-9#@$-]{0,7}$/;
const MEMBER = /^[A-Z#@$][A-Z0-9#@$]{0,7}$/;

export function validateDsn(v: string): string | undefined {
  const d = v.trim().toUpperCase().replace(/^'|'$/g, "");
  if (!d) {
    return "Enter the data set name";
  }
  if (d.length > 44) {
    return "Maximum 44 characters";
  }
  if (!d.split(".").every((q) => QUAL.test(q))) {
    return "Each qualifier: 1–8 characters, starting with a letter or #@$";
  }
  return undefined;
}

export function validateMember(v: string): string | undefined {
  return MEMBER.test(v.trim().toUpperCase()) ? undefined : "Member: 1–8 characters, starting with a letter or #@$";
}

/** Sugere um nome de membro a partir do nome do ficheiro. */
export function suggestMember(fileName: string): string {
  const base = path.parse(fileName).name.toUpperCase().replace(/[^A-Z0-9#@$]/g, "");
  const s = base.replace(/^[0-9]+/, "");
  return (s || "MEMBRO").slice(0, 8);
}
