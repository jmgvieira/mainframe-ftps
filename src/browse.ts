import * as vscode from "vscode";
import { FtpSession, CancelledError, errText, AllocOptions } from "./session";
import { DatasetsProvider, MfNode, DsInfo } from "./datasets";
import { TargetMap, IGNORE, validateDsn, validateMember, pdsOf, memberOf, localBase, targetFromPath } from "./mapping";
import { decode } from "./codec";
import { getConfig } from "./config";

const ASKED_KEY = "mainframeFtps.localFolderAsked";

interface Deps {
  context: vscode.ExtensionContext;
  session: FtpSession;
  targets: TargetMap;
  datasets: DatasetsProvider;
  log: vscode.OutputChannel;
  /** Submete JCL e regista o job na vista de jobs. */
  submit: (jcl: Buffer, jobName: string, source: string) => Promise<void>;
  /** Regista um comando com tratamento de erros. */
  cmd: (id: string, fn: (...args: any[]) => Promise<unknown>) => vscode.Disposable;
}

const DEFAULT_EXT: Record<string, string> = {
  JCL: ".jcl", CNTL: ".jcl", PROC: ".jcl", PROCLIB: ".jcl", JOBS: ".jcl", JCLLIB: ".jcl",
  EZT: ".ezt", EASY: ".ezt", EASYTREV: ".ezt", EZTLIB: ".ezt",
  COBOL: ".cbl", CBL: ".cbl", COB: ".cbl", SOURCE: ".cbl",
  COPY: ".cpy", COPYLIB: ".cpy", CPY: ".cpy",
};

/** Extensão que indica o tipo de um data set, pelos seus qualificadores (só para escolher a linguagem). */
export function extFor(dsn: string): string {
  const cfg = vscode.workspace.getConfiguration("mainframeFtps");
  const custom = cfg.get<Record<string, string>>("qualifierExtensions", {});
  const map: Record<string, string> = { ...DEFAULT_EXT };
  for (const [k, v] of Object.entries(custom)) {
    map[k.toUpperCase()] = v.startsWith(".") ? v : "." + v;
  }
  const quals = pdsOf(dsn).toUpperCase().split(".").reverse();
  for (const q of quals) {
    if (map[q]) {
      return map[q];
    }
  }
  const def = cfg.get<string>("defaultExtension", ".jcl").trim() || ".jcl";
  return def.startsWith(".") ? def : "." + def;
}

/** Linguagem do VS Code associada a uma extensão (.jcl, .ezt…), pelas extensões instaladas. */
function languageForExt(ext: string, known: string[]): string | undefined {
  const e = ext.toLowerCase();
  for (const x of vscode.extensions.all) {
    const langs: any[] = x.packageJSON?.contributes?.languages ?? [];
    for (const l of langs) {
      if (Array.isArray(l.extensions) && l.extensions.some((v: string) => v.toLowerCase() === e) && known.includes(l.id)) {
        return l.id;
      }
    }
  }
  return undefined;
}

/** Aplica a linguagem certa a um ficheiro local sem extensão (nome igual ao do mainframe). */
async function applyLanguage(doc: vscode.TextDocument, target: string): Promise<void> {
  const known = await vscode.languages.getLanguages();
  const lang = languageForExt(extFor(target), known);
  if (lang && doc.languageId !== lang) {
    await vscode.languages.setTextDocumentLanguage(doc, lang);
  }
}

