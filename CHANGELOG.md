# Changelog

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
