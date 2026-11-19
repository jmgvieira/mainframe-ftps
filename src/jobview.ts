import * as vscode from "vscode";
import { FtpSession, CancelledError, errText } from "./session";
import { DsInfo, MfNode, parseDatasetList, parseMemberList } from "./datasets";
import { parseJcl, JclInfo, JclStep, JclDd } from "./jcl";

// Vista "In this job": data sets referidos no JCL ativo, agrupados por step.

type JobDsNode =
  | { kind: "step"; step: JclStep; idx: number }
  | { kind: "dd"; dd: JclDd; id: string }
  | { kind: "member"; pds: string; name: string; load: boolean }
  | { kind: "message"; text: string; error?: boolean };

interface Deps {
  session: FtpSession;
  log: vscode.OutputChannel;
  /** Evento de fim de job (para voltar a ver que data sets já existem). */
  onJobFinished: vscode.Event<unknown>;
  cmd: (id: string, fn: (...args: any[]) => Promise<unknown>) => vscode.Disposable;
}

/** O documento parece JCL: linguagem, extensão ou um cartão JOB/EXEC no início. */
export function looksLikeJcl(doc: vscode.TextDocument): boolean {
  if (/jcl/i.test(doc.languageId) || /\.jcl$/i.test(doc.uri.path)) {
    return true;
  }
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 60), 0));
  return /^\/\/\S*\s+(JOB|EXEC)\s/m.test(head);
}

