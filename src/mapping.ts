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
  constructor(private readonly context: vscode.ExtensionContext) {}

  async get(uri: vscode.Uri): Promise<Target | undefined> {
    const loc = this.locate(uri);
    if (loc) {
      const data = await this.read(loc.folder);
      return data.files[loc.rel];
    }
    return this.context.globalState.get<Record<string, string>>("mainframeFtps.map", {})[uri.fsPath];
  }

  async set(uri: vscode.Uri, target: Target | undefined): Promise<void> {
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
