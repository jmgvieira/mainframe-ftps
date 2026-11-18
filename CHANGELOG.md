# Changelog

## 0.3.3
- Corrigido: um data set aberto a partir da vista Mainframe podia não ser gravado no mainframe ao guardar (sobretudo com a extensão `.txt`), sem qualquer aviso. Os ficheiros na pasta local (`mainframe/<PDS>/<MEMBRO>.<ext>` ou `mainframe/<DSN>.<ext>`) passam a ser sempre reconhecidos pelo caminho.
- No Windows, a associação ficheiro → data set deixa de depender de maiúsculas/minúsculas no caminho.
- `localFolder` aceita um caminho relativo à pasta do workspace.
- O log (Mainframe: Mostrar log) regista cada abertura e gravação, e o motivo quando um ficheiro guardado não é enviado.

## 0.3.2
- Sem alterações de funcionalidade: o pacote deixa de incluir um identificador interno que aparecia num comentário do código.

## 0.3.1
- Login num só campo: PIN fixo e token escritos seguidos, com um único Enter.
- Spool ao estilo do SDSF:
  - um separador por job; clicar outra vez volta a ler do JES no mesmo separador;
  - resumo no topo com o RC (ou ABEND / FLUSH) de cada step e a lista de DD;
  - cada DD com cabeçalho próprio, no Outline e no breadcrumb, e pode ser dobrado;
  - cores para RC, ABEND, erros de JCL, mensagens IEF/IEC e instruções JCL;
  - remove o carácter de controlo de impressão (ASA) da coluna 1 (`spoolStripAsa`).
- Vista Jobs mais simples: clicar num job abre o spool (usa a sessão já aberta); a seta dos jobs terminados mostra os DD, e clicar num DD abre o spool nesse ponto. O único botão na linha é "Atualizar estado".
- A mensagem de boas-vindas da vista Jobs só mostra "Ligar" quando não há sessão.
- Mensagem de erro do spool mais clara.
- Corrigido "550 Jobid not found" no estado e no spool de jobs cujo nome não começa pelo userid: o filtro `JESJOBNAME` passa a `*` quando se acede a um job pelo JOBID.

## 0.3.0
- Nova vista **Mainframe** na barra de atividades, com filtros de data sets (como no ISPF 3.4), PDS e membros.
- Abrir membros e sequenciais com um clique, já associados para gravação automática.
- Criar membros e data sets (PDSE, PDS, PS; também "igual a este"), renomear, apagar, submeter e copiar o nome.
- Indicador de autenticação na barra de estado (verde = ligado, cinzento = desligado), com o último keepalive.
- Deteção de ligação fechada pelo servidor.

## 0.2.1
- Publicação no VS Code Marketplace (publisher JorgeMiguel).

## 0.2.0
- Código de página do mainframe configurável (`hostCodePage`, por omissão IBM-1147 – França com €).
- Transferência em ISO-8859-15 (Latin-9) com suporte a €.
- Aviso de caracteres sem equivalente no código de página.

## 0.1.0
- Sessão FTPS única e persistente, com keepalive (NOOP) e login por PIN + token.
- Gravação automática no PDS ao guardar; destino definido na primeira gravação.
- Submissão de JCL, acompanhamento do estado e visualização do spool.
- Abrir membros de um PDS.
