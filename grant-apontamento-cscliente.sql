-- Rode no ERP como AGRICOLA ou DBA.
-- O app grava só nestas tabelas (não usa tmp_osmateriallote).

GRANT SELECT, INSERT, UPDATE ON agricola.tmp_osapontamento TO CSCLIENTE;
GRANT SELECT, INSERT, UPDATE ON agricola.tmp_ositemapont TO CSCLIENTE;
GRANT SELECT, INSERT, UPDATE ON agricola.tmp_osmaterial TO CSCLIENTE;
