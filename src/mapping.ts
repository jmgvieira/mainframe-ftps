import * as vscode from "vscode";
import * as path from "path";

/** Destino de um ficheiro local no mainframe. "IGNORE" = nunca enviar. */
export type Target = string;
export const IGNORE = "IGNORE";

const MAP_FILE = "mainframe-ftps.json";

/**
 * Associação ficheiro local -> data set/membro.
 * Dentro de uma pasta de workspace fica em .vscode/mainframe-ftps.json (caminhos relativos),
 * fora de um workspace fica no estado global da extensão.
 */
export class TargetMap {
  /** Associações desta sessão do VS Code (não depende de ler o .json). */
  private readonly cache = new Map<string, Target>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Destino de um ficheiro: associação guardada ou, para ficheiros na pasta local
   * da extensão (mainframe/<PDS>/<MEMBRO>.<ext> ou mainframe/<DSN>.<ext>), o destino
   * deduzido do caminho.
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
    const loc = this.locate(uri);
    if (loc) {
      const data = await this.read(loc.folder);
      const hit = findKey(data.files, loc.rel);
      if (hit !== undefined) {
        return hit;
      }
    }
    return findKey(this.context.globalState.get<Record<string, string>>("mainframeFtps.map", {}), uri.fsPath);
  }

  async set(uri: vscode.Uri, target: Target | undefined): Promise<void> {
    const k = pathKey(uri.fsPath);
    if (target === undefined) {
      this.cache.delete(k);
    } else {
      this.cache.set(k, target);
    }
    const loc = this.locate(uri);
    if (loc) {
      const data = await this.read(loc.folder);
      if (target === undefined) {
        delete data.files[loc.rel];
      } else {
        data.files[loc.rel] = target;
        if (target !== IGNORE) {
          data.lastPds = pdsOf(target);
        }
      }
      await this.write(loc.folder, data);
      return;
    }
    const all = { ...this.context.globalState.get<Record<string, string>>("mainframeFtps.map", {}) };
    if (target === undefined) {
      delete all[uri.fsPath];
    } else {
      all[uri.fsPath] = target;
    }
    await this.context.globalState.update("mainframeFtps.map", all);
    if (target && target !== IGNORE) {
      await this.context.globalState.update("mainframeFtps.lastPds", pdsOf(target));
    }
  }

  async lastPds(uri: vscode.Uri): Promise<string> {
    const loc = this.locate(uri);
    if (loc) {
      const data = await this.read(loc.folder);
      if (data.lastPds) {
        return data.lastPds;
      }
    }
    return this.context.globalState.get<string>("mainframeFtps.lastPds", "");
  }

  private locate(uri: vscode.Uri): { folder: vscode.WorkspaceFolder; rel: string } | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
    return { folder, rel };
  }

  private fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, ".vscode", MAP_FILE);
  }

  private async read(folder: vscode.WorkspaceFolder): Promise<MapData> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(folder));
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return { lastPds: parsed.lastPds ?? "", files: parsed.files ?? {} };
    } catch {
      return { lastPds: "", files: {} };
    }
  }

  private async write(folder: vscode.WorkspaceFolder, data: MapData): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".vscode"));
    const text = JSON.stringify(data, null, 2) + "\n";
    await vscode.workspace.fs.writeFile(this.fileUri(folder), Buffer.from(text, "utf8"));
  }
}

interface MapData {
  lastPds: string;
  files: Record<string, string>;
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
    return "Indique o data set";
  }
  if (d.length > 44) {
    return "Máximo 44 caracteres";
  }
  if (!d.split(".").every((q) => QUAL.test(q))) {
    return "Cada qualificador: 1–8 caracteres, começa por letra ou #@$";
  }
  return undefined;
}

export function validateMember(v: string): string | undefined {
  return MEMBER.test(v.trim().toUpperCase()) ? undefined : "Membro: 1–8 caracteres, começa por letra ou #@$";
}

/** Sugere um nome de membro a partir do nome do ficheiro. */
export function suggestMember(fileName: string): string {
  const base = path.parse(fileName).name.toUpperCase().replace(/[^A-Z0-9#@$]/g, "");
  const s = base.replace(/^[0-9]+/, "");
  return (s || "MEMBRO").slice(0, 8);
}
