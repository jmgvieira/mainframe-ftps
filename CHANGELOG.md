# Changelog

## 0.3.1
- Login num só campo: PIN fixo e token escritos seguidos, com um único Enter.
- Vista Jobs mais simples: clicar num job abre o spool (usa a sessão já aberta); o único botão na linha é "Atualizar estado". "Ver spool" fica no menu do botão direito.
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
