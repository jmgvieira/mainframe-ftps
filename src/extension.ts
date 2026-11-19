import * as vscode from "vscode";
import * as path from "path";
import { FtpSession, CancelledError, errText } from "./session";
import { TargetMap, IGNORE, validateDsn, validateMember, suggestMember, pdsOf, memberOf } from "./mapping";
import { JobsProvider, JobInfo, parseJobList, parseJobLine, severity } from "./jobs";
import { getConfig, initServers, servers, migrateLegacyHost, activeServer } from "./config";
import { DatasetsProvider } from "./datasets";
import { registerBrowse } from "./browse";
import { registerJobView } from "./jobview";
import { encode, decode, unsupported, localBytes, doubleEncoded } from "./codec";
import { parseSpoolFiles, splitSpool, sections, formatSpool, documentSections } from "./spool";

let session: FtpSession;
let targets: TargetMap;
let jobs: JobsProvider;
let log: vscode.OutputChannel;
let datasets: DatasetsProvider;
const spoolChanged = new vscode.EventEmitter<vscode.Uri>();

const SPOOL_SCHEME = "mfspool";

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Mainframe FTPS");
  log.appendLine(`Mainframe FTPS ${context.extension.packageJSON.version} active (VS Code ${vscode.version}).`);
  initServers(context);
  void migrateLegacyHost((m) => log.appendLine(m));
  session = new FtpSession(context, log);
  targets = new TargetMap(context);
  jobs = new JobsProvider(context, session, log);

  datasets = new DatasetsProvider(session);
  const tree = vscode.window.createTreeView("mainframeFtps.jobs", { treeDataProvider: jobs });
  vscode.commands.executeCommand("setContext", "mainframeFtps.connected", false);

  const submitJcl = async (data: Buffer, jobName: string, source: string) => {
    const { jobId } = await session.submit(data);
    const job = await jobs.add(jobId, jobName, source);
    tree.reveal(job, { select: true, focus: false }).then(undefined, () => undefined);
    vscode.window.setStatusBarMessage(`$(rocket) ${jobName} ${jobId} submitted`, 5000);
    log.appendLine(`Job ${jobName} ${jobId} submitted from ${source}`);
  };

  // Spool como documento só de leitura: mfspool:/JOB12345/NOME.spool (um separador por job)
  const spoolProvider: vscode.TextDocumentContentProvider = {
    onDidChange: spoolChanged.event,
    async provideTextDocumentContent(uri) {
      const jobId = uri.path.split("/")[1];
      const jobName = path.basename(uri.path, ".spool");
      try {
        const { list, data } = await session.spoolWithList(jobId);
        const cfg = getConfig();
        const text = decode(data, cfg.transferEncoding).replace(/\r\n/g, "\n");
        const info = parseJobLine(list, jobId);
        const owner = list.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((t) => t[1] === jobId)?.[2];
        return formatSpool(
          { jobName: info?.jobName ?? jobName, jobId, owner, status: info?.status, result: info?.result, readAt: new Date() },
          sections(parseSpoolFiles(list), splitSpool(text)),
          cfg.spoolStripAsa
        );
      } catch (err) {
        return `Could not get the spool of ${jobId}:\n${errText(err)}\n\n` +
          "The job may already have been purged from JES. Use \"Refresh job status\" in the Jobs view to check.";
      }
    },
  };

  // Outline / breadcrumb e dobrar por DD
  const spoolSelector: vscode.DocumentSelector = { language: "mfspool" };
  const symbolProvider: vscode.DocumentSymbolProvider = {
    provideDocumentSymbols(doc) {
      const lines = doc.getText().split("\n");
      return documentSections(lines).map((s) => {
        const range = new vscode.Range(s.start, 0, s.end, lines[s.end]?.length ?? 0);
        return new vscode.DocumentSymbol(
          s.name,
          s.detail,
          s.id === "000" ? vscode.SymbolKind.Namespace : vscode.SymbolKind.File,
          range,
          new vscode.Range(s.start, 0, s.start, lines[s.start].length)
        );
      });
    },
  };
  const foldingProvider: vscode.FoldingRangeProvider = {
    provideFoldingRanges(doc) {
      return documentSections(doc.getText().split("\n"))
        .filter((s) => s.end > s.start)
        .map((s) => new vscode.FoldingRange(s.start, s.end, vscode.FoldingRangeKind.Region));
    },
  };

  context.subscriptions.push(
    log,
    session,
    jobs,
    tree,
    vscode.workspace.registerTextDocumentContentProvider(SPOOL_SCHEME, spoolProvider),
    vscode.languages.registerDocumentSymbolProvider(spoolSelector, symbolProvider, { label: "Spool" }),
    vscode.languages.registerFoldingRangeProvider(spoolSelector, foldingProvider),
    spoolChanged,
    session.onDidChangeState(() => jobs.refreshAll()),

    vscode.workspace.onDidSaveTextDocument((doc) =>
      onSave(doc).catch((err) => {
        log.appendLine(`Error while saving ${doc.uri.toString()} to the mainframe: ${errText(err)}`);
        vscode.window.showErrorMessage(`Mainframe FTPS: error saving to the mainframe: ${errText(err)}`, "Show log").then(
          (a) => a && log.show()
        );
      })
    ),

    cmd("mainframeFtps.connect", async () => {
      await session.ensureConnected();
      vscode.window.setStatusBarMessage("$(plug) Connected to the mainframe", 3000);
    }),
    cmd("mainframeFtps.disconnect", async () => session.disconnect()),
    cmd("mainframeFtps.selectServer", selectServer),
    cmd("mainframeFtps.forgetPin", async () => {
      await session.forgetPin();
      vscode.window.showInformationMessage("Stored PIN forgotten.");
    }),
    cmd("mainframeFtps.upload", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      let target = await targets.get(doc.uri);
      if (!target || target === IGNORE) {
        target = await askTarget(doc.uri);
      }
      await upload(doc, target);
    }),
    cmd("mainframeFtps.setTarget", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      const target = await askTarget(doc.uri);
      vscode.window.showInformationMessage(`Destination of ${path.basename(doc.fileName)}: ${target}`);
    }),
    cmd("mainframeFtps.clearTarget", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      await targets.set(doc.uri, undefined);
      vscode.window.showInformationMessage(`Destination removed from ${path.basename(doc.fileName)}.`);
    }),
    cmd("mainframeFtps.submit", async (uri?: vscode.Uri) => {
      const doc = await docFor(uri);
      if (doc.isDirty) {
        await doc.save(); // dispara também a gravação no mainframe
      }
      await checkServer(doc, "submit");
      const data = await prepareText(doc, "submit");
      const jobName = /^\/\/(\S+)\s+JOB\b/m.exec(doc.getText())?.[1]?.toUpperCase() ?? "";
      await submitJcl(data, jobName, path.basename(doc.fileName));
    }),
    cmd("mainframeFtps.jobStatus", async (job?: JobInfo) => {
      job = job ?? (await pickJob());
      if (!job) {
        return;
      }
      await jobs.refresh(job);
      const sev = severity(job);
      const msg = `${job.jobName} ${job.jobId}: ${job.status} ${job.result}`.trim();
      const show = sev === "error" ? vscode.window.showErrorMessage
        : sev === "warn" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      const action = await show(msg, ...(job.status === "OUTPUT" ? ["View spool"] : []));
      if (action) {
        await openSpool(job);
      }
    }),
    cmd("mainframeFtps.openSpool", async (job?: JobInfo, ddId?: string) => {
      job = job ?? (await pickJob());
      if (job) {
        await openSpool(job, ddId);
      }
    }),
    cmd("mainframeFtps.refreshJobs", async () => {
      await session.ensureConnected();
      for (const j of jobs.all()) {
        await jobs.refresh(j).catch(() => undefined);
      }
    }),
    cmd("mainframeFtps.clearJobs", async () => jobs.clear()),
    cmd("mainframeFtps.removeJob", async (job: JobInfo) => job && jobs.remove(job)),
    cmd("mainframeFtps.purgeJob", async (job: JobInfo) => {
      if (!job) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Delete ${job.jobName} ${job.jobId} from JES (purge the spool)?`, { modal: true }, "Purge"
      );
      if (ok) {
        await session.deleteJob(job.jobId);
        await jobs.remove(job);
      }
    }),
    cmd("mainframeFtps.listJobs", async () => {
      const filter = await vscode.window.showInputBox({
        title: "List jobs in JES",
        prompt: "Job name filter (e.g. USER*, * for all of yours)",
        value: "*",
        ignoreFocusOut: true,
      });
      if (filter === undefined) {
        return;
      }
      const raw = await session.jesList("", filter.toUpperCase() || "*");
      const list = parseJobList(raw);
      if (!list.length) {
        vscode.window.showInformationMessage("No jobs found.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((j) => ({
          label: `${j.jobName}  ${j.jobId}`,
          description: `${j.status} ${j.result ?? ""}`,
          job: j,
        })),
        { title: "Jobs in JES", placeHolder: "Choose a job to view its spool" }
      );
      if (pick) {
        const job: JobInfo = {
          jobId: pick.job.jobId, jobName: pick.job.jobName ?? "", status: pick.job.status ?? "?",
          result: pick.job.result ?? "", submitted: Date.now(),
        };
        await openSpool(job);
      }
    }),
    cmd("mainframeFtps.openMember", async () => openMember(context)),
    cmd("mainframeFtps.showLog", async () => log.show()),
    datasets,
    ...registerBrowse({ context, session, targets, datasets, log, submit: submitJcl, cmd }),
    ...registerJobView({ session, log, cmd }),
  );
}

export function deactivate() {
  session?.disconnect();
}

// ---------------------------------------------------------------- servidores

/** Lista de servidores (barra de estado e vista Mainframe). */
async function selectServer(): Promise<void> {
  const list = servers();
  type Item = vscode.QuickPickItem & { server?: string; action?: "disconnect" | "settings" };
  const current = session.server;
  const items: Item[] = list.map((s) => ({
    label: `${s.name === current ? "$(check)" : "$(server)"} ${s.name}`,
    description: s.name === s.host ? `port ${s.port}` : `${s.host}:${s.port}`,
    detail: s.name === current ? (session.isConnected ? "Connected" : "Next to connect") : undefined,
    server: s.name,
  }));
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  if (session.isConnected) {
    items.push({ label: "$(debug-disconnect) Disconnect", action: "disconnect" });
  }
  items.push({
    label: "$(gear) Edit server list…",
    description: "mainframeFtps.hosts",
    action: "settings",
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: "Mainframe server",
    placeHolder: list.length ? "Choose the server (closes the current session and asks for PIN + token)" : "No servers yet",
  });
  if (!pick) {
    return;
  }
  if (pick.action === "disconnect") {
    session.disconnect();
    return;
  }
  if (pick.action === "settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "mainframeFtps.hosts");
    return;
  }
  if (pick.server) {
    await session.switchServer(pick.server);
    vscode.window.setStatusBarMessage(`$(server) Connected to ${pick.server}`, 4000);
  }
}

/**
 * Se o ficheiro veio de outro servidor, pergunta se é para gravar/submeter no atual
 * ou mudar para o de origem. Devolve true se o utilizador escolheu o servidor atual
 * apesar de o ficheiro vir de outro (o ficheiro passa a pertencer ao atual).
 */
async function checkServer(doc: vscode.TextDocument, action: string): Promise<boolean> {
  const from = await targets.serverOf(doc.uri);
  const now = session.server;
  if (!from || !now || from === now || !servers().some((s) => s.name === from)) {
    return false;
  }
  const here = `${capitalize(action)} on ${now}`;
  const there = `Switch to ${from} and ${action}`;
  const a = await vscode.window.showWarningMessage(
    `${path.basename(doc.fileName)} came from ${from}, but you are using ${now}.`,
    { modal: true, detail: `Choose where to ${action}.` },
    there,
    here
  );
  if (a === there) {
    await session.switchServer(from);
    return false;
  }
  if (a === here) {
    return action === "save";
  }
  throw new CancelledError();
}

// --------------------------------------------------------------------- gravar

async function onSave(doc: vscode.TextDocument): Promise<void> {
  if (doc.uri.scheme === SPOOL_SCHEME || doc.uri.scheme === "untitled") {
    return;
  }
  log.appendLine(`Saved ${doc.uri.toString()}`);
  const cfg = getConfig();
  const name = path.basename(doc.fileName);
  if (!cfg.autoUploadOnSave) {
    log.appendLine(`Saved ${name}: not sent (autoUploadOnSave is off).`);
    return;
  }
  const ext = path.extname(doc.fileName).toLowerCase();
  let target = await targets.get(doc.uri);
  if (target === IGNORE) {
    log.appendLine(`Saved ${name}: not sent (marked "Never for this file").`);
    return;
  }
  if (target && (await targets.stored(doc.uri)) === undefined) {
    // Destino deduzido pela pasta local (mainframe/<PDS>/<MEMBRO>.<ext>): fica associado.
    await targets.set(doc.uri, target);
  }
  if (!target) {
    if (!cfg.fileExtensions.includes(ext)) {
      log.appendLine(
        `Saved ${doc.fileName}: no mainframe destination and the extension ${ext || "(none)"} is not in ` +
          "fileExtensions. Use \"Save file to mainframe\" to choose the destination."
      );
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Also save ${path.basename(doc.fileName)} to the mainframe?`,
      "Choose destination (PDS)…",
      "Never for this file"
    );
    if (choice === "Never for this file") {
      await targets.set(doc.uri, IGNORE);
      return;
    }
    if (!choice) {
      return;
    }
    try {
      target = await askTarget(doc.uri);
    } catch (err) {
      if (err instanceof CancelledError) {
        return;
      }
      throw err;
    }
  }
  try {
    await upload(doc, target);
  } catch (err) {
    if (err instanceof CancelledError) {
      vscode.window.setStatusBarMessage("Mainframe: save cancelled", 4000);
      return;
    }
    log.appendLine(`Error saving ${target}: ${errText(err)}`);
    const a = await vscode.window.showErrorMessage(`Error saving ${target}: ${errText(err)}`, "Try again", "Show log");
    if (a === "Try again") {
      await onSave(doc);
    } else if (a === "Show log") {
      log.show();
    }
  }
}