export class JobDatasetsProvider implements vscode.TreeDataProvider<JobDsNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<JobDsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  doc: vscode.TextDocument | undefined;
  info: JclInfo | undefined;
  /** Atributos por data set: DsInfo, null = não existe, ausente = por verificar. */
  private attrs = new Map<string, DsInfo | null>();
  /** Data sets cuja verificação falhou (não se repete até ao Refresh). */
  private failed = new Set<string>();
  private checking = false;
  private recheck = false;

  constructor(private readonly session: FtpSession, private readonly log: vscode.OutputChannel) {}

  show(doc: vscode.TextDocument | undefined): void {
    this.doc = doc;
    this.info = doc ? parseJcl(doc.getText()) : undefined;
    this._onDidChange.fire(undefined);
  }

  /** Esquece os data sets que não existiam (podem ter sido criados entretanto). */
  forgetMissing(): void {
    for (const [k, v] of this.attrs) {
      if (v === null) {
        this.attrs.delete(k);
      }
    }
  }

  /** Só redesenha a árvore (não faz pedidos ao mainframe). */
  changed(): void {
    this._onDidChange.fire(undefined);
  }

  /**
   * Verifica no catálogo os data sets do JCL. Só a pedido do utilizador: algumas
   * listagens fazem o servidor cortar a ligação, e o basic-ftp fecha então a sessão.
   */
  async checkAll(): Promise<void> {
    this.failed.clear();
    this.attrs.clear();
    this._onDidChange.fire(undefined);
    await this.lookup();
  }

  attrsOf(base: string): DsInfo | null | undefined {
    return this.attrs.get(base);
  }

  /** Procura um data set no catálogo (pela ligação aberta). */
  async fetch(base: string, gdg = false, quiet = true): Promise<DsInfo | null> {
    const { raw, cwd } = await this.session.listDatasetsRaw(base, quiet);
    let found = parseDatasetList(raw, cwd).find((d) => d.name === base) ?? null;
    if (!found && gdg) {
      // base de um GDG: não aparece na listagem, as gerações sim (BASE.G0001V00)
      const g = await this.session.listDatasetsRaw(`${base}.G*`, quiet);
      const gens = parseDatasetList(g.raw, g.cwd).filter((d) => /\.G\d{4}V\d{2}$/.test(d.name));
      if (gens.length) {
        found = { ...gens[gens.length - 1], name: base };
      }
    }
    this.attrs.set(base, found);
    return found;
  }

  /** Verifica, um a um, os data sets ainda sem atributos. Só com a ligação aberta. */
  private async lookup(): Promise<void> {
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.recheck = false;
        const names = new Map<string, boolean>(); // nome → é GDG
        for (const s of this.info?.steps ?? []) {
          for (const dd of s.dds) {
            if (!dd.unresolved && !this.attrs.has(dd.base) && !this.failed.has(dd.base)) {
              names.set(dd.base, names.get(dd.base) || !!dd.gdg);
            }
          }
        }
        let first = true;
        for (const [base, gdg] of names) {
          if (!this.session.isConnected || this.recheck) {
            break;
          }
          if (!first) {
            await new Promise((r) => setTimeout(r, 400)); // não abrir ligações de dados seguidas
          }
          first = false;
          try {
            await this.fetch(base, gdg);
            this._onDidChange.fire(undefined);
          } catch (err) {
            if (err instanceof CancelledError || !this.session.isConnected) {
              break;
            }
            // falhou só este: passa ao seguinte
            this.failed.add(base);
            this.log.appendLine(`Could not check ${base}: ${errText(err)}`);
          }
        }
      } while (this.recheck && this.session.isConnected);
    } finally {
      this.checking = false;
    }
  }

  getTreeItem(node: JobDsNode): vscode.TreeItem {
    switch (node.kind) {
      case "step": {
        const s = node.step;
        const it = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.Expanded);
        it.id = `s:${node.idx}:${s.name}`;
        it.description = s.job ? s.exec : s.exec ? `EXEC ${s.exec}` : "";
        it.iconPath = new vscode.ThemeIcon(s.job ? "briefcase" : "debug-step-over");
        it.tooltip = `${s.name}${s.exec ? "  " + s.exec : ""}\nLine ${s.line + 1}`;
        it.contextValue = "mfJobStep";
        it.command = { command: "mainframeFtps.revealJclLine", title: "Go to line", arguments: [s.line] };
        return it;
      }
      case "dd":
        return this.ddItem(node);
      case "member": {
        const it = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        it.id = `jm:${node.pds}(${node.name})`;
        it.contextValue = "mfJobMember";
        if (node.load) {
          // load module: binário, não se abre como texto
          it.iconPath = new vscode.ThemeIcon("package");
          it.tooltip = `${node.pds}(${node.name})\nLoad module (RECFM U): cannot be opened as text.`;
          return it;
        }
        it.iconPath = new vscode.ThemeIcon("file-code");
        it.tooltip = `${node.pds}(${node.name})`;
        const target: MfNode = { kind: "member", info: { pds: node.pds, name: node.name } };
        it.command = { command: "mainframeFtps.openDataset", title: "Open", arguments: [target] };
        return it;
      }
      case "message": {
        const it = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon(node.error ? "error" : "info");
        return it;
      }
    }
  }

  private ddItem(node: { dd: JclDd; id: string }): vscode.TreeItem {
    const dd = node.dd;
    const a = dd.unresolved ? undefined : this.attrs.get(dd.base);
    const isLib = !!a && a.dsorg.startsWith("PO") && !dd.member;
    const it = new vscode.TreeItem(
      dd.dsn,
      isLib ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    it.id = node.id;
    const parts = [dd.concat ? `${dd.ddName} +` : dd.ddName, dd.disp];
    let icon = "file";
    let note = "";
    let openable = true;
    if (dd.unresolved) {
      icon = "warning";
      parts.push("symbol not resolved");
      note = "A symbol (&NAME) is not defined by a SET in this JCL, so the name is not known.";
      openable = false;
    } else if (dd.gdg && /^\+/.test(dd.gdg)) {
      icon = "add";
      parts.push("new generation");
      note = `Generation ${dd.gdg} is created by the job.`;
      openable = false;
    } else if (a === null) {
      icon = "circle-slash";
      parts.push("not found");
      note = "Not found in the catalog. Click to check again.";
    } else if (a) {
      if (a.migrated) {
        icon = "cloud";
        parts.push("migrated");
      } else if (dd.member) {
        icon = "file-code";
      } else if (isLib) {
        icon = "library";
      } else if (a.dsorg.startsWith("PS")) {
        icon = "file-text";
      } else if (a.dsorg === "VS") {
        icon = "database";
        openable = false;
        note = "VSAM files cannot be opened over FTP.";
      }
    } else if (dd.member) {
      icon = "file-code";
    }
    if (a === undefined && !dd.unresolved && !note) {
      note = "Not checked yet: click to open, or use **Check data sets** to see which ones exist.";
    }
    it.description = parts.join(" · ");
    it.iconPath = new vscode.ThemeIcon(
      icon,
      a === null || dd.unresolved ? new vscode.ThemeColor("disabledForeground") : undefined
    );
    const md = new vscode.MarkdownString(`**${dd.dsn}**\n\n`);
    md.appendMarkdown(`DD ${dd.ddName}${dd.concat ? " (concatenation)" : ""} · DISP=${dd.disp} · line ${dd.line + 1}`);
    if (a) {
      md.appendMarkdown(
        a.migrated
          ? "\n\nMigrated (HSM). Opening it starts a recall."
          : `\n\nDSORG ${a.dsorg} · RECFM ${a.recfm || "?"} · LRECL ${a.lrecl || "?"} · BLKSIZE ${a.blksize || "?"}`
      );
    }
    if (note) {
      md.appendMarkdown(`\n\n${note}`);
    }
    it.tooltip = md;
    it.contextValue = "mfJobDd";
    if (openable && !isLib) {
      it.command = { command: "mainframeFtps.openJobDataset", title: "Open", arguments: [node] };
    }
    return it;
  }

  async getChildren(node?: JobDsNode): Promise<JobDsNode[]> {
    if (!node) {
      if (!this.info) {
        return [];
      }
      const steps = this.info.steps
        .map((step, idx) => ({ kind: "step" as const, step, idx }))
        .filter((n) => n.step.dds.length);
      return steps.length ? steps : [{ kind: "message", text: "No data sets in this JCL" }];
    }
    if (node.kind === "step") {
      return node.step.dds.map((dd, i) => ({ kind: "dd", dd, id: `d:${node.idx}:${i}:${dd.dsn}` }));
    }
    if (node.kind === "dd") {
      try {
        const list = parseMemberList(await this.session.listMembersRaw(node.dd.base), node.dd.base);
        const load = /^U/i.test(this.attrs.get(node.dd.base)?.recfm ?? "");
        return list.length
          ? list.map((m) => ({ kind: "member", pds: m.pds, name: m.name, load }))
          : [{ kind: "message", text: "Empty PDS" }];
      } catch (err) {
        if (err instanceof CancelledError) {
          return [];
        }
        return [{ kind: "message", text: errText(err), error: true }];
      }
    }
    return [];
  }

  getParent(): undefined {
    return undefined;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** O documento ainda tem um separador aberto (o VS Code só fecha o documento minutos depois). */
function openInTab(doc: vscode.TextDocument): boolean {
  const uri = doc.uri.toString();
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri)
  );
}

