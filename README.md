# Mainframe FTPS (z/OS) – extensão VS Code

Escreve o JCL/Easytrieve no VS Code. Ao guardar, o ficheiro é gravado no PDS do mainframe.
Depois submetes o job e acompanhas o estado, sem sair do editor.

## Instalar

1. No VS Code, em **Extensions**, procurar **Mainframe FTPS** (publisher JorgeMiguel) e instalar.
   Em alternativa, descarregar o `.vsix` em https://github.com/jmgvieira/mainframe-ftps/releases e usar **Install from VSIX…**.
2. **File → Preferences → Settings** → procurar `mainframeFtps` e preencher pelo menos:
   - `Host`: endereço do servidor FTP do z/OS
   - `Port`: `990` (já é o valor por omissão)
   - `Tls Mode`: `explicit` (se o login ficar parado até dar timeout, experimente `implicit`)
   - `User`: o seu utilizador TSO (opcional; se vazio é pedido)

Exemplo de `settings.json`:

```json
"mainframeFtps.host": "mvs.empresa.pt",
"mainframeFtps.port": 990,
"mainframeFtps.tlsMode": "explicit",
"mainframeFtps.user": "U12345",
"mainframeFtps.siteCommands": []
```

## Como funciona o login

- Ao ligar (ou na primeira gravação), são pedidos o **PIN fixo** e o **token atual**.
  A password enviada é `PIN + token` (ou `token + PIN`: `mainframeFtps.passcodeOrder`).
- Fica **uma única sessão** aberta. Todas as operações passam por ela, uma de cada vez.
- A cada 60 s (`keepAliveSeconds`) é enviado um `NOOP`, para a sessão não cair pelo timeout de ~4 min.
- Se a ligação cair, o token só é pedido de novo na operação seguinte. O token nunca é guardado.
  O PIN só fica guardado se ativar `rememberPin`, e nesse caso vai para o cofre de credenciais do Windows.
- A barra de estado (em baixo à esquerda) mostra `MF: ligado` ou `MF: desligado`. Clique para ligar ou desligar.
- Se houver um login recusado (530), o PIN guardado é apagado e a ligação não é repetida automaticamente,
  para evitar revogar o utilizador no RACF.

## Indicador de autenticação

- Na barra de estado (canto inferior esquerdo):
  - **verde** `✔ MF U12345`: autenticado;
  - **cinzento** `○ MF`: não autenticado;
  - `⟳ MF a ligar…`: a autenticar.
- Ao passar o rato aparece desde quando está ligado e a hora do último keepalive. Um clique liga ou desliga.
- O topo da vista **Data sets** mostra o mesmo estado (`● U12345@host` ou `○ desligado`).

## Navegar nos data sets

- O ícone **Mainframe** na barra de atividades (à esquerda) abre a vista **Data sets** e a vista **Jobs**.
- **Adicionar filtro**, por exemplo `U12345.*`, lista os data sets como no ISPF 3.4.
  - Um PDS expande-se e mostra os membros.
  - Um clique num membro ou num sequencial abre-o no editor, já associado. O `Ctrl+S` grava de volta no mainframe.
- Os ficheiros abertos a partir da vista ficam em `mainframe/<PDS>/<MEMBRO>.<ext>`, dentro da pasta aberta no VS Code.
  A pasta pode ser mudada em `localFolder`. A extensão do ficheiro vem do último qualificador do data set
  (JCL/CNTL/PROC → `.jcl`, EZT → `.ezt`, …), e pode ser configurada em `qualifierExtensions`.
- Botão direito:
  - **Novo membro**;
  - **Novo data set** (PDSE, PDS ou sequencial; RECFM, LRECL e espaço);
  - **Novo data set igual a este**;
  - **Renomear**;
  - **Apagar**, sempre com confirmação;
  - **Submeter**;
  - **Copiar nome**.
- Data sets migrados (HSM) aparecem com uma nuvem. Ao abri-los é feito o recall.
- Nomes com caracteres nacionais (`#`, `@`) aparecem corretamente, mesmo com o código de página IBM-1147.

## Gravar no mainframe

- Na **primeira gravação** de um `.jcl`, `.ezt`, `.cbl`, `.cpy` ou `.proc`, a extensão pergunta o
  destino: biblioteca (ex.: `U12345.JCL.LIB`) e membro (sugere o nome do ficheiro).
  Também pode responder "Nunca para este ficheiro".
- A associação fica em `.vscode/mainframe-ftps.json`. A partir daí, cada `Ctrl+S` grava também no PDS.
- **Mainframe: Alterar destino (PDS/membro) do ficheiro** muda a associação.
- **Mainframe: Abrir membro do mainframe…** lista os membros de um PDS, descarrega um deles e
  já o deixa associado.
- Antes de enviar, a extensão:
  - converte tabs em espaços;
  - avisa se houver linhas com mais de 80 colunas (`recordLength`);
  - avisa se houver caracteres que não existem no código de página.

## Submeter e acompanhar jobs

- **Mainframe: Submeter JCL** (`Ctrl+Alt+J`, ou o ícone 🚀 no topo de um `.jcl`) envia o JCL ao JES
  e mostra o JOBID.
- A vista **Jobs mainframe** no Explorer mostra os jobs submetidos. O estado é atualizado sozinho
  (a cada 5 s, até 10 min) e chega uma notificação quando o job termina, com o RC ou o ABEND.
- Clique num job para ver o **spool completo** num separador só de leitura.
  O menu de contexto permite ver o estado e fazer purge do job.
- **Mainframe: Listar jobs no JES** lista os seus jobs por filtro de nome.

## Requisitos do lado do mainframe

- O servidor FTP do z/OS tem de ter **`JESINTERFACELEVEL 2`** para listar os jobs e ler o spool.
  Para confirmar, no cliente FTP: `quote STAT` (ou `rstat`).
- **Código de página:** por omissão a extensão envia `SITE SBDATACONN=(IBM-1147,ISO8859-15)`
  logo após o login. IBM-1147 é o EBCDIC França com €, e ISO-8859-15 é o Latin-9 do lado do PC,
  que também tem o €. Assim, `ç ã é €` passam corretamente nos dois sentidos.
  As definições são `hostCodePage` e `transferEncoding`.
- **Atenção aos caracteres nacionais (`# @ $`) no código de página francês.** No IBM-1147, as
  posições que o z/OS usa para os caracteres nacionais aparecem como `£ à $`
  (x'7B' = `£`, x'7C' = `à`, x'5B' = `$`).
  Se no Reflection escreve `£` ou `à` onde o JCL "normal" tem `#` ou `@`, faça o mesmo no VS Code.
  Se escrever `#` ou `@`, a conversão gera outro byte, e o JCL ou o nome do data set deixam de bater certo.
- Certificado: se a CA interna da empresa estiver instalada no Windows, não é preciso mexer em nada.
  Caso contrário, é necessário desligar `rejectUnauthorizedCertificates`.

## Diagnóstico

**Mainframe: Mostrar log** abre o canal de saída, com os comandos FTP e as respostas.
A password nunca aparece no log.

## Compilar a partir do código

```
npm install
npm run package
```

Para quem vai desenvolver a extensão: ver o [Guia do developer](docs/GUIA-DO-DEVELOPER.md)
(estrutura do código, compilação, depuração e publicação).