async function upload(doc: vscode.TextDocument, target: string): Promise<void> {
  if (await checkServer(doc, "save")) {
    await targets.set(doc.uri, target); // passa a pertencer ao servidor atual
  }
  if (getConfig().confirmUpload) {
    const server = activeServer()?.name ?? getConfig().host;
    const ok = await vscode.window.showWarningMessage(
      `Save ${path.basename(doc.fileName)} to the mainframe?`,
      {
        modal: true,
        detail: `${target}\non ${server}\n\nThe file is already saved on this PC. Cancel keeps it only here.\n(Setting: mainframeFtps.confirmUpload)`,
      },
      "Save to mainframe"
    );
    if (ok !== "Save to mainframe") {
      log.appendLine(`Not saved to ${target}: cancelled by the user.`);
      throw new CancelledError();
    }
  }
  const data = await prepareText(doc, "save");
  log.appendLine(`Saving ${path.basename(doc.fileName)} to ${target} (${data.length} bytes)`);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Saving ${target}…` },
    () => session.uploadText(target, data)
  );
  vscode.window.setStatusBarMessage(`$(cloud-upload) Saved to ${target}`, 4000);
  if (memberOf(target)) {
    datasets.refreshPds(pdsOf(target));
  }
}

/** Converte o texto do editor em registos para o mainframe, avisando de problemas. */
async function prepareText(doc: vscode.TextDocument, action: string): Promise<Buffer> {
  const cfg = getConfig();
  const tabSize = Number(vscode.workspace.getConfiguration("editor", doc.uri).get("tabSize", 4)) || 4;
  const lines = doc.getText().replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => expandTabs(l, tabSize));

  const long = lines.map((l, i) => ({ n: i + 1, len: l.length })).filter((x) => x.len > cfg.recordLength);
  if (long.length) {
    const sample = long.slice(0, 5).map((x) => `line ${x.n} (${x.len})`).join(", ");
    const ok = await vscode.window.showWarningMessage(
      `${long.length} line(s) longer than ${cfg.recordLength} columns: ${sample}. ` +
        "On the mainframe they may be truncated or split.",
      { modal: true },
      `${capitalize(action)} anyway`
    );
    if (!ok) {
      throw new CancelledError();
    }
  }

  const text = lines.join("\r\n") + "\r\n";
  const mangled = doubleEncoded(text);
  if (mangled.length) {
    const ok = await vscode.window.showWarningMessage(
      `The file looks badly decoded: it has ${mangled.map((x) => `"${x}"`).join(", ")}, ` +
        "which usually means a UTF-8 file opened as ISO 8859-1 (for example £ shown as Â£). Sending it would damage the data set.",
      {
        modal: true,
        detail: "Close the file and open it again from the Mainframe view, or use \"Reopen with Encoding\" → UTF-8 in the status bar.",
      },
      `${capitalize(action)} anyway`
    );
    if (!ok) {
      throw new CancelledError();
    }
  }
  const bad = unsupported(text, cfg.transferEncoding);
  if (bad.length) {
    const ok = await vscode.window.showWarningMessage(
      `The file has characters that do not exist in the mainframe code page (${cfg.hostCodePage || cfg.transferEncoding}): ${bad.join(" ")}. They will be sent as "?".`,
      { modal: true },
      `${capitalize(action)} anyway`
    );
    if (!ok) {
      throw new CancelledError();
    }
  }
  return encode(text, cfg.transferEncoding);
}

async function askTarget(uri: vscode.Uri): Promise<string> {
  const current = await targets.get(uri);
  const lastPds = current && current !== IGNORE ? pdsOf(current) : await targets.lastPds(uri);
  const pds = await vscode.window.showInputBox({
    title: `Mainframe destination – ${path.basename(uri.fsPath)} (1/2)`,
    prompt: "Library (PDS), e.g. USER.JCL.LIB",
    value: lastPds,
    ignoreFocusOut: true,
    validateInput: validateDsn,
  });
  if (!pds) {
    throw new CancelledError();
  }
  const currentMember = current && current !== IGNORE ? memberOf(current) : "";
  const member = await vscode.window.showInputBox({
    title: `Mainframe destination – ${path.basename(uri.fsPath)} (2/2)`,
    prompt: `Member in ${pds.toUpperCase()}`,
    value: currentMember || suggestMember(uri.fsPath),
    ignoreFocusOut: true,
    validateInput: validateMember,
  });
  if (!member) {
    throw new CancelledError();
  }
  const target = `${pds.trim().toUpperCase().replace(/^'|'$/g, "")}(${member.trim().toUpperCase()})`;
  await targets.set(uri, target);
  return target;
}

// ---------------------------------------------------------------- membros

async function openMember(_context: vscode.ExtensionContext): Promise<void> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const pds = await vscode.window.showInputBox({
    title: "Open mainframe member",
    prompt: "Library (PDS)",
    value: active ? await targets.lastPds(active) : "",
    ignoreFocusOut: true,
    validateInput: validateDsn,
  });
  if (!pds) {
    return;
  }
  const dsn = pds.trim().toUpperCase().replace(/^'|'$/g, "");
  const members = await session.listMembers(dsn);
  const member = await vscode.window.showQuickPick(members, {
    title: `${dsn} – ${members.length} members`,
    placeHolder: "Choose the member",
  });
  if (!member) {
    return;
  }
  const target = `${dsn}(${member})`;
  const ext = await vscode.window.showQuickPick([".jcl", ".ezt", ".cbl", ".cpy", ".txt"], {
    title: "Local file extension",
  });
  if (!ext) {
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const dest = await vscode.window.showSaveDialog({
    defaultUri: root ? vscode.Uri.joinPath(root, member + ext) : undefined,
    title: `Save ${target} as…`,
  });
  if (!dest) {
    return;
  }
  const buf = await session.downloadText(target);
  const text = decode(buf, getConfig().transferEncoding).replace(/\r\n/g, "\n");
  await vscode.workspace.fs.writeFile(dest, localBytes(text));
  await targets.set(dest, target);
  await vscode.window.showTextDocument(dest);
  vscode.window.setStatusBarMessage(`$(cloud-download) ${target} opened (associated with this file)`, 5000);
}

// ------------------------------------------------------------------ jobs

/**
 * Abre o spool num separador por job. Se já estiver aberto, volta a ler do JES
 * no mesmo separador. Com ddId, posiciona no início desse DD.
 */
async function openSpool(job: JobInfo, ddId?: string): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: SPOOL_SCHEME,
    path: `/${job.jobId}/${job.jobName || job.jobId}.spool`,
  });
  const existing = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  let doc: vscode.TextDocument;
  if (existing && !ddId) {
    // atualizar: espera pelo novo conteúdo
    const updated = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === uri.toString()) {
          sub.dispose();
          resolve();
        }
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 15000);
    });
    spoolChanged.fire(uri);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Reading the spool of ${job.jobId}…` },
      () => updated
    );
    doc = existing;
  } else {
    doc = existing ?? (await vscode.workspace.openTextDocument(uri));
  }
  if (doc.languageId !== "mfspool") {
    doc = await vscode.languages.setTextDocumentLanguage(doc, "mfspool");
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (ddId) {
    const lines = doc.getText().split("\n");
    const sec = documentSections(lines).find((s) => s.id === ddId);
    if (sec) {
      const pos = new vscode.Position(sec.start, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
    }
  }
}

async function pickJob(): Promise<JobInfo | undefined> {
  const items: Array<vscode.QuickPickItem & { job?: JobInfo }> = jobs.all().map((j) => ({
    label: `${j.jobName}  ${j.jobId}`,
    description: `${j.status} ${j.result}`,
    detail: j.source,
    job: j,
  }));
  items.push({ label: "$(search) Other JOBID…" });
  const pick = await vscode.window.showQuickPick(items, { title: "Choose the job" });
  if (!pick) {
    return undefined;
  }
  if (pick.job) {
    return pick.job;
  }
  const id = await vscode.window.showInputBox({
    prompt: "JOBID (e.g. JOB12345)",
    validateInput: (v) => (/^(J(OB)?|T(SU)?|S(TC)?)\d{5,7}$/i.test(v.trim()) ? undefined : "Invalid JOBID"),
  });
  if (!id) {
    return undefined;
  }
  const jobId = id.trim().toUpperCase();
  const parsed = parseJobLine(await session.jesList(jobId), jobId);
  return { jobId, jobName: parsed?.jobName ?? "", status: parsed?.status ?? "?", result: parsed?.result ?? "", submitted: Date.now() };
}

// ------------------------------------------------------------- utilitários

function cmd(id: string, fn: (...args: any[]) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof CancelledError) {
        return;
      }
      log.appendLine(`Error in ${id}: ${errText(err)}`);
      const a = await vscode.window.showErrorMessage(`Mainframe FTPS: ${errText(err)}`, "Show log");
      if (a) {
        log.show();
      }
    }
  });
}

async function docFor(uri?: vscode.Uri): Promise<vscode.TextDocument> {
  if (uri instanceof vscode.Uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    throw new Error("Open a file in the editor first.");
  }
  return doc;
}

function expandTabs(line: string, size: number): string {
  if (!line.includes("\t")) {
    return line;
  }
  let out = "";
  for (const ch of line) {
    if (ch === "\t") {
      out += " ".repeat(size - (out.length % size));
    } else {
      out += ch;
    }
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