export function registerJobView(d: Deps): vscode.Disposable[] {
  const { session, cmd } = d;
  const provider = new JobDatasetsProvider(session, d.log);
  const view = vscode.window.createTreeView("mainframeFtps.jobDatasets", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const updateTitle = () => {
    const doc = provider.doc;
    if (!doc) {
      view.description = undefined;
      return;
    }
    const file = doc.uri.path.split("/").pop() ?? "";
    const job = provider.info?.jobName;
    view.description = job ? `${job} · ${file}` : file;
  };

  // Segue o JCL ativo. Outros ficheiros (ex.: o membro que se abriu a partir daqui) não apagam a lista.
  const follow = (editor?: vscode.TextEditor) => {
    const doc = editor?.document;
    if (!doc || doc.uri.scheme === "output" || !looksLikeJcl(doc)) {
      return;
    }
    if (provider.doc?.uri.toString() !== doc.uri.toString()) {
      provider.forgetMissing();
    }
    provider.show(doc);
    updateTitle();
  };
  follow(vscode.window.activeTextEditor);

  /** Limpa a lista quando o separador do JCL é fechado. */
  const checkClosed = () => {
    if (provider.doc && !openInTab(provider.doc)) {
      provider.show(undefined);
      updateTitle();
      follow(vscode.window.activeTextEditor); // outro JCL que tenha ficado ativo
    }
  };

  let timer: NodeJS.Timeout | undefined;

  return [
    view,
    provider,
    vscode.window.onDidChangeActiveTextEditor(follow),
    vscode.window.tabGroups.onDidChangeTabs(checkClosed),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== provider.doc) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        provider.show(e.document);
        updateTitle();
      }, 500);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc !== provider.doc) {
        return;
      }
      // a mudança de linguagem fecha e reabre o documento: confirmar depois
      setTimeout(() => {
        const still = vscode.workspace.textDocuments.find((x) => x.uri.toString() === doc.uri.toString());
        if (still) {
          provider.show(still);
        } else {
          provider.show(undefined);
        }
        updateTitle();
      }, 300);
    }),
    // um job terminado pode ter criado os que faltavam: deixam de aparecer como "not found"
    d.onJobFinished(() => {
      provider.forgetMissing();
      provider.changed();
    }),
    { dispose: () => timer && clearTimeout(timer) },

    // Não obriga a ligar: sem ligação só volta a ler o JCL (ou limpa a lista se já foi fechado).
    cmd("mainframeFtps.refreshJobDatasets", async () => {
      checkClosed();
      if (!provider.doc) {
        follow(vscode.window.activeTextEditor);
        return;
      }
      provider.show(provider.doc);
      updateTitle();
    }),

    cmd("mainframeFtps.checkJobDatasets", async () => {
      checkClosed();
      if (!provider.doc) {
        return;
      }
      await session.ensureConnected();
      await vscode.window.withProgress(
        { location: { viewId: "mainframeFtps.jobDatasets" }, title: "Checking data sets" },
        () => provider.checkAll()
      );
    }),

    cmd("mainframeFtps.revealJclLine", async (arg: number | JobDsNode) => {
      const line = typeof arg === "number" ? arg : arg?.kind === "dd" ? arg.dd.line : arg?.kind === "step" ? arg.step.line : -1;
      const doc = provider.doc;
      if (!doc || line < 0) {
        return;
      }
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: typeof arg === "number" });
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }),

    cmd("mainframeFtps.copyJobDataset", async (node: JobDsNode) => {
      const t = node?.kind === "dd" ? node.dd.dsn : node?.kind === "member" ? `${node.pds}(${node.name})` : "";
      if (t) {
        await vscode.env.clipboard.writeText(t);
        vscode.window.setStatusBarMessage(`$(copy) ${t} copied`, 3000);
      }
    }),

    cmd("mainframeFtps.openJobDataset", async (node: JobDsNode) => {
      if (node?.kind !== "dd") {
        return;
      }
      const dd = node.dd;
      if (dd.member) {
        const target: MfNode = { kind: "member", info: { pds: dd.base, name: dd.member } };
        await vscode.commands.executeCommand("mainframeFtps.openDataset", target);
        return;
      }
      await session.ensureConnected();
      let a = provider.attrsOf(dd.base);
      if (!a) {
        a = await provider.fetch(dd.base, !!dd.gdg, false); // clique do utilizador: pode perguntar se cair
        provider.changed();
      }
      if (!a) {
        vscode.window.showWarningMessage(`${dd.base} does not exist (not found in the catalog).`);
        return;
      }
      if (a.dsorg.startsWith("PO")) {
        // biblioteca sem membro: a lista passa a mostrá-la expansível
        provider.changed();
        vscode.window.setStatusBarMessage(`$(library) ${dd.base} is a library: expand it to see the members`, 4000);
        return;
      }
      // geração relativa (0, -1): abre essa geração
      const info: DsInfo = dd.gdg ? { ...a, name: dd.dsn } : a;
      await vscode.commands.executeCommand("mainframeFtps.openDataset", { kind: "ds", info } as MfNode);
    }),
  ];
}
