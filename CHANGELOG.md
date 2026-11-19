# Changelog

## 0.6.6
- **In this job** no longer looks data sets up in the catalog: the **Check data sets** button is gone. On the company server some catalog listings made the session drop.
- Clicking a data set opens it directly. If it is a library, a list of its members appears to choose one (and the library can then be expanded in the view). This check uses only the control connection (`CWD`), not a listing.
- Members of load libraries (`…LOAD…`, `LINKLIB`) are not opened as text.

## 0.6.5
- **Check data sets** looks each data set up with a wildcard (`NAME*`), like the Data sets view, instead of the exact name. Listing the exact name of some data sets made the server reset the connection and closed the session.

## 0.6.4
- The **Data sets** view shows a green dot (🟢) before the user and server when connected.

## 0.6.3
- **In this job** no longer checks the catalog by itself. Some listings make the server reset the data connection, and that closes the whole session (a new token is needed). Use the new **Check data sets** button (✓✓) at the top of the view to see which data sets exist; the listings are spaced out. Clicking a data set still checks just that one.
- **Refresh** only reads the JCL again.

## 0.6.2
- A failure in the data connection only (for example `ECONNRESET (data socket)` while listing) no longer drops the whole session: the extension checks the session with `NOOP` and retries the operation once.
- The checks made by **In this job** never ask to reconnect. If one data set cannot be checked, the others are still checked; it is tried again on **Refresh**.

## 0.6.1
- **In this job** is cleared as soon as the JCL tab is closed (it used to wait until VS Code released the file, which could take minutes).
- **Refresh** in **In this job** no longer asks for PIN + token: without a connection it only reads the JCL again. Connect to check which data sets exist.

## 0.6.0
- New **In this job** view, at the top of the **Mainframe** side bar: the data sets used by the JCL open in the editor, grouped by step, one click away.
  - Each line shows the data set name, the DD name and the DISP (`SHR`, `OLD`, `NEW`, `MOD`). Concatenated DDs are marked with `+`.
  - Click a member (`LIB(MEMBER)`) or a sequential data set to open it in the editor. A library expands to show its members.
  - The tooltip shows DSORG, RECFM, LRECL and BLKSIZE. Data sets that do not exist yet (for example, outputs of a job that has not run) appear greyed out as **not found**; they are checked again when a job ends, on **Refresh**, or when you click them.
  - `JCLLIB` and `JOBLIB` appear in a **JOB** group. Symbols defined with `SET` (or as defaults of an in-stream `PROC`) are resolved; other symbols are marked **symbol not resolved**.
  - Temporary data sets (`&&TEMP`), `SYSOUT`, `DUMMY`, `NULLFILE`, back references (`*.STEP.DD`) and in-stream data are left out.
  - Relative GDG generations: `(0)` and `(-1)` open that generation; `(+1)` is shown as **new generation**.
  - Members of load libraries (RECFM U) are listed but not opened.
  - Clicking a step goes to its line in the JCL; right-click a data set for **Go to line in JCL** and **Copy name**.
  - The view follows the active JCL. Opening another file from it (for example the Easytrieve in `SYSIN`) keeps the list of the JCL.

## 0.5.0
- The whole interface is in English: commands, buttons, menus, tooltips, questions, messages, the spool summary and the log.
- The old `mainframeFtps.host` setting is replaced by `mainframeFtps.hosts`. Its value is moved there automatically when the extension starts, and it no longer appears in the settings.
- Local folder:
  - **Mainframe: Choose local folder…** picks it in the folder dialog and saves it in `mainframeFtps.localFolder`;
  - **Mainframe: Open local folder in file explorer** opens it in Windows Explorer (both also in the **…** menu of the Data sets view);
  - with no folder open in VS Code and no local folder set, you are asked once where to keep the files, instead of using a hidden VS Code folder;
  - the current folder is shown in the tooltip of the **MF** indicator;
  - the file associations are kept in `.mainframe-ftps.json` inside the local folder (older associations are still read).

