# Mainframe FTPS (z/OS) – VS Code extension

Write your JCL/Easytrieve in VS Code. When you save, the file is written to the mainframe PDS.
Then submit the job and follow its status without leaving the editor.

> The extension's menus and messages are in Portuguese. Below, each command is shown with its
> name as it appears in VS Code, followed by its meaning in English.

## Install

1. In VS Code, open **Extensions**, search for **Mainframe FTPS** (publisher JorgeMiguel) and install it.
   Alternatively, download the `.vsix` from https://github.com/jmgvieira/mainframe-ftps/releases and use **Install from VSIX…**.
2. **File → Preferences → Settings** → search for `mainframeFtps` and fill in at least:
   - `Hosts`: the z/OS FTP servers, separated by `;` (see [Servers](#servers))
   - `Port`: `990` (already the default)
   - `Tls Mode`: `explicit` (if the login hangs until it times out, try `implicit`)
   - `User`: your TSO user ID (optional; asked for when empty)

Example `settings.json`:

```json
"mainframeFtps.hosts": "PROD=mvs1.company.com;TEST=mvs2.company.com:991",
"mainframeFtps.port": 990,
"mainframeFtps.tlsMode": "explicit",
"mainframeFtps.user": "U12345",
"mainframeFtps.siteCommands": []
```

## Servers

- List every server in `mainframeFtps.hosts`, separated by `;`. Each entry is `NAME=host:port`:
  - `PROD=mvs1.company.com` – name `PROD`, default port;
  - `TEST=mvs2.company.com:991` – name `TEST`, port 991;
  - `mvs3.company.com` – no name: the host itself is shown.
- To switch server, click the **MF** indicator in the status bar (bottom left) or the server button
  at the top of the **Mainframe** view. A list with your servers appears; pick one and the extension
  closes the current session and connects to the new one, asking for PIN + token.
  The same list has **Desligar** (disconnect) and **Editar lista de servidores…** (edit the server list).
- The command **Mainframe: Escolher servidor** (choose server) opens the same list.
- The user ID, PIN, TLS mode and code page are the same for every server.
- The old `mainframeFtps.host` setting still works: if filled in, it appears as the first server of the list.
- Each file remembers the server it came from. If you save or submit it while connected to another
  server, the extension asks first whether to use the current server or switch to the original one.
  This prevents, for example, saving a member from the test system into production.
- The **Jobs** view shows the jobs of the current server.

## How the login works

- When connecting (or on the first save), you are asked for your **fixed PIN** and the **current token**,
  typed together in a single field. The password sent is `PIN + token` (or `token + PIN`: `mainframeFtps.passcodeOrder`).
- **A single session** stays open. Every operation goes through it, one at a time.
- Every 60 s (`keepAliveSeconds`) a `NOOP` is sent, so the session is not closed by the ~4 min idle timeout.
- If the connection drops, the token is only asked for again on the next operation. The token is never stored.
  The PIN is only stored if you enable `rememberPin`, and then it goes to the Windows credential store.
- If a login is rejected (530), the stored PIN is deleted and the login is not retried automatically,
  to avoid the user ID being revoked by RACF.

## Authentication indicator

- In the status bar (bottom left):
  - **green** `✔ MF PROD`: authenticated on server PROD;
  - **grey** `○ MF PROD`: not authenticated (PROD is the server used on the next connection);
  - `⟳ MF PROD a ligar…`: authenticating.
- Hovering shows the server, since when you are connected and the time of the last keepalive.
- With a single server, a click connects or disconnects. With several servers, a click opens the server list.
- The top of the **Data sets** view shows the same state (`● U12345@PROD` or `○ desligado`).

## Browsing data sets

- The **Mainframe** icon in the activity bar (left) opens the **Data sets** and **Jobs** views.
- **Add a filter**, for example `U12345.*`, to list data sets as in ISPF 3.4.
  - A PDS expands to show its members.
  - Clicking a member or a sequential data set opens it in the editor. `Ctrl+S` saves it back to the mainframe.
- Files opened from the view keep the mainframe names: `mainframe/<PDS>/<MEMBER>` and `mainframe/<DSN>`,
  inside the folder open in VS Code (or in the extension storage when no folder is open).
  The folder can be changed in `localFolder`.
- The language (JCL, Easytrieve, COBOL) comes from the data set qualifiers
  (JCL/CNTL/PROC → JCL, EZT → Easytrieve, …). Configure it with `qualifierExtensions`;
  names that do not indicate a language use `defaultExtension` (JCL by default).
- Right-click menu:
  - **Novo membro** – new member;
  - **Novo data set** – new data set (PDSE, PDS or sequential; RECFM, LRECL and space);
  - **Novo data set igual a este** – new data set like this one;
  - **Renomear** – rename;
  - **Apagar** – delete, always with confirmation;
  - **Submeter** – submit;
  - **Copiar nome** – copy name.
- Migrated data sets (HSM) show a cloud icon. Opening one starts the recall.
- Names with national characters (`#`, `@`) are shown correctly, even with code page IBM-1147.

## Saving to the mainframe

- Files opened from the **Mainframe** view already know their destination: every `Ctrl+S` writes them to the mainframe.
- For other files, on the **first save** of a `.jcl`, `.ezt`, `.cbl`, `.cpy` or `.proc`, the extension asks
  for the destination: library (e.g. `U12345.JCL.LIB`) and member (it suggests the file name).
  You can also answer "Nunca para este ficheiro" (never for this file).
- The association is kept in `.vscode/mainframe-ftps.json`. From then on, every `Ctrl+S` also writes to the PDS.
- **Mainframe: Alterar destino (PDS/membro) do ficheiro** changes the destination.
- **Mainframe: Gravar ficheiro no mainframe** saves any file to the mainframe on demand.
- **Mainframe: Abrir membro do mainframe…** lists the members of a PDS, downloads one and associates it.
- Before sending, the extension:
  - converts tabs into spaces;
  - warns about lines longer than 80 columns (`recordLength`);
  - warns about characters that do not exist in the code page.

## Submitting and following jobs

- **Mainframe: Submeter JCL** (`Ctrl+Alt+J`, or the 🚀 icon at the top of a JCL file) sends the JCL to JES
  and shows the JOBID.
- The **Jobs** view shows the submitted jobs. The status is refreshed automatically
  (every 5 s, up to 10 min) and a notification appears when the job ends, with the RC or the ABEND.
- Click a job to see the **full spool** in a read-only tab, with a step summary and one section per DD.
  The context menu lets you refresh the status and purge the job.
- **Mainframe: Listar jobs no JES** lists your jobs by name filter.

## Mainframe requirements

- The z/OS FTP server must have **`JESINTERFACELEVEL 2`** to list jobs and read the spool.
  To check, in an FTP client: `quote STAT` (or `rstat`).
- **Code page:** by default the extension sends `SITE SBDATACONN=(IBM-1147,ISO8859-15)`
  right after login. IBM-1147 is EBCDIC France with €, and ISO-8859-15 is Latin-9 on the PC side,
  which also has €. This way `ç ã é €` are converted correctly both ways.
  The settings are `hostCodePage` and `transferEncoding`.
- **Watch out for national characters (`# @ $`) in the French code page.** In IBM-1147, the
  positions z/OS uses for national characters are shown as `£ à $`
  (x'7B' = `£`, x'7C' = `à`, x'5B' = `$`).
  If in your 3270 emulator you type `£` or `à` where "normal" JCL has `#` or `@`, do the same in VS Code.
  If you type `#` or `@`, the conversion produces a different byte, and the JCL or the data set name no longer match.
- Certificate: if your company's internal CA is installed in Windows, nothing needs to change.
  Otherwise, disable `rejectUnauthorizedCertificates`.

## Troubleshooting

**Mainframe: Mostrar log** (show log) opens the output channel with the FTP commands and replies,
each file opened and saved, and the reason when a saved file is not sent to the mainframe.
The password never appears in the log.

## Building from source

```
npm install
npm run package
```

For developers of the extension: see the [developer guide](docs/GUIA-DO-DEVELOPER.md) (in Portuguese:
code structure, build, debugging and publishing).
