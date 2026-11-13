# Changelog

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