## 0.4.0
- Several servers: list them in the new `mainframeFtps.hosts` setting, separated by `;` (`PROD=mvs1.company.com;TEST=mvs2.company.com:991`). Name and port are optional.
- Switch server by clicking the **MF** indicator in the status bar or the server button in the **Mainframe** view (also **Mainframe: Choose server**). The current session is closed and the new one asks for PIN + token.
- The status bar and the Data sets view show the server name.
- Each file remembers the server it came from. Saving or submitting it while connected to another server asks first: use the current server or switch to the original one.
- The Jobs view shows only the jobs of the current server; clearing the list keeps the jobs of the other servers.
- The old `mainframeFtps.host` setting still works and appears as the first server of the list.
- The submit button (🚀) also appears for JCL members opened from the Mainframe view, which no longer have a `.jcl` extension.
- README, CHANGELOG and settings descriptions in English.

## 0.3.5
- Saving to the mainframe no longer ignores files opened outside the local disk (for example, folders opened through WSL, SSH or another remote mode).
- The log shows the extension version at start-up, every saved file and any error while saving, which is also shown in a message.

## 0.3.4
- Local files have the same name as on the mainframe, without `.txt` or any other extension: `mainframe/<PDS>/<MEMBER>` and `mainframe/<DSN>`. The language (JCL, Easytrieve, COBOL) is chosen from the qualifiers; when the name does not indicate it, `defaultExtension` is used (`.jcl` by default).
- Files downloaded with an extension by earlier versions are still saved to the right data set.

## 0.3.3
- Fixed: a data set opened from the Mainframe view could fail to be saved to the mainframe, without any warning (mostly with the `.txt` extension). Files in the local folder (`mainframe/<PDS>/<MEMBER>.<ext>` or `mainframe/<DSN>.<ext>`) are now always recognised by their path.
- On Windows, the file → data set association no longer depends on upper/lower case in the path.
- `localFolder` accepts a path relative to the workspace folder.
- The log (Mainframe: Show log) records every file opened and saved, and the reason when a saved file is not sent.

## 0.3.2
- No functional changes: the package no longer includes an internal identifier that appeared in a code comment.

## 0.3.1
- Login in a single field: fixed PIN and token typed together, with a single Enter.
- SDSF-style spool:
  - one tab per job; clicking again reloads from JES in the same tab;
  - summary at the top with the RC (or ABEND / FLUSH) of each step and the list of DDs;
  - each DD with its own header, in the Outline and the breadcrumb, and foldable;
  - colours for RC, ABEND, JCL errors, IEF/IEC messages and JCL statements;
  - removes the print control character (ASA) from column 1 (`spoolStripAsa`).
- Simpler Jobs view: clicking a job opens the spool (using the open session); the arrow of finished jobs shows the DDs, and clicking a DD opens the spool at that point. The only button on the line is "Refresh job status".
- The Jobs view welcome message only shows "Connect" when there is no session.
- Clearer spool error message.
- Fixed "550 Jobid not found" in the status and spool of jobs whose name does not start with the user ID: the `JESJOBNAME` filter becomes `*` when a job is accessed by JOBID.

## 0.3.0
- New **Mainframe** view in the activity bar, with data set filters (as in ISPF 3.4), PDS and members.
- Open members and sequential data sets with one click, already associated for automatic saving.
- Create members and data sets (PDSE, PDS, PS; also "like this one"), rename, delete, submit and copy the name.
- Authentication indicator in the status bar (green = connected, grey = disconnected), with the last keepalive.
- Detection of connections closed by the server.

## 0.2.1
- Published on the VS Code Marketplace (publisher JorgeMiguel).

## 0.2.0
- Configurable mainframe code page (`hostCodePage`, IBM-1147 – France with € by default).
- Transfer in ISO-8859-15 (Latin-9) with € support.
- Warning about characters without an equivalent in the code page.

## 0.1.0
- Single persistent FTPS session, with keepalive (NOOP) and PIN + token login.
- Automatic save to the PDS; destination chosen on the first save.
- JCL submission, status tracking and spool viewing.
- Open members of a PDS.