export function registerBrowse(d: Deps): vscode.Disposable[] {
  const { session, targets, datasets, cmd } = d;

  const view = vscode.window.createTreeView("mainframeFtps.datasets", {
    treeDataProvider: datasets,
    showCollapseAll: true,
  });
  const updateDescription = () => (view.description = session.stateLabel);
  updateDescription();

  // ------------------------------------------------------------- local files

  function localUri(target: string): vscode.Uri {
    // Mesmo nome que no mainframe: <base>/<PDS>/<MEMBRO> ou <base>/<DSN>
    const base = localBase(d.context);
    const member = memberOf(target);
    return member ? vscode.Uri.joinPath(base, pdsOf(target), member) : vscode.Uri.joinPath(base, target);
  }

  /** Pergunta (uma vez) onde guardar, se não há pasta configurada nem pasta aberta no VS Code. */
  async function ensureLocalFolder(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("mainframeFtps");
    if (cfg.get<string>("localFolder", "").trim() || vscode.workspace.workspaceFolders?.length) {
      return;
    }
    if (d.context.globalState.get<boolean>(ASKED_KEY)) {
      return;
    }
    const choose = "Choose folder…";
    const storage = "Use VS Code storage";
    const a = await vscode.window.showInformationMessage(
      "Where should files opened from the mainframe be kept on this PC?",
      { modal: true, detail: "No folder is open in VS Code. You can change this later with \"Choose local folder\"." },
      choose,
      storage
    );
    if (a === choose) {
      await chooseLocalFolder();
    } else if (a === storage) {
      await d.context.globalState.update(ASKED_KEY, true);
    } else {
      throw new CancelledError();
    }
  }

  async function chooseLocalFolder(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: localBase(d.context),
      openLabel: "Use this folder",
      title: "Local folder for mainframe files",
    });
    if (!picked?.length) {
      return false;
    }
    await vscode.workspace
      .getConfiguration("mainframeFtps")
      .update("localFolder", picked[0].fsPath, vscode.ConfigurationTarget.Global);
    d.log.appendLine(`Local folder: ${picked[0].fsPath}`);
    vscode.window.setStatusBarMessage(`$(folder) Local folder: ${picked[0].fsPath}`, 5000);
    return true;
  }

  async function openRemote(target: string): Promise<void> {
    await ensureLocalFolder();
    const uri = localUri(target);
    const already = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath);
    let revert = false;
    if (already?.isDirty) {
      const a = await vscode.window.showWarningMessage(
        `${target} is already open with unsaved changes.`,
        { modal: true },
        "Open local version",
        "Download again (discard changes)"
      );
      if (!a) {
        return;
      }
      if (a === "Open local version") {
        await vscode.window.showTextDocument(already, { preview: false });
        return;
      }
      revert = true;
    }
    const buf = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Opening ${target}…` },
      () => session.downloadText(target)
    );
    const text = decode(buf, getConfig().transferEncoding).replace(/\r\n/g, "\n");
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
    await targets.set(uri, target);
    d.log.appendLine(`Opened ${target} in ${uri.fsPath}`);
    let doc = await vscode.workspace.openTextDocument(uri);
    await applyLanguage(doc, target);
    doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    if (revert) {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }

  // ------------------------------------------------------------------ helpers

  function targetOf(node: MfNode): string {
    if (node.kind === "member") {
      return `${node.info.pds}(${node.info.name})`;
    }
    if (node.kind === "ds") {
      return node.info.name;
    }
    throw new Error("Choose a data set or member.");
  }

  async function pickPdsNode(node?: MfNode): Promise<DsInfo> {
    if (node?.kind === "ds") {
      return node.info;
    }
    if (node?.kind === "member") {
      return datasets.findDs(node.info.pds) ?? fakeDs(node.info.pds, "PO");
    }
    const name = await vscode.window.showInputBox({
      title: "Library (PDS)",
      prompt: "PDS name",
      ignoreFocusOut: true,
      validateInput: validateDsn,
    });
    if (!name) {
      throw new CancelledError();
    }
    return fakeDs(clean(name), "PO");
  }

  // ------------------------------------------------------------------ comandos

  // Ficheiros sem extensão reabertos (restauro do VS Code, Explorador): repor a linguagem.
  const fixLanguage = async (doc: vscode.TextDocument) => {
    if (doc.uri.scheme === "untitled" || doc.languageId !== "plaintext") {
      return;
    }
    // Só ficheiros da pasta local da extensão
    if (!targetFromPath(doc.uri, localBase(d.context))) {
      return;
    }
    const target = await targets.get(doc.uri);
    if (target && target !== IGNORE) {
      await applyLanguage(doc, target).catch(() => undefined);
    }
  };
  vscode.workspace.textDocuments.forEach((doc) => void fixLanguage(doc));

  // Botão "Submeter" no topo do editor também para membros JCL sem extensão
  const updateJclContext = async (editor?: vscode.TextEditor) => {
    let isJcl = false;
    if (editor && editor.document.uri.scheme !== "untitled") {
      const target = await targets.get(editor.document.uri);
      isJcl = !!target && target !== IGNORE && extFor(target) === ".jcl";
    }
    await vscode.commands.executeCommand("setContext", "mainframeFtps.activeIsJcl", isJcl);
  };
  void updateJclContext(vscode.window.activeTextEditor);

  return [
    view,
    vscode.workspace.onDidOpenTextDocument((doc) => void fixLanguage(doc)),
    vscode.window.onDidChangeActiveTextEditor((e) => void updateJclContext(e)),
    session.onDidChangeState(() => {
      updateDescription();
      datasets.refresh();
    }),

    cmd("mainframeFtps.addFilter", async () => {
      const pattern = await vscode.window.showInputBox({
        title: "New data set filter",
        prompt: "Pattern, as in ISPF 3.4 (e.g. U12345.*, PROD.JCL.*)",
        value: session.user ? `${session.user}.*` : "",
        ignoreFocusOut: true,
        validateInput: (v) => (/^[A-Z#@$*%][A-Z0-9#@$.*%-]*$/i.test(v.trim()) ? undefined : "Invalid pattern"),
      });
      if (!pattern) {
        return;
      }
      const p = pattern.trim().toUpperCase();
      if (!datasets.filters().includes(p)) {
        await datasets.setFilters([...datasets.filters(), p]);
      }
      if (!session.isConnected) {
        await session.ensureConnected();
      }
    }),

    cmd("mainframeFtps.editFilter", async (node: MfNode) => {
      if (node?.kind !== "filter") {
        return;
      }
      const p = await vscode.window.showInputBox({ title: "Edit filter", value: node.pattern, ignoreFocusOut: true });
      if (p) {
        await datasets.setFilters(datasets.filters().map((f) => (f === node.pattern ? p.trim().toUpperCase() : f)));
      }
    }),

    cmd("mainframeFtps.removeFilter", async (node: MfNode) => {
      if (node?.kind === "filter") {
        await datasets.setFilters(datasets.filters().filter((f) => f !== node.pattern));
      }
    }),

    cmd("mainframeFtps.refreshDatasets", async (node?: MfNode) => {
      if (!session.isConnected) {
        await session.ensureConnected();
      }
      datasets.refresh(node);
    }),

    cmd("mainframeFtps.openDataset", async (node: MfNode) => {
      if (node.kind === "ds" && node.info.migrated) {
        const ok = await vscode.window.showInformationMessage(
          `${node.info.name} is migrated. Recall and open it? This may take a few minutes.`,
          "Recall"
        );
        if (!ok) {
          return;
        }
        try {
          await openRemote(node.info.name);
        } catch (err) {
          vscode.window.showInformationMessage(
            `Recall requested for ${node.info.name}. Refresh the list in a moment (${errText(err)}).`
          );
        }
        return;
      }
      await openRemote(targetOf(node));
    }),

    cmd("mainframeFtps.newMember", async (node?: MfNode) => {
      const pds = await pickPdsNode(node);
      const member = await vscode.window.showInputBox({
        title: `New member in ${pds.name}`,
        prompt: "Member name (up to 8 characters)",
        ignoreFocusOut: true,
        validateInput: validateMember,
      });
      if (!member) {
        return;
      }
      const name = member.trim().toUpperCase();
      const target = `${pds.name}(${name})`;
      await ensureLocalFolder();
      const existing = datasets.cachedMembers(pds.name) ?? [];
      if (existing.some((m) => m.name === name)) {
        const a = await vscode.window.showWarningMessage(`${target} already exists.`, "Open");
        if (a) {
          await openRemote(target);
        }
        return;
      }
      const uri = localUri(target);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      let exists = false;
      try {
        await vscode.workspace.fs.stat(uri);
        exists = true;
      } catch {
        /* não existe */
      }
      if (!exists) {
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      }
      await targets.set(uri, target);
      const doc = await vscode.workspace.openTextDocument(uri);
      await applyLanguage(doc, target);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`${target} will be created on the mainframe when you save (Ctrl+S).`);
    }),

    cmd("mainframeFtps.newDataset", async (node?: MfNode) => {
      const like = node?.kind === "ds" ? node.info : undefined;
      const prefix =
        node?.kind === "filter"
          ? node.pattern.replace(/[*%].*$/, "").replace(/\.$/, "")
          : like
          ? like.name
          : session.user;
      const name = await vscode.window.showInputBox({
        title: like ? `New data set like ${like.name}` : "New data set",
        prompt: "Fully qualified data set name",
        value: prefix ? `${prefix}.` : "",
        ignoreFocusOut: true,
        validateInput: validateDsn,
      });
      if (!name) {
        return;
      }
      const dsn = clean(name);

      let dsorg: "PO" | "PS";
      let pdse = true;
      if (like && !like.migrated && like.dsorg !== "?") {
        dsorg = like.dsorg.startsWith("PO") ? "PO" : "PS";
        pdse = like.dsorg === "PO-E";
      } else {
        const t = await vscode.window.showQuickPick(
          [
            { label: "PDSE (library)", description: "recommended for JCL and programs", v: "PDSE" },
            { label: "PDS", description: "classic library", v: "PDS" },
            { label: "Sequential (PS)", description: "a single file", v: "PS" },
          ],
          { title: `Type of ${dsn}` }
        );
        if (!t) {
          return;
        }
        dsorg = t.v === "PS" ? "PS" : "PO";
        pdse = t.v === "PDSE";
      }

      let recfm = like?.recfm || "";
      if (!recfm) {
        const r = await vscode.window.showQuickPick(["FB", "VB", "FBA", "VBA"], { title: "RECFM" });
        if (!r) {
          return;
        }
        recfm = r;
      }
      let lrecl = like?.lrecl || 0;
      if (!lrecl) {
        const l = await vscode.window.showInputBox({
          title: "LRECL",
          value: recfm.startsWith("V") ? "255" : "80",
          validateInput: (v) => (/^\d{1,5}$/.test(v) && +v > 0 && +v <= 32760 ? undefined : "1–32760"),
        });
        if (!l) {
          return;
        }
        lrecl = +l;
      }
      const sp = await vscode.window.showQuickPick(
        [
          { label: "Small", description: "15 tracks + 15", v: ["TRACKS", 15, 15, 20] },
          { label: "Medium", description: "5 cylinders + 5", v: ["CYLINDERS", 5, 5, 50] },
          { label: "Large", description: "50 cylinders + 25", v: ["CYLINDERS", 50, 25, 100] },
        ],
        { title: "Space" }
      );
      if (!sp) {
        return;
      }
      const opts: AllocOptions = {
        dsorg,
        pdse,
        recfm,
        lrecl,
        unit: sp.v[0] as "TRACKS" | "CYLINDERS",
        primary: sp.v[1] as number,
        secondary: sp.v[2] as number,
        directory: sp.v[3] as number,
      };
      await session.allocate(dsn, opts);
      datasets.refresh();
      const kind = dsorg === "PS" ? "sequential" : pdse ? "PDSE" : "PDS";
      const a = await vscode.window.showInformationMessage(
        `${dsn} created (${kind}, ${recfm}/${lrecl}).`,
        ...(dsorg === "PO" ? ["New member"] : ["Open"])
      );
      if (a === "New member") {
        await vscode.commands.executeCommand("mainframeFtps.newMember", { kind: "ds", info: fakeDs(dsn, "PO") });
      } else if (a === "Open") {
        await openRemote(dsn);
      }
    }),

    cmd("mainframeFtps.newDatasetLike", async (node: MfNode) =>
      vscode.commands.executeCommand("mainframeFtps.newDataset", node)
    ),

    cmd("mainframeFtps.renameItem", async (node: MfNode) => {
      const from = targetOf(node);
      const isMember = node.kind === "member";
      const v = await vscode.window.showInputBox({
        title: `Rename ${from}`,
        prompt: isMember ? "New member name" : "New data set name",
        value: isMember ? memberOf(from) : from,
        ignoreFocusOut: true,
        validateInput: isMember ? validateMember : validateDsn,
      });
      if (!v) {
        return;
      }
      const to = isMember ? `${pdsOf(from)}(${v.trim().toUpperCase()})` : clean(v);
      if (to === from) {
        return;
      }
      await session.rename(from, to);
      datasets.refresh();
      vscode.window.setStatusBarMessage(`$(edit) ${from} → ${to}`, 4000);
    }),

    cmd("mainframeFtps.deleteItem", async (node: MfNode) => {
      const t = targetOf(node);
      const ok = await vscode.window.showWarningMessage(
        `Delete ${t} from the mainframe?`,
        { modal: true, detail: "This cannot be undone." },
        "Delete"
      );
      if (!ok) {
        return;
      }
      await session.remove(t);
      datasets.refresh();
      vscode.window.setStatusBarMessage(`$(trash) ${t} deleted`, 4000);
    }),

    cmd("mainframeFtps.submitMember", async (node: MfNode) => {
      const t = targetOf(node);
      const buf = await session.downloadText(t);
      const text = decode(buf, getConfig().transferEncoding);
      const jobName = /^\/\/(\S+)\s+JOB\b/m.exec(text)?.[1]?.toUpperCase() ?? "";
      if (!jobName) {
        const go = await vscode.window.showWarningMessage(`${t} does not seem to have a JOB card. Submit anyway?`, "Submit");
        if (!go) {
          return;
        }
      }
      await d.submit(buf, jobName, t);
    }),

    cmd("mainframeFtps.chooseLocalFolder", async () => {
      await chooseLocalFolder();
    }),

    cmd("mainframeFtps.openLocalFolder", async () => {
      const base = localBase(d.context);
      await vscode.workspace.fs.createDirectory(base);
      await vscode.env.openExternal(base);
    }),

    cmd("mainframeFtps.copyName", async (node: MfNode) => {
      const t = targetOf(node);
      await vscode.env.clipboard.writeText(t);
      vscode.window.setStatusBarMessage(`$(copy) ${t} copied`, 3000);
    }),
  ];
}

function clean(dsn: string): string {
  return dsn.trim().toUpperCase().replace(/^'+|'+$/g, "");
}

function fakeDs(name: string, dsorg: string): DsInfo {
  return { name, dsorg, recfm: "", lrecl: 0, blksize: 0, volume: "", referred: "", migrated: false };
}

