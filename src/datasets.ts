import * as vscode from "vscode";
import { FtpSession, errText, CancelledError } from "./session";

export interface DsInfo {
  name: string;
  dsorg: string; // PO, PS, VS, ?…
  recfm: string;
  lrecl: number;
  blksize: number;
  volume: string;
  referred: string;
  migrated: boolean;
  /** Pistas usadas (coluna Used da listagem), se conhecidas. */
  used?: number;
}

/** Tamanho máximo aproximado de um data set sequencial (pistas usadas × 56 664 bytes de uma 3390). */
export function estimateBytes(info: DsInfo): number | undefined {
  if (info.dsorg !== "PS" || info.migrated || info.used === undefined) {
    return undefined;
  }
  return info.used * 56664;
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 / 1024))} MB`;
}

export interface MemberInfo {
  pds: string;
  name: string;
  changed?: string;
  size?: number;
  id?: string;
}

export type MfNode =
  | { kind: "filter"; pattern: string }
  | { kind: "ds"; info: DsInfo }
  | { kind: "member"; info: MemberInfo }
  | { kind: "message"; text: string; error?: boolean };

// ------------------------------------------------------------ interpretação

/**
 * Os nomes chegam pela ligação de dados, convertida com o código de página do host
 * (no IBM-1147 os caracteres nacionais # @ aparecem como £ à). Os comandos FTP
 * (ligação de controlo) usam a tabela normal, por isso repõe-se # e @.
 */
export function normalizeName(n: string): string {
  return n.replace(/£/g, "#").replace(/[àÀ]/g, "@").toUpperCase();
}

/**
 * Interpreta a listagem MVS do servidor FTP do z/OS:
 *   Volume Unit    Referred Ext Used Recfm Lrecl BlkSz Dsorg Dsname
 *   WRK001 3390   2026/11/12  1   15  FB      80 27920  PO  JCL.LIB
 *   Migrated                                                OLD.DATA
 */
export function parseDatasetList(raw: string, cwd: string): DsInfo[] {
  const out: DsInfo[] = [];
  const full = (n: string) => {
    if (n.startsWith("'")) {
      return normalizeName(n.replace(/'/g, ""));
    }
    return normalizeName(cwd + n);
  };
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (!line.trim() || /^Volume\s+Unit/i.test(line.trim()) || /^Pseudo\s+Directory/i.test(line.trim())) {
      continue;
    }
    const name = full(t[t.length - 1]);
    if (/^Migrated/i.test(line.trim())) {
      out.push({ name, dsorg: "?", recfm: "", lrecl: 0, blksize: 0, volume: "", referred: "", migrated: true });
      continue;
    }
    if (t.length >= 10) {
      out.push({
        name,
        dsorg: t[t.length - 2].toUpperCase(),
        recfm: t[t.length - 5],
        lrecl: parseInt(t[t.length - 4], 10) || 0,
        blksize: parseInt(t[t.length - 3], 10) || 0,
        volume: t[0],
        referred: t[2],
        migrated: false,
        used: /^\d+$/.test(t[t.length - 6]) ? parseInt(t[t.length - 6], 10) : undefined,
      });
    } else {
      // VSAM, tape, ou atributos indisponíveis
      const dsorg = /VSAM/i.test(line) ? "VS" : "?";
      out.push({ name, dsorg, recfm: "", lrecl: 0, blksize: 0, volume: t[0] ?? "", referred: "", migrated: false });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 *   Name     VV.MM   Created       Changed      Size  Init   Mod   Id
 *   MEMBRO1   01.03 2026/01/02 2026/11/10 14:22    10    10     0 U12345
 *   MEMBRO2
 */
export function parseMemberList(raw: string, pds: string): MemberInfo[] {
  const out: MemberInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (!t[0] || /^Name$/i.test(t[0])) {
      continue;
    }
    const m: MemberInfo = { pds, name: normalizeName(t[0]) };
    if (t.length >= 9) {
      m.changed = `${t[3]} ${t[4]}`;
      m.size = parseInt(t[5], 10);
      m.id = t[8];
    }
    out.push(m);
  }
  return out;
}

// --------------------------------------------------------------------- vista

export class DatasetsProvider implements vscode.TreeDataProvider<MfNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<MfNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private dsCache = new Map<string, DsInfo[]>();
  private memberCache = new Map<string, MemberInfo[]>();

  constructor(private readonly session: FtpSession) {}

  filters(): string[] {
    return vscode.workspace.getConfiguration("mainframeFtps").get<string[]>("datasetFilters", []);
  }

  async setFilters(list: string[]): Promise<void> {
    await vscode.workspace
      .getConfiguration("mainframeFtps")
      .update("datasetFilters", list, vscode.ConfigurationTarget.Global);
    this.refresh();
  }

  refresh(node?: MfNode): void {
    if (!node) {
      this.dsCache.clear();
      this.memberCache.clear();
    } else if (node.kind === "filter") {
      this.dsCache.delete(node.pattern);
    } else if (node.kind === "ds") {
      this.memberCache.delete(node.info.name);
    }
    this._onDidChange.fire(node);
  }

  /** Atualiza o PDS a que um membro pertence (depois de criar/apagar). */
  refreshPds(pds: string): void {
    this.memberCache.delete(pds);
    this._onDidChange.fire(undefined);
  }

  cachedMembers(pds: string): MemberInfo[] | undefined {
    return this.memberCache.get(pds);
  }

  findDs(name: string): DsInfo | undefined {
    for (const list of this.dsCache.values()) {
      const d = list.find((x) => x.name === name);
      if (d) {
        return d;
      }
    }
    return undefined;
  }

  getParent(): undefined {
    return undefined;
  }

  getTreeItem(node: MfNode): vscode.TreeItem {
    switch (node.kind) {
      case "filter": {
        const it = new vscode.TreeItem(node.pattern, vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon("filter");
        it.contextValue = "mfFilter";
        it.id = `f:${node.pattern}`;
        return it;
      }
      case "ds": {
        const d = node.info;
        const isPds = d.dsorg.startsWith("PO");
        const it = new vscode.TreeItem(
          d.name,
          isPds ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        it.id = `d:${d.name}`;
        if (d.migrated) {
          it.description = "migrated";
          it.iconPath = new vscode.ThemeIcon("cloud");
          it.contextValue = "mfDsMigrated";
          it.command = { command: "mainframeFtps.openDataset", title: "Open", arguments: [node] };
        } else if (isPds) {
          it.description = `${d.dsorg} ${d.recfm} ${d.lrecl || ""}`.trim();
          it.iconPath = new vscode.ThemeIcon("library");
          it.contextValue = "mfDsPO";
        } else if (d.dsorg.startsWith("PS")) {
          it.description = `${d.dsorg} ${d.recfm} ${d.lrecl || ""}`.trim();
          it.iconPath = new vscode.ThemeIcon("file-text");
          it.contextValue = "mfDsPS";
          it.command = { command: "mainframeFtps.openDataset", title: "Open", arguments: [node] };
        } else {
          it.description = d.dsorg === "VS" ? "VSAM" : d.dsorg;
          it.iconPath = new vscode.ThemeIcon(d.dsorg === "VS" ? "database" : "question");
          it.contextValue = "mfDsOther";
        }
        it.tooltip = new vscode.MarkdownString(
          `**${d.name}**\n\n` +
            (d.migrated
              ? "Migrated (HSM). Opening it starts a recall, which may take a while."
              : `DSORG ${d.dsorg} · RECFM ${d.recfm || "?"} · LRECL ${d.lrecl || "?"} · BLKSIZE ${d.blksize || "?"}\n\n` +
                `Volume ${d.volume || "?"} · last referenced ${d.referred || "?"}`)
        );
        return it;
      }
      case "member": {
        const m = node.info;
        const it = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
        it.id = `m:${m.pds}(${m.name})`;
        it.iconPath = new vscode.ThemeIcon("file-code");
        it.description = m.changed ? `${m.changed}${m.id ? " · " + m.id : ""}` : undefined;
        it.tooltip = `${m.pds}(${m.name})${m.changed ? `\nChanged: ${m.changed} by ${m.id}\nLines: ${m.size}` : ""}`;
        it.contextValue = "mfMember";
        it.command = { command: "mainframeFtps.openDataset", title: "Open", arguments: [node] };
        return it;
      }
      case "message": {
        const it = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon(node.error ? "error" : "info");
        return it;
      }
    }
  }

  async getChildren(node?: MfNode): Promise<MfNode[]> {
    if (!node) {
      // desligado ou sem filtros: a vista mostra o texto de boas-vindas
      if (!this.session.isConnected) {
        return [];
      }
      return this.filters().map((pattern) => ({ kind: "filter", pattern }));
    }
    if (!this.session.isConnected) {
      return [{ kind: "message", text: "Disconnected – click the connect icon" }];
    }
    try {
      if (node.kind === "filter") {
        let list = this.dsCache.get(node.pattern);
        if (!list) {
          const { raw, cwd } = await this.session.listDatasetsRaw(node.pattern);
          list = parseDatasetList(raw, cwd);
          this.dsCache.set(node.pattern, list);
        }
        return list.length ? list.map((info) => ({ kind: "ds", info })) : [{ kind: "message", text: "No data sets" }];
      }
      if (node.kind === "ds") {
        let list = this.memberCache.get(node.info.name);
        if (!list) {
          list = parseMemberList(await this.session.listMembersRaw(node.info.name), node.info.name);
          this.memberCache.set(node.info.name, list);
        }
        return list.length ? list.map((info) => ({ kind: "member", info })) : [{ kind: "message", text: "Empty PDS" }];
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        return [];
      }
      return [{ kind: "message", text: errText(err), error: true }];
    }
    return [];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
