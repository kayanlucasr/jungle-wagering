# Inventário de limpeza — nenhuma exclusão realizada

KEEP = necessário à entrega; IGNORE = local/gerado, mantido fora do Git; REMOVE =
candidato descartável após aprovação explícita. REMOVE não significa arquivo removido.
O inventário por arquivo de log, com tamanho, origem, uso e rastreio, está em
[cleanup-inventory.csv](cleanup-inventory.csv). Foi atualizado após a validação.

| Caminho/grupo | Origem e uso real | Reproduzível? | Git | Classificação / justificativa |
|---|---|---|---|---|
| .cache-stage3-* até .cache-stage8-*.log | Capturas de stdout/stderr de build, Bun test e Docker; runtime coletado pelo runner | A execução sim, o histórico bruto exato não | Ignorado por *.log | REMOVE após autorização; não são inputs da aplicação/testes |
| .cache-commit-unit.log, .cache-git-unit.log | Testes de verificações anteriores de Git | Execução sim | Ignorados | REMOVE após autorização; histórico local, sem uso de runtime |
| .cache/stage-8/compose.delivery.yml | Override gerado para testar a imagem final sem portas/volume principal | Versão reproduzível em compose-delivery.override.yml | Ignorado por .cache/ | REMOVE após autorização; preservar a versão documental |
| docs/stage-8/*-runtime.log | Logs brutos de containers desta auditoria | Execução sim | Ignorados por *.log | REMOVE após autorização; evidências selecionadas estão nos JSONs |
| dist/ | Saída de TypeScript | bun run build | Ignorado | IGNORE; start:prod e testes compilados usam esse diretório |
| node_modules/ | Instalação local do lockfile | bun install --frozen-lockfile; instalação limpa verificada em Docker | Ignorado | IGNORE; necessário aos comandos locais, não empacotar |
| .tools/ | Bun portátil e ferramentas/arquivos usados no preparo local | Requer provisão das ferramentas; não realizada na auditoria | Ignorado | IGNORE; o Bun portátil ainda é usado nesta máquina, não excluir indiscriminadamente |
| .env | Configuração da instalação local | Exemplo reproduzível, ajustes locais não necessariamente | Ignorado | IGNORE; preservar, não enviar e não sobrescrever |
| .env.example | Placeholders/defaults locais documentados | Fonte | Rastreado | KEEP; necessário ao checkout limpo |
| bun.lock, package.json, Dockerfile, Composes | Dependências, build e execução | Fonte | Rastreado | KEEP; nenhuma atualização/remoção automática |
| Migrations oficiais e SQLs de revisão em docs/stage-3 e stage-6 | Schema e histórico de aprovação | Fonte | Rastreado | KEEP; não são dumps temporários |
| test/, fixtures e support/ | Regressões reais e unitários | Fonte | Rastreado | KEEP; não confundir harness descartável com arquivo desnecessário |
| docs/stage-7 e docs/stage-8, VALIDATION e FINAL_REVIEW | Evidências selecionadas e relatório de avaliação | Histórico preservado; novas execuções podem ter números diferentes | Rastreado ou preparado para revisão | KEEP; não remover como cache |

Não foram encontrados diretórios .cache-stage?-*, dumps .dump/.backup ou ZIPs de
entrega na árvore de fonte. Os .sql encontrados fora de dependências são propostas
de migrations revisadas. .tools contém distribuição/archive de ferramenta local,
não dump financeiro. Não foi feita deduplicação estética de documentos ou testes.

O .gitignore já cobre *.log, .cache/, dist/, node_modules/, .tools/, .env e .env.*,
preservando .env.example. git check-ignore confirmou as regras; nenhum log/build/
dependência local está versionado. Não foi necessário mudar o arquivo. .dockerignore
também exclui esses artefatos do contexto de build. Os relatórios JSON/TXT/CSV/YML
selecionados desta auditoria são materiais de revisão, não candidatos à exclusão.

Nenhum git clean, reset --hard, remoção de arquivo, down -v ou descarte de volume
principal foi executado. Os próprios containers/redes dos projetos descartáveis
foram encerrados pelos runners, conforme o escopo da validação. Imagens de teste
podem permanecer no cache Docker; não foram removidas automaticamente.
